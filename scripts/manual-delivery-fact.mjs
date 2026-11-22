import {closeSync,constants,fstatSync,openSync,readSync} from 'node:fs';
import {digest} from './archive.mjs';
import {handoffScope,scopeDigest} from './handoff-state.mjs';

const path='/etc/ai-report-original-20261121.fact';
const checksum='024b023177d9edabc8098319bb41aaa6385ee72d9dbfd0879f2953f595d3613e';
const originalIdentity='8ea260677875fb42589ead9692957fd049332f71db27fe74d69af0c4c3b22973';
const requestId='morning-20261121-r1';

function readFact(){
 let fd;
 try{
  fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const info=fstatSync(fd);
  if(!info.isFile()||info.uid!==0||info.gid!==process.getgid()||info.nlink!==1||
     (info.mode&0o7777)!==0o440||info.size<=0||info.size>4096)return null;
  const bytes=Buffer.alloc(4097);
  const count=readSync(fd,bytes,0,bytes.length,null);
  const raw=bytes.subarray(0,count);
  return count===info.size&&digest(raw)===checksum?JSON.parse(raw):null;
 }catch{return null;}
 finally{if(fd!==undefined)closeSync(fd);}
}

export function isOriginalManualRequest(state,config,job,date){
 if(job?.id!==requestId||!config.scheduled_delivery)return false;
 const scope=scopeDigest(handoffScope(config));
 if(state.db.prepare('SELECT value FROM scope WHERE id=1').get()?.value!==scope)return false;
 const proof=job.detail.proof;
 if(proof?.publication_status!=='verified'||proof.request_id!==job.id||
    proof.commit!==job.detail.commit||proof.bundle_sha256!==job.hash||digest(job.bytes)!==job.hash)return false;
 const identity=[scope,scopeDigest(config.scheduled_delivery),job.id,date,job.detail.commit,job.hash,
                 digest(Buffer.from(job.source_ts)),job.detail.pr,job.detail.head,proof.edition,proof.poster_sha256];
 return digest(JSON.stringify(identity))===originalIdentity;
}

export function originalManualDelivery(state,config,id,local){
 if(id!==requestId)return null;
 const fact=readFact();
 if(!fact)return null;
 const {observation,publisher,edition}=fact;
 if(!config.scheduled_delivery||scopeDigest(config.scheduled_delivery)!==publisher.scheduled_scope_sha256)return null;
 if(local===undefined){
  if(!state.db.prepare("SELECT 1 FROM sqlite_master WHERE name='scheduled_handoffs' AND type='table'").get())return null;
  local=state.db.prepare('SELECT binding,phase,result FROM scheduled_handoffs WHERE request_id=?').get(id);
 }
 if(local?.phase!=='admission_pending')return null;
 let binding,result;
 try{binding=JSON.parse(local.binding);result=JSON.parse(local.result);}catch{return null;}
 const keys=['request_id','report_date','report_commit','bundle_sha256'];
 const error=result?.diagnostic;
 if(!binding||Object.keys(binding).length!==keys.length||keys.some(k=>binding[k]!==observation[k])||
    result?.request_id!==id||Object.keys(result).length!==2||Object.keys(error??{}).length!==4||
    error?.stage!=='scheduled_delivery'||error.code!=='unclassified'||error.outcome!=='unknown'||error.retryable!==false||
    state.db.prepare('SELECT value FROM scheduled_bridge_scope WHERE id=1').get()?.value!==publisher.scheduled_scope_sha256)return null;
 const job=state.get(id),proof=job?.detail.proof;
 if(!isOriginalManualRequest(state,config,job,binding.report_date))return null;
 if(job?.phase!=='receipt_sent'||job.hash!==observation.bundle_sha256||digest(job.bytes)!==observation.bundle_sha256||
    digest(Buffer.from(job.source_ts))!==publisher.source_ts_sha256||job.detail.pr!==publisher.pr||
    job.detail.head!==publisher.head||job.detail.commit!==observation.report_commit||
    proof?.publication_status!=='verified'||proof.edition!==edition||proof.request_id!==id||
    proof.commit!==observation.report_commit||proof.bundle_sha256!==observation.bundle_sha256||
    proof.poster_sha256!==observation.poster_sha256)return null;
 return observation;
}
