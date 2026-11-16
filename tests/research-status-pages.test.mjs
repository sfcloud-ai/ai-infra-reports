import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {digest} from '../scripts/archive.mjs';
import {statusPart,readCompleteResearchStatus,STATUS_PART_BYTES} from '../scripts/research-status-pages.mjs';

function fixture(){
 const command={schema_version:'research_control_v2',command_id:randomUUID(),request_id:'morning-20261116-r1',action:'status',owner_id:null,epoch:0,expected_revision:0,args:{offset:0}};
 const bytes=Buffer.from(JSON.stringify(command));
 const result={command_id:command.command_id,command_sha256:digest(bytes),request_id:command.request_id,status:'observed',run:{revision:111},plan_base64:'x'.repeat(6000),operations:[{phase:'unknown',input:{url:'https://example.org/完整来源'}}],next_offset:1};
 const raw=Buffer.from(JSON.stringify(result));
 const next=(id,args)=>Buffer.from(JSON.stringify({...command,command_id:randomUUID(),request_id:id,action:'status_part',args}));
 return {command,bytes,result,raw,next};
}

test('status byte pages preserve the exact logical result and unknown operations',async()=>{
 const f=fixture();let calls=0;
 const read=async bytes=>{
  const command=JSON.parse(bytes);calls++;
  if(command.action==='status_part'){assert.equal(command.args.command_id,f.command.command_id);assert.equal(command.args.sha256,digest(f.raw));}
  return {source_ts:'1794792000.000001',...statusPart(f.raw,command.action==='status'?0:command.args.offset)};
 };
 const result=await readCompleteResearchStatus(f.bytes,read,f.next);
 assert.deepEqual(result,{source_ts:'1794792000.000001',...f.result});assert.equal(calls,Math.ceil(f.raw.length/STATUS_PART_BYTES));
});

test('status assembly rejects missing, repeated, reordered, substituted and tampered parts',async()=>{
 for(const mode of ['missing','repeat','offset','identity','snapshot','total','hash','bytes','next','grant']){
  const f=fixture();let count=0;
  await assert.rejects(readCompleteResearchStatus(f.bytes,async bytes=>{
   const command=JSON.parse(bytes),part=statusPart(f.raw,command.action==='status'?0:command.args.offset);count++;
   if(count===2){
    if(mode==='missing')return {status:'not_found'};
    if(mode==='repeat')return statusPart(f.raw,0);
    if(mode==='offset')part.status_part.offset++;
    if(mode==='identity')part.status_part.request_id='morning-20261117-r1';
    if(mode==='snapshot')part.status_part.sha256='a'.repeat(64);
    if(mode==='total')part.status_part.total_bytes++;
    if(mode==='hash')part.status_part.chunk_sha256='a'.repeat(64);
    if(mode==='bytes')part.status_part.content_base64=Buffer.from('changed').toString('base64');
    if(mode==='next')part.status_part.next_offset=null;
    if(mode==='grant')part.dispatch_granted=true;
   }
   return part;
  },f.next),undefined,mode);
 }
});

test('status snapshot never supplies write authority and replay remains visible',async()=>{
 const f=fixture();await assert.rejects(readCompleteResearchStatus(Buffer.from(JSON.stringify({...f.command,action:'reserve'})),async()=>statusPart(f.raw,0),f.next));
 const result=await readCompleteResearchStatus(f.bytes,async bytes=>{
  const c=JSON.parse(bytes);return {...statusPart(f.raw,c.action==='status'?0:c.args.offset),...(c.action==='status'?{replayed:true,dispatch_granted:false}:{})};
 },f.next);
 assert.equal(result.replayed,true);assert.equal(result.dispatch_granted,false);
 assert.throws(()=>statusPart(Buffer.from(JSON.stringify({...f.result,dispatch_granted:true})),0),/Read-only/);
});
