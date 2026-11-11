import {acceptReadCommand,canonicalRequestDate,requireThat} from './report-handoff.mjs';
import {digest} from './archive.mjs';
import {assertResearchControl,decodeResearchControl,executeResearchControl,preparePublicationCheck} from './research-control.mjs';
import {safeDiagnostic,recoveryDelay,isSlackWriteUnexecuted} from './handoff-recovery.mjs';
export function acceptResearchControl(message,config,now,window){
 if(!config.research_control)return null;
 const source=acceptReadCommand(message,config,'!ai-research control v2 ',/^!ai-research control v2 ([A-Za-z0-9+/]{1,16000}={0,2})$/,now,window);
 if(!source)return null;
 const bytes=Buffer.from(source.match[1],'base64');requireThat(bytes.toString('base64')===source.match[1],'Exact authority encoding required');
 const command=decodeResearchControl(bytes);
 requireThat(source.source_ts>=config.research_control.activation_ts&&canonicalRequestDate(command.request_id)>=config.research_control.first_report_date,'Authority command outside activation');
 return {source_ts:source.source_ts,command_id:command.command_id,hash:digest(bytes),bytes};
}
export function queueResearchControl(db,event){
 const prior=db.prepare('SELECT command_id,hash,bytes FROM research_control_events WHERE source_ts=?').get(event.source_ts);
 if(prior){requireThat(prior.command_id===event.command_id&&prior.hash===event.hash&&Buffer.from(prior.bytes).equals(event.bytes),'Original authority command changed');return;}
 if(db.prepare('SELECT count(*) n FROM research_control_events').get().n>=100000)return {source_ts:event.source_ts,stage:'research_control',code:'control_capacity',outcome:'not_started',retryable:false};
 db.prepare('INSERT INTO research_control_events(source_ts,command_id,hash,bytes) VALUES(?,?,?,?)').run(event.source_ts,event.command_id,event.hash,event.bytes);
}
export function pendingResearchControls(db){
 const rows=db.prepare("SELECT source_ts,command_id,phase,next_at,diagnostic,reply_text FROM research_control_events WHERE phase IN ('pending','ready','sending','unknown') ORDER BY source_ts").iterate();
 const blocked=[];
 for(const {diagnostic,reply_text,...row} of rows){
  let error=diagnostic?JSON.parse(diagnostic):null;
  if(['sending','unknown'].includes(row.phase)){
   const reply=reply_text?JSON.parse(reply_text.slice('!ai-research control-receipt '.length)):null;
   if(!reply?.dispatch_granted||!reply.operations?.some(op=>db.prepare('SELECT phase FROM research_control_ops WHERE operation_id=?').get(op.operation_id)?.phase==='intent'))continue;
   error??={stage:'research_control',code:'dispatch_receipt_unknown',outcome:'unknown',retryable:false};
  }
  if(error)blocked.push({...row,error});if(blocked.length===16)break;
 }
 return blocked;
}
export async function advanceResearchControl(state,config,slack,now=Date.now()){
 const db=state.db;if(!assertResearchControl(db,config))return;
 const row=db.prepare("SELECT * FROM research_control_events WHERE phase IN ('pending','ready') AND next_at<=? ORDER BY source_ts LIMIT 1").get(now);
 if(!row)return;
 try{
  if(row.phase==='pending'){
   const prepare=result=>{
    const text='!ai-research control-receipt '+JSON.stringify({source_ts:row.source_ts,...result});requireThat(Buffer.byteLength(text)<=16384,'Bounded control receipt required');
    db.prepare("UPDATE research_control_events SET phase='ready',reply_text=?,diagnostic=NULL WHERE source_ts=?").run(text,row.source_ts);
   };
   try{
    const bytes=Buffer.from(row.bytes),command=decodeResearchControl(bytes),publicationCheck=command.action==='permit'?await preparePublicationCheck(db,bytes):null;
    executeResearchControl(db,config,bytes,now,{onResult:prepare,publicationCheck});
   }catch(error){if(!error.researchControlCode)throw error;prepare({command_id:row.command_id,command_sha256:row.hash,status:'rejected',code:error.researchControlCode,dispatch_granted:false});}
  }
  let text=db.prepare('SELECT reply_text FROM research_control_events WHERE source_ts=?').get(row.source_ts).reply_text;
  const result=JSON.parse(text.slice('!ai-research control-receipt '.length));
  // A cooldown or delayed response cannot resurrect an expired dispatch grant.
  if(result.dispatch_granted){
   const run=db.prepare('SELECT owner_id,epoch,lease_until,permit,started_at,plan FROM research_control_runs WHERE request_id=?').get(result.request_id);
   const live=run&&run.owner_id===result.run.owner_id&&run.epoch===result.run.epoch&&run.lease_until>now&&result.run.lease_until>now&&result.operations.every(op=>{
    const original=db.prepare('SELECT phase,owner_id,epoch,kind FROM research_control_ops WHERE operation_id=?').get(op.operation_id);
    return original?.phase==='intent'&&(original.kind==='native'||run.permit===null&&now<run.started_at+JSON.parse(Buffer.from(run.plan)).limits.total_budget_seconds*1000);
   });
   if(!live){text='!ai-research control-receipt '+JSON.stringify({...result,dispatch_granted:false,grant_expired:true});db.prepare('UPDATE research_control_events SET reply_text=? WHERE source_ts=?').run(text,row.source_ts);}
  }
  slack.assertReady?.('chat.postMessage');db.prepare("UPDATE research_control_events SET phase='sending' WHERE source_ts=?").run(row.source_ts);
  try{
   const ts=await slack.controlReceipt(row.source_ts,text);requireThat(/^\d{10}\.\d{6}$/.test(ts),'Control receipt timestamp required');
   db.prepare("UPDATE research_control_events SET phase='sent',reply_ts=? WHERE source_ts=?").run(ts,row.source_ts);
  }catch(error){db.prepare('UPDATE research_control_events SET phase=? WHERE source_ts=?').run(isSlackWriteUnexecuted(error)?'ready':'unknown',row.source_ts);throw error;}
 }catch(error){
  const diagnostic=safeDiagnostic(error,'research_control');
  db.prepare('UPDATE research_control_events SET attempts=attempts+1,next_at=?,diagnostic=? WHERE source_ts=?').run(Math.max(now+recoveryDelay(row.attempts+1),diagnostic.retry_at??0),JSON.stringify(diagnostic),row.source_ts);
  return {source_ts:row.source_ts,...diagnostic};
 }
}
