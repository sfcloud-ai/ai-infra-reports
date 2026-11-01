// Optional control-channel outbox. It never sends a final DM or reads relay secrets.
import {createNoticeManifest} from "./notice-manifest.mjs";
import {digest} from "./archive.mjs";
import {scopeDigest,handoffScope} from "./handoff-state.mjs";
import {acceptDataCommand,decodeBundle,requireThat,REQUEST} from "./report-handoff.mjs";
import {checkedNoticeResult} from "./notice-checker.mjs";
export const MAX_NOTICE_COMMAND=16384;
export function notificationScope(config){
 const {ready_for_review,...scope}=handoffScope(config);
 return {...scope,destination:config.notification_destination,not_before:config.notification_not_before};
}
const HASH=/^[a-f0-9]{64}$/,FILE=/^F[A-Z0-9]+$/,TS=/^\d{10}\.\d{6}$/;
const exact=(o,keys)=>requireThat(o&&typeof o==="object"&&!Array.isArray(o)&&Object.keys(o).sort().join()===keys.sort().join(),"Unexpected notice command fields");
export function acceptNoticeCommand(message,config,now=Date.now()){
 return acceptDataCommand(message,config,"!ai-notice ",/^!ai-notice submit ([a-z0-9][a-z0-9-]{7,79}) ([a-f0-9]{64})$/,now);
}
export function decodeNoticeCommand(bytes){
 requireThat(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=MAX_NOTICE_COMMAND,"Notice command byte limit");
 const c=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
 const common=["schema_version","command_id","action","report_request_id","bundle_sha256"];
 const recordFields=["attempt_id","file_id","message_ts","text_sha256","transport_sha256","transport_bytes"];
 const fields={claim:["attempt_id","file_id"],prepare:["attempt_id","file_id"],prepare_bundle:["attempt_id","file_id"],begin:["attempt_id","file_id"],status:[],asset:["file_id","message_ts"],unknown:["attempt_id","file_id"],check:["attempt_id","file_id","message_ts"],record:recordFields,record_bundle:[...recordFields,"poster_sha256","poster_bytes"]};
 requireThat(c&&typeof c.action==="string"&&Object.hasOwn(fields,c.action),"Unsupported notice action");exact(c,[...common,...fields[c.action]]);
 requireThat(c.schema_version==="1.0"&&[c.command_id,c.report_request_id].every(v=>typeof v==="string"&&REQUEST.test(v))&&typeof c.bundle_sha256==="string"&&HASH.test(c.bundle_sha256),"Notice request identity");
 if(c.action!=="status")requireThat(typeof c.file_id==="string"&&FILE.test(c.file_id),"Notice file identity");
 if(!["status","asset"].includes(c.action))requireThat(typeof c.attempt_id==="string"&&REQUEST.test(c.attempt_id),"Notice attempt identity");
 if(["check","asset"].includes(c.action))requireThat(typeof c.message_ts==="string"&&TS.test(c.message_ts),"Exact notice timestamp required");
 if(["record","record_bundle"].includes(c.action))requireThat(typeof c.message_ts==="string"&&TS.test(c.message_ts)&&[c.text_sha256,c.transport_sha256].every(v=>typeof v==="string"&&HASH.test(v))&&Number.isSafeInteger(c.transport_bytes)&&c.transport_bytes>0&&c.transport_bytes<=(c.action==="record_bundle"?8*1024*1024:2000000),"Reported Slack receipt fields");
 if(c.action==="record_bundle")requireThat(typeof c.poster_sha256==="string"&&HASH.test(c.poster_sha256)&&Number.isSafeInteger(c.poster_bytes)&&c.poster_bytes>0&&c.poster_bytes<=2000000,"Reported original poster fields");
 return c;
}
export class NoticeOutbox{
 constructor(state,scope){
  this.state=state;this.db=state.db;this.destination=scope.destination;this.notBefore=scope.not_before;this.controlChannel=scope.channel_id;
  requireThat(typeof this.destination==="string"&&/^D[A-Z0-9]+$/.test(this.destination)&&typeof this.notBefore==="string"&&TS.test(this.notBefore),"Pinned final DM destination and activation boundary required");
  this.db.exec(`CREATE TABLE IF NOT EXISTS notice_scope (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS notices (edition TEXT PRIMARY KEY, report_id TEXT UNIQUE NOT NULL, attempt_id TEXT UNIQUE NOT NULL, file_id TEXT UNIQUE NOT NULL, phase TEXT NOT NULL, detail TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS notice_commands (id TEXT PRIMARY KEY, hash TEXT NOT NULL, source_ts TEXT UNIQUE NOT NULL, bytes BLOB NOT NULL, phase TEXT NOT NULL, response TEXT, receipt_ts TEXT);`);
  const hash=scopeDigest(scope);this.db.prepare("INSERT OR IGNORE INTO notice_scope VALUES (1,?)").run(hash);
  requireThat(this.db.prepare("SELECT value FROM notice_scope WHERE id=1").get().value===hash,"Notice scope changed; reconcile first");
 }
 command(id){const r=this.db.prepare("SELECT * FROM notice_commands WHERE id=?").get(id);return r?{...r,bytes:Buffer.from(r.bytes),response:r.response?JSON.parse(r.response):null}:null;}
 notice(id){const r=this.db.prepare("SELECT * FROM notices WHERE report_id=?").get(id);return r?{...r,detail:JSON.parse(r.detail)}:null;}
 admit(event,bytes){
  const c=decodeNoticeCommand(bytes);requireThat(c.command_id===event.request_id&&digest(bytes)===event.hash,"Notice transport mismatch");
  const prior=this.command(c.command_id);
  if(prior){requireThat(prior.hash===event.hash&&prior.source_ts===event.source_ts,"Notice command replay conflict");return;}
  requireThat(this.db.prepare("SELECT count(*) AS n FROM notice_commands").get().n<10000,"Notice state capacity reached");
  this.db.prepare("INSERT INTO notice_commands VALUES (?,?,?,?,'received',NULL,NULL)").run(c.command_id,event.hash,event.source_ts,bytes);
 }
 pending(){return this.db.prepare("SELECT id FROM notice_commands WHERE phase!='response_sent' ORDER BY source_ts").all().map(r=>r.id);}
 prepare(id,c,job,bundle,proof,check){
  this.db.exec("BEGIN IMMEDIATE");
  try{
   if(this.command(id).phase!=="received"){this.db.exec("COMMIT");return;}
   const current=this.state.get(c.report_request_id);
   requireThat(current?.hash===job.hash&&current.phase===job.phase&&JSON.stringify(current.detail)===JSON.stringify(job.detail),"Report changed during notice validation");
   let notice=this.notice(c.report_request_id),authorized=false,reason;
   if(["claim","prepare","prepare_bundle"].includes(c.action)){
    const edition=`${bundle.report.date}/r${bundle.report.revision}`;
    if(notice||this.db.prepare("SELECT 1 FROM notices WHERE edition=? OR attempt_id=? OR file_id=?").get(edition,c.attempt_id,c.file_id))reason="already_reserved";
    else{
     const manifest=createNoticeManifest(bundle.files.get(bundle.report.path+"report.json"),job.detail.commit);
     requireThat(manifest.index_url===proof.url&&manifest.poster.sha256===proof.poster_sha256,"Notice manifest differs from publication proof");
     const text=manifest.text;
     const detail={poster_policy:"original_bytes_v1",bundle_sha256:job.hash,report_merge_sha:job.detail.commit,url:proof.url,poster_original_sha256:proof.poster_sha256,text_sha256:digest(Buffer.from(text)),destination:this.destination};
     const native=c.action!=="claim";
     if(native){detail.delivery_mode=c.action==="prepare_bundle"?"native_bundle_v1":"native_v1";detail.not_before=bundle.report.date+"T00:00:00.000Z";}
     this.db.prepare("INSERT INTO notices VALUES (?,?,?,?,?,?)").run(edition,job.id,c.attempt_id,c.file_id,"reserved",JSON.stringify(detail));
     authorized=!native;if(native)reason="prepared_without_send_grant";
    }
   }else if(c.action==="begin"){
    requireThat(notice&&notice.attempt_id===c.attempt_id&&notice.file_id===c.file_id&&["native_v1","native_bundle_v1"].includes(notice.detail.delivery_mode),"Native attempt does not own this edition");
    if(notice.phase!=="reserved")reason="completion_already_started";
    else{
     const manifest=createNoticeManifest(bundle.files.get(bundle.report.path+"report.json"),job.detail.commit);
     requireThat(notice.detail.bundle_sha256===job.hash&&notice.detail.report_merge_sha===job.detail.commit&&notice.detail.poster_original_sha256===proof.poster_sha256&&notice.detail.text_sha256===digest(Buffer.from(manifest.text))&&notice.detail.destination===this.destination&&notice.detail.url===proof.url&&notice.detail.not_before===bundle.report.date+"T00:00:00.000Z","Prepared notice differs from verified publication");
     const detail={...notice.detail,completion_command_id:id,completion_command_sha256:this.command(id).hash};
     this.db.prepare("UPDATE notices SET phase='completion_intent',detail=? WHERE report_id=? AND phase='reserved'").run(JSON.stringify(detail),job.id);
     authorized=true;reason="new_completion_intent";
    }
   }else if(c.action==="asset"){
    requireThat(check?.asset,"Asset verification result required");reason="control_asset_checked";
   }else if(c.action==="check"){
    requireThat(check&&JSON.stringify(notice)===JSON.stringify(check.notice),"Reservation changed during notice check");
   }else if(c.action!=="status"){
    requireThat(notice&&notice.attempt_id===c.attempt_id&&notice.file_id===c.file_id,"Notice attempt does not own this edition");
    if(["native_v1","native_bundle_v1"].includes(notice.detail.delivery_mode)){
     const d=notice.detail;
     requireThat(typeof d.completion_command_id==="string"&&REQUEST.test(d.completion_command_id)&&typeof d.completion_command_sha256==="string"&&HASH.test(d.completion_command_sha256),"Native send has no persisted completion intent");
     const intent=this.command(d.completion_command_id),begin=intent?decodeNoticeCommand(intent.bytes):null;
     requireThat(intent&&intent.hash===d.completion_command_sha256&&digest(intent.bytes)===intent.hash&&begin.action==="begin"&&begin.report_request_id===job.id&&begin.bundle_sha256===job.hash&&begin.attempt_id===notice.attempt_id&&begin.file_id===notice.file_id&&intent.response?.send_authorized===true&&intent.response.reason==="new_completion_intent","Native completion command binding changed");
    }
    if(c.action==="unknown"){
     requireThat(notice.phase!=="sender_reported","Reported send cannot be downgraded");
     this.db.prepare("UPDATE notices SET phase='send_unknown' WHERE report_id=?").run(job.id);
    }else{
     requireThat(!["native_v1","native_bundle_v1"].includes(notice.detail.delivery_mode)||["completion_intent","send_unknown","sender_reported"].includes(notice.phase),"Native send has no persisted completion intent");
     const bundled=notice.detail.delivery_mode==="native_bundle_v1";
     requireThat((c.action==="record_bundle")===bundled,"Receipt transport mode differs from reservation");
     requireThat(!Object.hasOwn(notice.detail,"poster_policy")||notice.detail.poster_policy==="original_bytes_v1","Unknown persisted poster policy");
     requireThat(c.text_sha256===notice.detail.text_sha256,"Reported text differs from plan");
     const receipt={message_ts:c.message_ts,file_id:c.file_id,text_sha256:c.text_sha256,transport_sha256:c.transport_sha256,transport_bytes:c.transport_bytes};
     if(bundled){requireThat(c.transport_sha256===job.hash&&c.transport_bytes===job.bytes.length&&c.poster_sha256===notice.detail.poster_original_sha256&&c.poster_bytes===bundle.files.get(bundle.report.path+bundle.report.poster).length,"Reported bundle or original poster differs");Object.assign(receipt,{poster_sha256:c.poster_sha256,poster_bytes:c.poster_bytes});}
     if(notice.phase==="sender_reported")requireThat(JSON.stringify(notice.detail.sender_receipt)===JSON.stringify(receipt),"Conflicting reported receipt");
     else {
      if(!bundled&&notice.detail.poster_policy==="original_bytes_v1")requireThat(c.transport_sha256===notice.detail.poster_original_sha256,"Reported poster bytes differ from the original");
      this.db.prepare("UPDATE notices SET phase='sender_reported',detail=? WHERE report_id=?").run(JSON.stringify({...notice.detail,sender_receipt:receipt}),job.id);
     }
    }
   }
   notice=this.notice(c.report_request_id);
   const response={schema_version:"1.0",command_id:id,command_sha256:this.command(id).hash,report_request_id:job.id,bundle_sha256:job.hash,send_authorized:authorized,reason:reason??(authorized?"new_reservation":"read_only_status"),notice:notice??null,slack_status:notice?.phase==="sender_reported"?"sender_reported":"not_checked",wecom_status:"not_checked"};
   if(c.action==="check")response.verification=check.result;
   if(c.action==="asset")response.asset=check.asset;
   this.db.prepare("UPDATE notice_commands SET phase='response_ready',response=? WHERE id=? AND phase='received'").run(JSON.stringify(response),id);
   this.db.exec("COMMIT");
  }catch(e){this.db.exec("ROLLBACK");throw e;}
 }
 move(id,from,to,ts=null){return this.db.prepare("UPDATE notice_commands SET phase=?,receipt_ts=? WHERE id=? AND phase=?").run(to,ts,id,from).changes===1;}
}
export const noticeResponseText=response=>"!ai-notice receipt "+JSON.stringify(response);
export async function advanceNotice(outbox,id,io){
 let operation=outbox.command(id);requireThat(operation,"Unknown notice command");
 if(operation.phase==="response_sent")return;
 if(["response_sending","response_unknown"].includes(operation.phase)){
  // Recovery reads the exact original control thread. Absence never permits retry.
  const ts=await io.findReceipt(operation.source_ts,noticeResponseText(operation.response));
  requireThat(typeof ts==="string"&&TS.test(ts),"Control receipt reconciliation failed");
  outbox.move(id,operation.phase,"response_sent",ts);return;
 }
 if(operation.phase==="received"){
  const c=decodeNoticeCommand(operation.bytes),job=outbox.state.get(c.report_request_id);
  requireThat(job&&job.hash===c.bundle_sha256,"Unknown report or bundle changed");
  let bundle,proof,check;
  if(["claim","prepare","prepare_bundle","begin","check","asset","record_bundle"].includes(c.action)){
   requireThat(job.phase==="receipt_sent","Publication receipt must finish before notification claim");
   if(["claim","prepare","prepare_bundle","begin"].includes(c.action))requireThat(TS.test(job.source_ts)&&BigInt(job.source_ts.replace(".",""))>BigInt(outbox.notBefore.replace(".","")),"Pre-activation reports cannot receive a notification grant");
   bundle=await decodeBundle(job.bytes);proof=await io.verify(job.detail.commit,bundle);
   const edition=`${bundle.report.date}/r${bundle.report.revision}`;
   requireThat(proof.publication_status==="verified"&&proof.commit===job.detail.commit&&proof.bundle_sha256===job.hash&&proof.request_id===job.id&&proof.edition===edition&&proof.url===`https://sfcloud-ai.github.io/ai-infra-reports/${edition}/`&&proof.poster_sha256===digest(bundle.files.get(bundle.report.path+bundle.report.poster)),"Notice publication proof mismatch");
   if(c.action==="check"){
    const notice=outbox.notice(c.report_request_id),manifest=createNoticeManifest(bundle.files.get(bundle.report.path+"report.json"),job.detail.commit);
    requireThat(notice&&notice.attempt_id===c.attempt_id&&notice.file_id===c.file_id&&notice.edition===edition&&notice.detail.poster_policy==="original_bytes_v1"&&notice.detail.bundle_sha256===job.hash&&notice.detail.report_merge_sha===job.detail.commit&&notice.detail.destination===outbox.destination&&notice.detail.poster_original_sha256===proof.poster_sha256&&notice.detail.text_sha256===digest(Buffer.from(manifest.text))&&notice.detail.url===proof.url,"Checker requires the original reserved notice");
    requireThat(c.message_ts>=job.source_ts&&c.message_ts<=operation.source_ts,"Check must follow its report and final message");
    const request={message_ts:c.message_ts,file_id:c.file_id,notice_manifest:manifest};
    if(notice.detail.delivery_mode==="native_bundle_v1")Object.assign(request,{transport:"report_bundle_v1",bundle_sha256:job.hash,bundle_bytes:job.bytes.length});
    let observed;
    // An unavailable read produces a bounded negative receipt, never a send grant.
    try{observed=await io.checkNotice?.(request);}catch{}
    check={notice,result:checkedNoticeResult(observed,{request,destination:outbox.destination,posterBytes:bundle.files.get(bundle.report.path+bundle.report.poster).length})};
   }else if(c.action==="asset"){
    requireThat(c.message_ts>=job.source_ts&&c.message_ts<=operation.source_ts,"Asset must follow the report and precede its check request");
    const expected={file_id:c.file_id,message_ts:c.message_ts,name:bundle.report.poster.split("/").at(-1),sha256:proof.poster_sha256,bytes:bundle.files.get(bundle.report.path+bundle.report.poster).length};
    let observed;try{observed=await io.verifyAsset?.(expected);}catch{}
    const ok=observed&&Object.keys(observed).sort().join()===["status","channel_id","message_ts","file_id","sha256","bytes","messages_sent"].sort().join()&&observed.status==="verified"&&observed.channel_id===outbox.controlChannel&&observed.message_ts===expected.message_ts&&observed.file_id===expected.file_id&&observed.sha256===expected.sha256&&observed.bytes===expected.bytes&&observed.messages_sent===0;
    check={asset:ok?observed:{status:"not_verified",messages_sent:0}};
   }
  }
  outbox.prepare(id,c,job,bundle,proof,check);operation=outbox.command(id);
 }
 requireThat(operation.phase==="response_ready","Unknown notice response phase");
 if(!outbox.move(id,"response_ready","response_sending"))return;
 try{
  const ts=await io.receipt(operation.source_ts,noticeResponseText(operation.response));
  requireThat(typeof ts==="string"&&TS.test(ts),"Notice response timestamp missing");
  outbox.move(id,"response_sending","response_sent",ts);
 }catch{outbox.move(id,"response_sending","response_unknown");throw Error("Notice response outcome unknown; read original thread, never resend");}
}
