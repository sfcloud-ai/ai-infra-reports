import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,lstat,realpath} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {digest} from './archive.mjs';
import {requireThat,decodeBundle,MAX_BUNDLE} from './report-handoff.mjs';
import {producerTicket,postMetrics} from './producer-upload.mjs';

const metricNames=['http_status','num_connects','num_redirects','upload_bytes','response_bytes','header_bytes','time_namelookup','time_connect','time_appconnect','time_starttransfer','ssl_verify_result'];
const curlNames=['http_code','num_connects','num_redirects','size_upload','size_download','size_header','time_namelookup','time_connect','time_appconnect','time_starttransfer','ssl_verify_result'];
export function producerCurlEnvironment(transport='direct',env=process.env){
 requireThat(['direct','managed_proxy'].includes(transport),'Unsupported upload transport');
 const out={PATH:env.PATH,LANG:'C'};
 if(transport==='direct')return out;
 // Only the already configured managed HTTPS proxy is used. No proxy URL is
 // logged, placed in argv, or stored in the journal. Never fall back to direct.
 const proxy=env.https_proxy||env.HTTPS_PROXY;
 requireThat(typeof proxy==='string'&&proxy.length>0&&proxy.length<=8192&&!/[\r\n\0]/.test(proxy),'Managed HTTPS proxy unavailable');
 requireThat(!env.https_proxy||!env.HTTPS_PROXY||env.https_proxy===env.HTTPS_PROXY,'Ambiguous managed HTTPS proxy');
 let parsed;try{parsed=new URL(proxy);}catch{throw Error('Invalid managed HTTPS proxy');}
 requireThat(['http:','https:'].includes(parsed.protocol)&&parsed.hostname&&!parsed.hash&&!parsed.search&&['','/'].includes(parsed.pathname),'Invalid managed HTTPS proxy');
 Object.assign(out,{https_proxy:proxy,HTTPS_PROXY:proxy,no_proxy:'',NO_PROXY:''});
 for(const key of ['CURL_CA_BUNDLE','SSL_CERT_FILE','SSL_CERT_DIR'])if(env[key]){
  requireThat(typeof env[key]==='string'&&isAbsolute(env[key])&&!/[\r\n\0]/.test(env[key]),'Invalid managed CA path');out[key]=env[key];
 }
 return out;
}
export function curlUploadPlan({url,input,output,size,transport='direct'}){
 requireThat(['direct','managed_proxy'].includes(transport),'Unsupported upload transport');
 // The raw signed string is sent over stdin, never argv, logs or error text.
 producerTicket({file_id:'FVALIDATE',upload_url:url});
 return {args:['-q','--config','-','--silent','--request','POST','--proto','=https','--proto-redir','=https','--max-redirs','0','--retry','0',...(transport==='direct'?['--noproxy','*']:[]),'--connect-timeout','15','--max-time','60','--max-filesize','65536','--header','Content-Type: application/json','--header','Content-Length: '+size,'--data-binary','@'+input,'--output',output,'--write-out',curlNames.map(n=>`%{${n}}`).join('\t')],stdin:`url = "${url}"\n`};
}
export async function uploadProducerBytes({bytes,ticket},{spawnCurl=spawn,transport='direct',environment=process.env}={}){
 requireThat(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=8*1024*1024,'Bounded original upload bytes required');
 const t=producerTicket({file_id:ticket.file_id,upload_url:ticket.upload_url});
 requireThat(t.url_sha256===ticket.url_sha256,'Original ticket changed');
 const curlEnvironment=producerCurlEnvironment(transport,environment);
 const dir=await mkdtemp(join(tmpdir(),'producer-post-'));
 try{
  const input=join(dir,'bundle'),output=join(dir,'response');await writeFile(input,bytes,{mode:0o600});
  const plan=curlUploadPlan({url:t.upload_url,input,output,size:bytes.length,transport});
  const metrics=await new Promise((resolve,reject)=>{
   const child=spawnCurl('curl',plan.args,{shell:false,stdio:['pipe','pipe','ignore'],env:curlEnvironment});
   let stdout='',done=false;
   const fail=()=>{if(!done){done=true;clearTimeout(timer);child.kill('SIGKILL');reject(Error('POST outcome unknown'));}};
   const timer=setTimeout(fail,65000);child.on('error',fail);child.stdin.on('error',fail);
   child.stdout.on('data',b=>{stdout+=b.toString('ascii');if(stdout.length>2048)fail();});
   child.on('close',code=>{
    if(done)return;done=true;clearTimeout(timer);
    const values=stdout.split('\t');
    if(!Number.isInteger(code)||values.length!==metricNames.length||!values.every(v=>/^\d+(?:\.\d+)?$/.test(v)))return reject(Error('POST outcome unknown'));
    resolve({curl_exit:code,...Object.fromEntries(metricNames.map((k,i)=>[k,Number(values[i])]))});
   });child.stdin.end(plan.stdin);
  });
  let response=null;try{const info=await lstat(output);requireThat(info.isFile()&&info.size<=64*1024,'Bounded upload response required');response=await readFile(output);}catch(e){if(e.code!=='ENOENT')throw e;}
  requireThat((response?.length??0)===metrics.response_bytes,'POST response metrics differ');
  return {adapter:transport==='managed_proxy'?'producer_curl_managed_proxy_v1':'producer_curl_direct_v1',file_id:t.file_id,url_sha256:t.url_sha256,bundle_sha256:digest(bytes),metrics:postMetrics({...metrics,response_sha256:response?digest(response):null})};
 }finally{await rm(dir,{recursive:true,force:true});}
}

async function originalDatabase(path){
 requireThat(typeof path==='string'&&isAbsolute(path),'Pinned absolute original database path required');
 const info=await lstat(path);requireThat(info.isFile()&&!info.isSymbolicLink()&&await realpath(path)===path,'Original database required');
 const db=new DatabaseSync(path,{readOnly:true});
 try{db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN');return db;}catch(e){db.close();throw e;}
}
// Executable read adapter for the existing schemas. Never instantiate Relay
// Store/ScheduledDelivery: their constructors can recover/mutate rows. Missing
// scopes, legacy date mappings or schema are blockers, never proof of absence.
export const LEDGER_READ_BUDGET_MS=45000;
export async function readProducerLedgers({publisher_database,scheduler_database,scope},{request_id,report_date},{now=Date.now,monotonicNow=()=>performance.now()}={}){
 const started=monotonicNow(),budget=()=>{const elapsed=monotonicNow()-started;requireThat(Number.isFinite(elapsed)&&elapsed>=0&&elapsed<LEDGER_READ_BUDGET_MS,'Original ledger read time budget exceeded');};
 const bounded=n=>Number.isSafeInteger(n)&&n>0&&n<=MAX_BUNDLE;
 const observed_at=now();budget();const p=await originalDatabase(publisher_database);let s;
 try{
  budget();s=await originalDatabase(scheduler_database);budget();
  requireThat(p.prepare('SELECT value FROM scope WHERE id=1').get()?.value===scope.publisher_scope_sha256,'Original Publisher scope mismatch');
  requireThat(s.prepare("SELECT value FROM meta WHERE key='scheduled_delivery_scope_v1'").get()?.value===scope.scheduler_scope_sha256,'Original scheduler scope mismatch');
  // Pin the same read transaction, check only bounded metadata first, then
  // release each decoded bundle before fetching the next. Never .all() BLOBs.
  budget();const jobs=p.prepare('SELECT id,length(bytes) AS byte_length,typeof(bytes) AS byte_type FROM jobs LIMIT 1001').all();
  requireThat(jobs.length<=1000&&new Set(jobs.map(r=>r.id)).size===jobs.length,'Complete bounded Publisher scan required');
  requireThat(jobs.every(r=>r.byte_type==='blob'&&bounded(r.byte_length)),'Bounded original Publisher bundle required');
  const getJob=p.prepare('SELECT id,hash,source_ts,bytes,detail FROM jobs WHERE id=?');
  const publisher_day=[];let publisher=null;
  for(const meta of jobs){
   budget();const row=getJob.get(meta.id);requireThat(row&&row.id===meta.id&&row.bytes?.byteLength===meta.byte_length,'Original Publisher snapshot changed');
   const b=await decodeBundle(Buffer.from(row.bytes.buffer,row.bytes.byteOffset,row.bytes.byteLength));budget();requireThat(b.hash===row.hash&&b.data.request_id===row.id,'Publisher bundle binding differs');
   if(b.report.date!==report_date){requireThat(row.id!==request_id,'Original Publisher date differs');continue;}
   const binding={request_id:row.id,report_date,bundle_sha256:row.hash};publisher_day.push(binding);
   if(row.id===request_id){const detail=JSON.parse(row.detail);publisher={...binding,source_ts:row.source_ts,report_commit:detail.commit??null,...(detail.intake_file_id?{file_id:detail.intake_file_id}:{})};}
  }
  // A jobs-only local read cannot exclude unscanned Slack or pending durable
  // inbox entries. New admission uses the Publisher's native inspect protocol,
  // which waits for its scan watermark to cover the authenticated query.
  requireThat(publisher,'Fresh native inspect required to prove Publisher date absence');
  // Ensure no unmapped legacy edition can hide a claim for this date.
  budget();const meta=new Map(s.prepare("SELECT key,value FROM meta WHERE key LIKE 'notice_edition:%' OR key LIKE 'notice_edition_date:%' OR key LIKE 'notice_day:%'").all().map(r=>[r.key,r.value]));
  for(const [key,owner] of meta){budget();if(!key.startsWith('notice_edition:'))continue;
   const day=meta.get('notice_edition_date:'+key.split(':')[1]);requireThat(typeof day==='string'&&/^\d{4}-\d\d-\d\d$/.test(day),'Unreconciled legacy date claim');
   requireThat(s.prepare('SELECT 1 FROM requests WHERE id=?').get(owner),'Orphaned legacy request');
   const dayKey='notice_day:'+digest(JSON.stringify([scope.scheduler_team_id,scope.scheduler_channel_id,day]));requireThat(meta.has(dayKey),'Unreconciled legacy date claim');
  }
  const owner=meta.get('notice_day:'+digest(JSON.stringify([scope.scheduler_team_id,scope.scheduler_channel_id,report_date])));
  budget();const row=s.prepare('SELECT request_id,report_date,length(bundle) AS byte_length,typeof(bundle) AS byte_type FROM scheduled_notices WHERE report_date=? OR request_id=? LIMIT 2').all(report_date,request_id);
  requireThat(row.length<=1,'Ambiguous scheduler original/date binding');let scheduler_day_claim=null,scheduler=null;
  if(owner||row.length){
   requireThat(row.length===1&&row[0].request_id===owner&&row[0].report_date===report_date,'Existing legacy or conflicting date claim requires reconciliation');
   requireThat(row[0].byte_type==='blob'&&bounded(row[0].byte_length),'Bounded original scheduler bundle required');
   budget();const r=s.prepare('SELECT request_id,report_date,record,bundle,phase FROM scheduled_notices WHERE request_id=? AND report_date=?').get(row[0].request_id,row[0].report_date);
   requireThat(r&&r.request_id===row[0].request_id&&r.report_date===row[0].report_date&&r.bundle?.byteLength===row[0].byte_length,'Original scheduler snapshot changed');
   const record=JSON.parse(r.record),b=await decodeBundle(Buffer.from(r.bundle.buffer,r.bundle.byteOffset,r.bundle.byteLength));budget();
   requireThat(b.hash===record.bundle_sha256&&b.data.request_id===r.request_id&&b.report.date===report_date&&record.report_request_id===r.request_id&&record.report_date===report_date,'Scheduler bundle binding differs');
   scheduler_day_claim={request_id:r.request_id,report_date,bundle_sha256:b.hash,report_commit:record.report_commit};
   const status=s.prepare('SELECT status,parts_total,parts_sent FROM requests WHERE id=?').get(r.request_id);requireThat(status,'Original scheduler request absent');
   const parts=s.prepare('SELECT status FROM parts WHERE request_id=?').all(r.request_id),images=s.prepare('SELECT file_id,status,error_code AS error FROM image_parts WHERE request_id=? ORDER BY ordinal').all(r.request_id).map(row=>({...row}));
   requireThat(parts.length+images.length===status.parts_total&&parts.filter(p=>p.status==='sent').length+images.filter(p=>p.status==='sent').length===status.parts_sent,'Actual scheduler part counts differ');
   scheduler={...scheduler_day_claim,...status,phase:r.phase,images};
  }else requireThat(!s.prepare('SELECT 1 FROM requests WHERE id=?').get(request_id),'Existing request without scheduled date binding');
  budget();return {read_context:{publisher_scope_sha256:scope.publisher_scope_sha256,scheduler_scope_sha256:scope.scheduler_scope_sha256},observed_at,complete:true,publisher_day,publisher,scheduler_day_claim,scheduler};
 }finally{s?.close();p.close();}
}
