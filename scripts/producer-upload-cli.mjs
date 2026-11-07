// Trusted local operator bridge. Only --serve starts work. Native tools are
// caller-executed one-shot actions; this process implements the real raw POST.
// Stdin must come from the authenticated native-tool orchestrator, not a report
// or untrusted JSON file. Day admission evidence is read from pinned live SQLite
// databases or authenticated native tool replies, never a caller-provided
// verified flag or unbound JSON receipt.
import {readFile,open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createInterface} from 'node:readline';
import {ProducerInspect,producerInspectScope} from './producer-native-inspect.mjs';
import {ProducerUploadState,ProducerUploadAdapter,producerScope} from './producer-upload.mjs';
import {journalPath,verifyProducerJournal} from './producer-upload-journal.mjs';
import {uploadProducerBytes,readProducerLedgers} from './producer-upload-adapters.mjs';
import {requireThat} from './report-handoff.mjs';
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
let state,lines;
try{
 requireThat(process.argv.length===4&&['--initialize','--serve'].includes(process.argv[3]),'Usage: node scripts/producer-upload-cli.mjs OPERATOR_CONFIG.json --initialize|--serve');
 const initialize=process.argv[3]==='--initialize';
 const c=JSON.parse(await readFile(process.argv[2],'utf8'));
 const native=c&&Object.hasOwn(c,'native_inspect');
 requireThat(c&&Object.keys(c).sort().join()===(native?'bundle_file,native_inspect,scope,state_file':'bundle_file,publisher_database,scheduler_database,scope,state_file'),'Exact trusted operator configuration required');
 const inputs=native?[c.bundle_file]:[c.bundle_file,c.publisher_database,c.scheduler_database];
 requireThat([c.state_file,...inputs].every(p=>typeof p==='string'&&isAbsolute(p)),'Pinned absolute paths required');
 requireThat(new Set([c.state_file,...inputs]).size===inputs.length+1,'Producer journal and original ledgers must be separate files');
 producerScope(c.scope);if(native)producerInspectScope(c.native_inspect);
 const original=await journalPath(c.state_file,inputs);
 requireThat(initialize?!original:original,initialize?'Initial journal already exists; never reinitialize':'Original durable journal missing; never rebuild to replay');
 process.umask(0o077);
 if(initialize){
  const file=await open(c.state_file,'wx',0o600);await file.close();
  state=new ProducerUploadState(c.state_file,c.scope);
  if(native)new ProducerInspect(state,c.native_inspect);
  emit({type:'initialized',protocol:'producer_upload_v1',write_allowed:false});
 }else{
  const unchanged=await verifyProducerJournal(c.state_file,c.scope,native?c.native_inspect:null);
  // No mutable SQLite constructor runs until the complete original schema and
  // both scopes have passed read-only checks. Read bundle only in normal serve.
  const bytes=await readFile(c.bundle_file);
  await journalPath(c.state_file,inputs);await unchanged();
  state=new ProducerUploadState(c.state_file,c.scope);
  const inspect=native?new ProducerInspect(state,c.native_inspect):null;
  const ready=await state.prepare(bytes);
 lines=createInterface({input:process.stdin,crlfDelay:Infinity});const iterator=lines[Symbol.asyncIterator]();
 async function read(){const r=await iterator.next();requireThat(!r.done&&Buffer.byteLength(r.value)<=12*1024*1024,'Bounded trusted bridge input required');return JSON.parse(r.value);}
 const callTool=async(_tool,_args,action)=>{emit(action);const r=await read();requireThat(r.type==='native_result'&&r.operation_id===action.operation_id&&Object.hasOwn(r,'result'),'Original native result required');return r.result;};
 const adapter=new ProducerUploadAdapter(state,{
  callTool,
  upload:uploadProducerBytes
 });
 emit({type:'ready',protocol:'producer_upload_v1',...ready});
 while(true){
  const cmd=await read();
  if(cmd.type==='close'&&Object.keys(cmd).length===1)break;
  if(cmd.type==='restore_ticket'&&Object.keys(cmd).sort().join()==='result,type'){adapter.restoreTicket(ready.request_id,cmd.result);emit({type:'ticket_restored',request_id:ready.request_id});continue;}
  if(inspect&&['inspect_source_result','inspect_thread_result'].includes(cmd.type)&&Object.keys(cmd).sort().join()==='invocation,type'){
   try{emit(cmd.type==='inspect_source_result'?inspect.observeSource(ready.request_id,cmd.invocation):inspect.observeReceipt(ready.request_id,cmd.invocation));}
   catch{emit({type:'blocked',next_action:cmd.type==='inspect_source_result'?'locate_original_inspect':'read_inspect_thread',reason:'original_inspect_read_not_verified',write_allowed:false});}
   continue;
  }
  if(cmd.type==='source_result'&&Object.keys(cmd).sort().join()==='bytes_base64,evidence,type'){
   requireThat(typeof cmd.bytes_base64==='string','Actual source file bytes required');const bytes=Buffer.from(cmd.bytes_base64,'base64');requireThat(bytes.toString('base64')===cmd.bytes_base64,'Canonical actual file bytes required');
   emit({type:'state',...state.observeSource(ready.request_id,{...cmd.evidence,bytes})});continue;
  }
  requireThat(cmd.type==='tick'&&Object.keys(cmd).length===1,'Only tick, native result, original ticket restore, source result or close supported');
  const result=await adapter.step(ready.request_id);
  if(result.next_action==='read_original_publisher_scheduler'||inspect&&['reconcile_original_operation','read_original_file_and_share'].includes(result.next_action)){
   if(inspect){const action=inspect.next(ready.request_id);if(action.type==='write'){try{await callTool(action.tool,action.arguments,action);}catch{}emit({type:'inspect_pending',operation_id:action.operation_id,write_allowed:false});}else emit({...action,reconciliation:result});continue;}
   try{emit({type:'state',...state.observeDownstream(ready.request_id,await readProducerLedgers(c,result))});}
   catch{emit({...result,type:'blocked',reason:'original_ledger_read_unavailable_or_conflicting',write_allowed:false});}
  }else emit(result);
 }
 }
}catch(e){emit({type:'blocked',next_action:'reconcile_original_operation',reason:['producer_journal_schema_incompatible','producer_journal_scope_mismatch'].includes(e.code)?e.code:'producer_bridge_stopped',write_allowed:false});process.exitCode=1;}
finally{lines?.close();process.stdin.pause();state?.close();}
