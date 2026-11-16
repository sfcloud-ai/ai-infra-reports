// Status transport only: every chunk is still authenticated as one native reply.
import {digest} from './archive.mjs';
import {requireThat} from './report-handoff.mjs';

export const STATUS_PART_BYTES=2000,STATUS_RESULT_BYTES=16000,CONTROL_RECEIPT_BYTES=4000;
const exact=(value,keys)=>value&&Object.keys(value).sort().join()===keys.split(',').sort().join();
const HASH=/^[a-f0-9]{64}$/;

export function statusPart(bytes,offset){
 requireThat(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=STATUS_RESULT_BYTES,'Bounded original status bytes required');
 const original=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
 requireThat(['observed','not_found','rejected'].includes(original.status)&&!original.dispatch_granted,'Read-only status result required');
 requireThat(Number.isSafeInteger(offset)&&offset>=0&&offset<bytes.length&&offset%STATUS_PART_BYTES===0,'Status part offset required');
 const chunk=bytes.subarray(offset,offset+STATUS_PART_BYTES),end=offset+chunk.length;
 return {status:'status_part',status_part:{command_id:original.command_id,command_sha256:original.command_sha256,request_id:original.request_id,
  sha256:digest(bytes),total_bytes:bytes.length,offset,content_base64:chunk.toString('base64'),chunk_sha256:digest(chunk),next_offset:end<bytes.length?end:null}};
}

// Read immutable bytes from the original status command, never recompute its state.
export function storedStatusBytes(db,requestId,commandId){
 const row=db.prepare('SELECT bytes,result FROM research_control_commands WHERE request_id=? AND command_id=?').get(requestId,commandId);
 requireThat(row&&JSON.parse(Buffer.from(row.bytes)).action==='status','Original status command required');
 const bytes=Buffer.from(row.result),result=JSON.parse(row.result);
 requireThat(result.command_id===commandId&&result.command_sha256===digest(Buffer.from(row.bytes))&&result.request_id===requestId,'Stored status binding differs');
 return bytes;
}

export function boundedStatusReply(db,command,result){
 const bytes=storedStatusBytes(db,command.request_id,command.command_id);
 return {command_id:result.command_id,command_sha256:result.command_sha256,request_id:result.request_id,...statusPart(bytes,0),...(result.replayed?{replayed:true,dispatch_granted:false}:{})};
}

// `read` verifies each untouched native tool envelope before returning its data.
// Only logical status bytes are assembled; tool results are never reconstructed.
export async function readCompleteResearchStatus(commandBytes,read,makePartCommand){
 const command=JSON.parse(commandBytes),first=await read(commandBytes);
 if(command.action==='status_part')return first;
 if(first.status!=='status_part')return first;
 requireThat(command.action==='status','Status parts cannot grant an operation');
 const parts=[];let result=first,offset=0,binding=null;
 for(let count=0;count<Math.ceil(STATUS_RESULT_BYTES/STATUS_PART_BYTES);count++){
  const part=result.status_part;
  requireThat(result.status==='status_part'&&!result.dispatch_granted&&exact(part,'command_id,command_sha256,request_id,sha256,total_bytes,offset,content_base64,chunk_sha256,next_offset'),'Exact status part required');
  requireThat(part.command_id===command.command_id&&part.command_sha256===digest(commandBytes)&&part.request_id===command.request_id,'Original status part identity differs');
  requireThat(HASH.test(part.sha256)&&HASH.test(part.chunk_sha256)&&Number.isSafeInteger(part.total_bytes)&&part.total_bytes>0&&part.total_bytes<=STATUS_RESULT_BYTES&&part.offset===offset,'Status part bounds differ');
  const identity=JSON.stringify([part.command_id,part.command_sha256,part.request_id,part.sha256,part.total_bytes]);
  requireThat(binding===null||binding===identity,'Status snapshot changed between parts');binding=identity;
  requireThat(typeof part.content_base64==='string','Status part encoding required');
  const chunk=Buffer.from(part.content_base64,'base64'),end=offset+chunk.length;
  requireThat(chunk.toString('base64')===part.content_base64&&chunk.length===Math.min(STATUS_PART_BYTES,part.total_bytes-offset)&&digest(chunk)===part.chunk_sha256,'Status part bytes differ');
  requireThat(part.next_offset===(end<part.total_bytes?end:null),'Status part continuation differs');parts.push(chunk);
  if(part.next_offset===null){
   const bytes=Buffer.concat(parts);requireThat(bytes.length===part.total_bytes&&digest(bytes)===part.sha256,'Complete status hash differs');
   const original=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
   requireThat(original.command_id===command.command_id&&original.command_sha256===digest(commandBytes)&&original.request_id===command.request_id&&['observed','not_found','rejected'].includes(original.status)&&!original.dispatch_granted,'Complete read-only status binding differs');
   return {source_ts:first.source_ts,...original,...(first.replayed?{replayed:true,dispatch_granted:false}:{})};
  }
  offset=part.next_offset;result=await read(makePartCommand(command.request_id,{command_id:command.command_id,sha256:part.sha256,offset}));
 }
 throw Error('Incomplete status result');
}
