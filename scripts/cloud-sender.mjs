// Offline integration layer. No live transport, credentials or scheduler.
import {DatabaseSync} from 'node:sqlite';
import {digest,REPOSITORY} from './archive.mjs';
import {encodeBundle,decodeBundle,acceptMessage,requireThat,REQUEST,SHA,verifyReportPublication} from './report-handoff.mjs';
import {encodeNoticeCommand,verifyNoticeGrant} from './notice-command.mjs';
import {acceptNoticeCommand} from './notice-outbox.mjs';
import {createNoticeManifest} from './notice-manifest.mjs';

// Refresh cached reads, never expire the durable reservation or create a new attempt.
export const PREFLIGHT_REFRESH_MS=60000;
const TS=/^\d{10}\.\d{6}$(?![\s\S])/;
const FILE=/^F[A-Z0-9]+$(?![\s\S])/;
const HASH=/^[a-f0-9]{64}$(?![\s\S])/;
const matches=(re,v)=>typeof v==='string'&&re.test(v)&&!/[\r\n]/.test(v);
const exact=(v,keys)=>requireThat(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.slice().sort().join(),'Unexpected cloud fields');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const json=v=>JSON.stringify(v);
const hash=v=>digest(json(canonical(v)));
function deliveryInstant(value){
 const pattern=/^(\d{4}-\d\d-\d\d)T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
 requireThat(matches(pattern,value),'Delivery deadline requires an explicit ISO timezone');
 const date=value.slice(0,10),calendar=Date.parse(date+'T00:00:00.000Z'),instant=Date.parse(value);
 requireThat(Number.isFinite(calendar)&&new Date(calendar).toISOString().slice(0,10)===date&&Number.isFinite(instant),'Invalid delivery deadline');
 const utc=new Date(instant).toISOString();requireThat(matches(pattern,utc),'Invalid UTC delivery deadline');return utc;
}
export class ReadPending extends Error{}
export class ReconciliationRequired extends Error{}
export function validateCloudScope(c){
 exact(c,['team_id','channel_id','notification_destination','sender_user_id','sender_user_app_id','sender_attribution_text','bot_user_id','bot_id','transport_profile']);
 requireThat(matches(/^T[A-Z0-9]+$/,c.team_id)&&matches(/^[CG][A-Z0-9]+$/,c.channel_id)&&matches(/^D[A-Z0-9]+$/,c.notification_destination),'Pinned control channel and final DM required');
 requireThat(matches(/^U[A-Z0-9]+$/,c.sender_user_id)&&matches(/^A[A-Z0-9]+$/,c.sender_user_app_id)&&matches(/^U[A-Z0-9]+$/,c.bot_user_id)&&matches(/^B[A-Z0-9]+$/,c.bot_id),'Verified sender and Publisher identities required');
 requireThat(typeof c.sender_attribution_text==='string'&&c.sender_attribution_text.length>0&&!/[\r\n]/.test(c.sender_attribution_text),'Pinned connector attribution required');
 exact(c.transport_profile,['adapter','version','evidence_id']);
 requireThat(['adapter','version','evidence_id'].every(k=>matches(/^[a-zA-Z0-9_.-]{1,100}$/,c.transport_profile[k])),'Verified transport profile required');
 const result=structuredClone(c);Object.freeze(result.transport_profile);return Object.freeze(result);
}
export class CloudRunState{
 constructor(filename,scope){
  this.scope=validateCloudScope(scope);this.db=new DatabaseSync(filename);
  try{
   this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS cloud_scope(id INTEGER PRIMARY KEY CHECK(id=1), hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cloud_runs(id TEXT PRIMARY KEY, edition TEXT UNIQUE NOT NULL, bundle BLOB, input_hash TEXT NOT NULL, phase TEXT NOT NULL, detail TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cloud_ops(run_id TEXT NOT NULL, name TEXT NOT NULL, input_hash TEXT NOT NULL, phase TEXT NOT NULL, result TEXT, PRIMARY KEY(run_id,name));`);
   // Never adopt an older draft's reservations as proof of an unstarted send.
   const scopeHash=hash({schema_version:2,scope:this.scope});this.db.prepare('INSERT OR IGNORE INTO cloud_scope VALUES(1,?)').run(scopeHash);
   requireThat(this.db.prepare('SELECT hash FROM cloud_scope WHERE id=1').get().hash===scopeHash,'Cloud scope changed; reconcile before activation');
  }catch(e){this.db.close();throw e;}
 }
 close(){this.db.close();}
 get(id){const r=this.db.prepare('SELECT * FROM cloud_runs WHERE id=?').get(id);return r?{...r,bundle:r.bundle===null?null:Buffer.from(r.bundle),detail:JSON.parse(r.detail)}:null;}
 op(id,name){const o=this.db.prepare('SELECT * FROM cloud_ops WHERE run_id=? AND name=?').get(id,name);return o?{...o,result:o.result===null?null:JSON.parse(o.result)}:null;}
 admit(id,edition,bytes,input,phase,detail){
  const inputHash=hash(input),old=this.get(id);
  if(old){requireThat(old.edition===edition&&old.input_hash===inputHash&&((bytes===null&&old.bundle===null)||(Buffer.isBuffer(bytes)&&old.bundle?.equals(bytes))),'Run inputs changed; never replace or replay an edition');return old;}
  requireThat(this.db.prepare('SELECT count(*) AS n FROM cloud_runs').get().n<1000,'Cloud state capacity reached');
  this.db.prepare('INSERT INTO cloud_runs VALUES(?,?,?,?,?,?)').run(id,edition,bytes,inputHash,phase,json(detail));return this.get(id);
 }
 move(id,from,to,detail){return this.db.prepare('UPDATE cloud_runs SET phase=?,detail=? WHERE id=? AND phase=?').run(to,json(detail),id,from).changes===1;}
 begin(id,name,input){
  const inputHash=hash(input),r=this.db.prepare("INSERT OR IGNORE INTO cloud_ops VALUES(?,?,?, 'started',NULL)").run(id,name,inputHash);
  requireThat(this.op(id,name).input_hash===inputHash,'Operation inputs changed');return r.changes===1;
 }
 settle(id,name,phase,result){return this.db.prepare("UPDATE cloud_ops SET phase=?,result=? WHERE run_id=? AND name=? AND phase IN ('started','unknown')").run(phase,json(result),id,name).changes===1;}
 beginCompletion(job,input,checkDue){
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const current=this.get(job.id);
   if(current?.phase!=='final_ready'){this.db.exec('COMMIT');return false;}
   requireThat(current.input_hash===job.input_hash&&hash(current.detail)===hash(job.detail),'Prepared send binding changed');
   checkDue(); // After acquiring the SQLite lock, before recording write intent.
   if(!this.begin(job.id,'final_complete',input)){this.db.exec('COMMIT');return false;}
   requireThat(this.move(job.id,'final_ready','final_pending',job.detail),'Completion phase changed');
   this.db.exec('COMMIT');return true;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
}
export async function pinPrompts(io){
 const commit=await io.readPromptMain();requireThat(matches(SHA,commit),'Prompt main SHA unavailable');const prompts={};
 for(const name of ['research.md','editor.md']){
  const b=await io.readPrompt(commit,name);requireThat(Buffer.isBuffer(b)&&b.length>0&&b.length<=256*1024,'Prompt bytes unavailable');
  new TextDecoder('utf-8',{fatal:true}).decode(b);prompts[name]={sha256:digest(b),base64:b.toString('base64')};
 }
 return {commit,prompts};
}
function checkPrompts(snapshot){
 exact(snapshot,['commit','prompts']);requireThat(matches(SHA,snapshot.commit),'Prompt commit required');exact(snapshot.prompts,['research.md','editor.md']);
 for(const p of Object.values(snapshot.prompts)){
  exact(p,['sha256','base64']);requireThat(typeof p.base64==='string','Prompt encoding required');const b=Buffer.from(p.base64,'base64');
  requireThat(b.length>0&&b.length<=256*1024&&b.toString('base64')===p.base64&&matches(HASH,p.sha256)&&digest(b)===p.sha256,'Prompt snapshot changed');new TextDecoder('utf-8',{fatal:true}).decode(b);
 }
}
export async function prepareCloudRun(state,{id,files,base,prompts,not_before}){
 checkPrompts(prompts);requireThat(matches(REQUEST,id)&&matches(SHA,base),'Cloud run identity');not_before=deliveryInstant(not_before);
 const bytes=await encodeBundle(files,id,base,prompts.commit),bundle=await decodeBundle(bytes),edition=`${bundle.report.date}/r${bundle.report.revision}`;
 const detail={prompts,not_before,bundle_sha256:bundle.hash,poster_sha256:digest(bundle.files.get(bundle.report.path+bundle.report.poster))};
 return state.admit(id,edition,bytes,{base,...detail},'prepared',detail);
}
export function prepareNoSelection(state,{id,date,prompts,reason,search_scope}){
 checkPrompts(prompts);requireThat(matches(REQUEST,id)&&matches(/^\d{4}-\d\d-\d\d$/,date)&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date,'No-selection identity');
 requireThat(['no_qualifying_progress','unsuitable_or_insufficient_evidence','source_access_failure'].includes(reason),'Distinguish zero-selection causes');
 requireThat(Array.isArray(search_scope)&&search_scope.length>0&&search_scope.length<=100&&search_scope.every(s=>typeof s==='string'&&s.length>0&&Buffer.byteLength(s)<=2000),'Search evidence required');
 const detail={prompts,reason,search_scope,delivery_status:'not_sent',blocker:'zero_selection_delivery_contract_not_implemented'};
 return state.admit(id,`${date}/no-selection`,null,detail,'zero_selection_blocked',detail);
}
function controlRead(e,scope){requireThat(e?.read_context?.team_id===scope.team_id&&e.read_context.channel_id===scope.channel_id&&e.complete===true,'Authenticated complete control read required');}
export function verifyControlUpload(e,scope,{bytes,id,kind},now=Date.now()){
 controlRead(e,scope);const m=e.message,f=e.file;requireThat(matches(TS,m?.ts)&&Number(m.ts)*1000<=now+30000,'Control source timestamp');
 // Old source reads are reconciliation, not permission to replay intake.
 const event=kind==='publish'?acceptMessage(m,scope,Number(m.ts)*1000):acceptNoticeCommand(m,scope,Number(m.ts)*1000);
 requireThat(event?.request_id===id&&event.hash===digest(bytes)&&Buffer.isBuffer(e.bytes)&&e.bytes.equals(bytes),'Actual control command differs');
 requireThat(f?.id===event.file_id&&f.user===scope.sender_user_id&&f.user_team===scope.team_id&&!f.is_external&&['hosted','snippet'].includes(f.mode)&&f.name===(kind==='publish'?'ai-brief-bundle.json':'ai-notice-command.json')&&f.size===bytes.length,'Actual control file identity');
 requireThat(f.shares?.private?.[scope.channel_id]?.some(s=>s.ts===event.source_ts),'Control source share missing');return {source_ts:event.source_ts,file_id:event.file_id};
}
function publisherMessage(m,sourceTs,scope){
 requireThat(m?.type==='message'&&(!m.subtype||m.subtype==='bot_message')&&m.user===scope.bot_user_id&&m.bot_id===scope.bot_id&&!m.edited&&!m.hidden&&m.thread_ts===sourceTs&&matches(TS,m.ts)&&m.ts>sourceTs&&(!m.team||m.team===scope.team_id)&&(!m.channel||m.channel===scope.channel_id)&&!m.attachments?.length&&!m.files?.length,'Publisher receipt identity');
}
export function verifyPublicationReceipt(e,sourceTs,scope,bundle){
 controlRead(e,scope);const m=e.message;publisherMessage(m,sourceTs,scope);const prefix='!ai-report receipt ';
 requireThat(typeof m.text==='string'&&m.text.startsWith(prefix)&&Buffer.byteLength(m.text)<=16384,'Publication receipt text');
 const r=JSON.parse(m.text.slice(prefix.length)),edition=`${bundle.report.date}/r${bundle.report.revision}`;
 requireThat(r.schema_version==='1.0'&&r.status==='published'&&r.publication_status==='verified'&&r.delivery_allowed===false&&r.request_id===bundle.data.request_id&&r.bundle_sha256===bundle.hash&&r.edition===edition&&matches(SHA,r.commit)&&r.url===`https://sfcloud-ai.github.io/ai-infra-reports/${edition}/`&&r.poster_sha256===digest(bundle.files.get(bundle.report.path+bundle.report.poster))&&matches(new RegExp(`^https://github.com/${REPOSITORY}/pull/[1-9][0-9]*$`),r.pr),'Publication receipt binding');
 return {commit:r.commit,source_ts:sourceTs,receipt_ts:m.ts,poster_sha256:r.poster_sha256,url:r.url};
}
export function verifyNoticeResponse(e,scope,{bytes,sourceTs}){
 controlRead(e,scope);publisherMessage(e.message,sourceTs,scope);const c=JSON.parse(bytes),prefix='!ai-notice receipt ',text=e.message.text;
 requireThat(typeof text==='string'&&text.startsWith(prefix)&&Buffer.byteLength(text)<=16384,'Notice response text');const r=JSON.parse(text.slice(prefix.length));
 requireThat(r.schema_version==='1.0'&&r.command_id===c.command_id&&r.command_sha256===digest(bytes)&&r.report_request_id===c.report_request_id&&r.bundle_sha256===c.bundle_sha256,'Notice response binding');return r;
}
export class CloudSender{
 #preflight=new Map();
 constructor(state,io,{now=()=>Date.now()}={}){this.state=state;this.io=io;this.now=now;}
 readNow(){const now=this.now();requireThat(Number.isSafeInteger(now)&&now>0,'Host clock unavailable');return now;}
 checkDue(job){
  if(this.readNow()<Date.parse(job.detail.not_before))throw new ReadPending('Awaiting delivery time');
 }
 async once(id,name,input,write){
  const old=this.state.op(id,name);if(old){requireThat(old.input_hash===hash(input),'Operation inputs changed');return old;}
  if(!this.state.begin(id,name,input))return this.state.op(id,name);
  try{const result=await write();this.state.settle(id,name,'acknowledged',result??null);}catch{this.state.settle(id,name,'unknown',null);}
  return this.state.op(id,name);
 }
 async control(id,name,kind,bytes,commandId){
  const scope=this.state.scope,comment=kind==='publish'?`!ai-report publish ${commandId} ${digest(bytes)}`:`!ai-notice submit ${commandId} ${digest(bytes)}`;
  await this.once(id,name,{kind,hash:digest(bytes),commandId},async()=>{await this.io.shareControl({channel_id:scope.channel_id,filename:kind==='publish'?'ai-brief-bundle.json':'ai-notice-command.json',bytes,initial_comment:comment});return null;});
  const evidence=await this.io.readControlUpload({command_id:commandId,hash:digest(bytes)});
  if(!evidence)throw new ReconciliationRequired('Control upload unresolved; do not repost');return verifyControlUpload(evidence,scope,{bytes,id:commandId,kind},this.now());
 }
 command(job,action,fields={}){
  const command_id=`cloud-${action}-${digest(job.id).slice(0,32)}`;
  return encodeNoticeCommand({schema_version:'1.0',command_id,action,report_request_id:job.id,bundle_sha256:job.detail.bundle_sha256,...fields});
 }
 async publication(job,bundle){const proof=await verifyReportPublication(job.detail.publication.commit,bundle,this.io.fetchPublic);requireThat(proof.poster_sha256===job.detail.poster_sha256,'Publication poster changed');return proof;}
 async step(id){
  const job=this.state.get(id);requireThat(job,'Unknown cloud run');
  if(['zero_selection_blocked','sender_reported'].includes(job.phase))return job;
  requireThat(job.detail.not_before===deliveryInstant(job.detail.not_before),'Stored deadline is not canonical UTC; reconcile before activation');
  this.readNow();
  const bundle=await decodeBundle(job.bundle),scope=this.state.scope;
  if(job.phase==='prepared'){
   const source=await this.control(id,'publish','publish',job.bundle,id);
   this.state.move(id,'prepared','publication_wait',{...job.detail,publish_source:source});return this.state.get(id);
  }
  if(job.phase==='publication_wait'){
   const e=await this.io.readPublication({source_ts:job.detail.publish_source.source_ts});if(!e)throw new ReadPending('Publication receipt pending');
   const publication=verifyPublicationReceipt(e,job.detail.publish_source.source_ts,scope,bundle),candidate={...job,detail:{...job.detail,publication}};
   await this.publication(candidate,bundle);this.state.move(id,'publication_wait','published',candidate.detail);return this.state.get(id);
  }
  if(job.phase==='published'){
   await this.publication(job,bundle);await this.io.assertTransport(scope.transport_profile,scope);
   const poster=bundle.files.get(bundle.report.path+bundle.report.poster);
   const op=await this.once(id,'poster_upload',{sha256:digest(poster)},async()=>{const r=await this.io.uploadUnsharedPoster({bytes:poster,name:bundle.report.poster.split('/').at(-1)});requireThat(matches(FILE,r?.file_id),'Unshared poster file ID missing');return {file_id:r.file_id};});
   if(op.phase!=='acknowledged'||!matches(FILE,op.result?.file_id))throw new ReconciliationRequired('Unshared poster upload unresolved; no replacement ID');
   this.state.move(id,'published','claim_wait',{...job.detail,file_id:op.result.file_id,attempt_id:`cloud-${digest(id).slice(0,32)}`});return this.state.get(id);
  }
  if(job.phase==='claim_wait'){
   const fields={attempt_id:job.detail.attempt_id,file_id:job.detail.file_id},bytes=this.command(job,'claim',fields);
   const source=await this.control(id,'claim','notice',bytes,JSON.parse(bytes).command_id);
   await this.verifyGrant(job,bundle,bytes,source);
   this.state.move(id,'claim_wait','final_ready',{...job.detail,claim_source:source});
   return this.state.get(id);
  }
  if(job.phase==='final_ready')return this.completeReady(job,bundle);
  if(['final_pending','record_wait'].includes(job.phase))return this.reconcile(job,bundle);
  throw new ReconciliationRequired('Unknown cloud phase');
 }
 async verifyGrant(job,bundle,bytes,source){
  const scope=this.state.scope,e=await this.io.readNoticeResponse({source_ts:source.source_ts});
  if(!e)throw new ReadPending('Notice grant pending');controlRead(e,scope);
  const grant=verifyNoticeGrant(e.message,{bytes,sourceTs:source.source_ts,readContext:e.read_context,config:scope});
  const manifest=createNoticeManifest(bundle.files.get(bundle.report.path+'report.json'),job.detail.publication.commit);
  requireThat(grant.report_merge_sha===job.detail.publication.commit&&grant.poster_original_sha256===job.detail.poster_sha256&&grant.text_sha256===digest(Buffer.from(manifest.text))&&grant.url===manifest.index_url,'Grant differs from prepared edition');
  return {grant,manifest};
 }
 preflightFresh(job,checked){
  const now=this.readNow();
  return checked&&checked.binding===hash({input_hash:job.input_hash,detail:job.detail})&&now>=checked.at&&now-checked.at<PREFLIGHT_REFRESH_MS;
 }
 async refreshPreflight(job,bundle){
  this.#preflight.delete(job.id);
  const started=this.readNow();
  const scope=this.state.scope,bytes=this.command(job,'claim',{attempt_id:job.detail.attempt_id,file_id:job.detail.file_id});
  const evidence=await this.io.readControlUpload({command_id:JSON.parse(bytes).command_id,hash:digest(bytes)});
  const source=verifyControlUpload(evidence,scope,{bytes,id:JSON.parse(bytes).command_id,kind:'notice'},this.readNow());
  requireThat(hash(source)===hash(job.detail.claim_source),'Original claim changed');
  const {grant,manifest}=await this.verifyGrant(job,bundle,bytes,source);
  await this.publication(job,bundle);await this.io.assertTransport(scope.transport_profile,scope);
  const checked={at:started,binding:hash({input_hash:job.input_hash,detail:job.detail}),grant,manifest};
  this.#preflight.set(job.id,checked);return checked;
 }
 async completeReady(job,bundle){
  if(this.state.op(job.id,'final_complete')){this.#preflight.delete(job.id);return this.reconcile(job,bundle);}
  let checked=this.#preflight.get(job.id);
  // Reads can finish before due time. Restart/cache loss simply repeats them;
  // this cache is not the one-use authority, which remains the durable intent.
  if(!this.preflightFresh(job,checked))checked=await this.refreshPreflight(job,bundle);
  const check=()=>{
   this.checkDue(job);
   if(!this.preflightFresh(job,checked))throw new ReadPending('Refresh preflight reads before completing');
  };
  check();
  const input={file_id:job.detail.file_id,text_sha256:checked.grant.text_sha256};
  if(!this.state.beginCompletion(job,input,check))return this.state.get(job.id);
  this.#preflight.delete(job.id);
  try{
   check();
   await this.io.completeFinalUpload({channel_id:this.state.scope.notification_destination,file_id:job.detail.file_id,initial_comment:checked.manifest.text});
   this.state.settle(job.id,'final_complete','acknowledged',null);
  }catch{this.state.settle(job.id,'final_complete','unknown',null);}
  return this.state.get(job.id);
 }
 async reconcile(job,bundle){
  const id=job.id,scope=this.state.scope,manifest=createNoticeManifest(bundle.files.get(bundle.report.path+'report.json'),job.detail.publication.commit);
  const statusBytes=this.command(job,'status'),statusSource=await this.control(id,'status','notice',statusBytes,JSON.parse(statusBytes).command_id);
  const e=await this.io.readNoticeResponse({source_ts:statusSource.source_ts});if(!e)throw new ReadPending('Reservation status pending');
  const status=verifyNoticeResponse(e,scope,{bytes:statusBytes,sourceTs:statusSource.source_ts}),n=status.notice;
  requireThat(status.send_authorized===false&&n?.report_id===id&&n.attempt_id===job.detail.attempt_id&&n.file_id===job.detail.file_id&&n.detail?.bundle_sha256===bundle.hash&&n.detail.report_merge_sha===job.detail.publication.commit&&n.detail.destination===scope.notification_destination&&n.detail.poster_original_sha256===job.detail.poster_sha256&&n.detail.text_sha256===digest(Buffer.from(manifest.text)),'Reservation binding mismatch; no permission to send');
  const evidence=await this.io.readFinalByFile({channel_id:scope.notification_destination,file_id:job.detail.file_id});
  if(!evidence)throw new ReconciliationRequired('Final send unresolved; never complete or replace the file');
  requireThat(evidence.complete===true&&evidence.read_context?.team_id===scope.team_id&&evidence.read_context.channel_id===scope.notification_destination,'Authenticated complete final read required');
  // Real adapter must invoke ai-infra-brief check_received_notice, not a success flag.
  const receipt=await this.io.checkFinalNotice({scope,manifest,file_id:job.detail.file_id,evidence});
  requireThat(receipt?.slack_status==='verified'&&receipt.wecom_status==='not_checked'&&receipt.receipt?.channel===scope.notification_destination&&matches(TS,receipt.receipt.ts)&&receipt.receipt.file_id===job.detail.file_id&&receipt.receipt.transport_sha256===job.detail.poster_sha256&&receipt.receipt.transport_bytes===bundle.files.get(bundle.report.path+bundle.report.poster).length,'Final notice contract evidence mismatch');
  const fields={attempt_id:job.detail.attempt_id,file_id:job.detail.file_id,message_ts:receipt.receipt.ts,text_sha256:digest(Buffer.from(manifest.text)),transport_sha256:receipt.receipt.transport_sha256,transport_bytes:receipt.receipt.transport_bytes};
  if(job.phase!=='record_wait'){
   if(!this.state.move(id,job.phase,'record_wait',{...job.detail,final_receipt:fields}))return this.state.get(id);job=this.state.get(id);
  }else requireThat(hash(job.detail.final_receipt)===hash(fields),'Actual final message changed');
  const bytes=this.command(job,'record',fields),source=await this.control(id,'record','notice',bytes,JSON.parse(bytes).command_id);
  const responseEvidence=await this.io.readNoticeResponse({source_ts:source.source_ts});if(!responseEvidence)throw new ReadPending('Notice record pending');
  const response=verifyNoticeResponse(responseEvidence,scope,{bytes,sourceTs:source.source_ts}),notice=response.notice;
  const reported=Object.fromEntries(Object.entries(fields).filter(([k])=>k!=='attempt_id'));
  requireThat(response.send_authorized===false&&response.slack_status==='sender_reported'&&response.wecom_status==='not_checked'&&notice?.report_id===id&&notice.file_id===fields.file_id&&notice.attempt_id===fields.attempt_id&&notice.phase==='sender_reported'&&hash(notice.detail?.sender_receipt)===hash(reported),'Record response differs from actual message');
  this.state.move(id,'record_wait','sender_reported',{...job.detail,record_source:source,slack_status:'verified',publisher_status:'sender_reported',wecom_status:'not_checked'});return this.state.get(id);
 }
}
