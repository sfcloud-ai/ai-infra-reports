import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {digest} from '../scripts/archive.mjs';
import {encodeBundle} from '../scripts/report-handoff.mjs';
import {ProducerUploadState,producerTicket,READ_TTL_MS} from '../scripts/producer-upload.mjs';
import {verifyProducerJournal} from '../scripts/producer-upload-journal.mjs';
import {requireOriginalRunnerLock} from '../scripts/producer-recovery-lock.mjs';
import {FILES,BASE,PROMPTS,SCOPE as OLD,ID,DAY,TARGET} from './helpers/cloud-sender-fixture.mjs';
const scope={team_id:OLD.team_id,channel_id:OLD.channel_id,sender_user_id:OLD.sender_user_id,sender_user_app_id:OLD.sender_user_app_id,sender_attribution_text:OLD.sender_attribution_text,publisher_scope_sha256:'a'.repeat(64),scheduler_scope_sha256:'b'.repeat(64),scheduler_team_id:'T123',scheduler_channel_id:'D123'};
process.umask(0o077);
const bytes=await encodeBundle(FILES,ID,BASE,PROMPTS.commit),hash=digest(bytes),ticket={file_id:'FOLD',upload_url:'https://files.slack.com/upload/v1/OLD'},safe=producerTicket(ticket);
const failure={curl_exit:6,http_status:0,num_connects:0,num_redirects:0,upload_bytes:0,response_bytes:0,header_bytes:0,time_namelookup:0,time_connect:0,time_appconnect:0,time_starttransfer:0,ssl_verify_result:0,response_sha256:null};
const authorization={authorization_reference:'user:confirmed-recovery',file_id:ticket.file_id,url_sha256:safe.url_sha256,bundle_sha256:hash};
const evidence=now=>({read_context:{publisher_scope_sha256:scope.publisher_scope_sha256,scheduler_scope_sha256:scope.scheduler_scope_sha256},observed_at:now,complete:true,publisher_day:[],publisher:null,scheduler_day_claim:null,scheduler:null});
const post=(m=failure,file=safe,adapter='producer_curl_direct_v1')=>({adapter,file_id:file.file_id,url_sha256:file.url_sha256,bundle_sha256:hash,metrics:m});
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'explicit-recovery-')),file=join(dir,'state.sqlite');let time=TARGET;const s=new ProducerUploadState(file,scope,{now:()=>time});try{await chmod(file,0o600);await s.prepare(bytes);s.observeDownstream(ID,evidence(time));s.record(s.next(ID),ticket);s.observeDownstream(ID,evidence(time));s.record(s.next(ID),post());s.observeDownstream(ID,evidence(time));await fn(s,{dir,file,now:()=>time,advance:n=>time+=n});}finally{s.close();await rm(dir,{recursive:true,force:true});}}
const ops=s=>JSON.stringify(s.db.prepare('SELECT * FROM producer_ops WHERE run_id=? AND name NOT LIKE ? ORDER BY name,attempt').all(ID,'recovery_%'));
test('explicit recovery preserves original bytes/operations, consumes proof and dispatches one successor ticket',()=>fixture(async(s,c)=>{
 const originalOps=ops(s),originalBundle=s.get(ID).bundle,originalDetail=s.get(ID).detail;
 const grant=s.authorizeTicketRecovery(ID,authorization);assert.equal(grant.write_allowed,false);assert.equal(s.next(ID).type,'read');assert.deepEqual(s.get(ID).bundle,originalBundle);assert.equal(ops(s),originalOps);
 const audit=s.db.prepare('SELECT * FROM producer_recovery_audit').get();assert.deepEqual(JSON.parse(audit.original).detail,originalDetail);
 assert.throws(()=>s.authorizeTicketRecovery(ID,authorization));s.observeDownstream(ID,evidence(c.now()));const a=s.next(ID);assert.equal(a.next_action,'ticket');assert.equal(a.attempt,1);assert.equal(s.next(ID).write_allowed,false);
 assert.throws(()=>s.authorizeTicketRecovery(ID,authorization));assert.equal(s.activeOp(ID,'ticket').phase,'unknown');assert.equal(s.op(ID,'ticket').phase,'confirmed');
 s.record(a,{file_id:'FNEW',upload_url:'https://files.slack.com/upload/v1/NEW'});s.observeDownstream(ID,evidence(c.now()));const upload=s.next(ID);assert.equal(upload.file_id,'FNEW');assert.equal(upload.next_action,'post');assert.equal(ops(s),originalOps);
 s.record(upload,post(failure,producerTicket({file_id:'FNEW',upload_url:'https://files.slack.com/upload/v1/NEW'}),'producer_curl_managed_proxy_v1'));assert.equal(s.activeOp(ID,'post').phase,'unknown');assert.equal(s.next(ID).write_allowed,false);
 assert.equal(ops(s),originalOps);const unchanged=await verifyProducerJournal(c.file,scope,null);await unchanged();
}));
test('unknown, confirmed or malformed original POST anywhere prevents recovery',async()=>{
 for(const phase of ['unknown','confirmed','not_executed'])await fixture(async(s,c)=>{
  if(phase==='not_executed')s.db.prepare("UPDATE producer_ops SET result=? WHERE name='post'").run(JSON.stringify(post({...failure,curl_exit:28})));
  else s.db.prepare("UPDATE producer_ops SET phase=? WHERE name='post'").run(phase);
  // A later proven failure must not hide an earlier uncertain operation.
  s.db.prepare("INSERT INTO producer_ops VALUES(?,'post',2,'later','not_executed',?,?)").run(ID,c.now(),JSON.stringify(post()));
  assert.throws(()=>s.authorizeTicketRecovery(ID,authorization),/Every original POST/);assert.equal(s.db.prepare("SELECT 1 FROM sqlite_master WHERE name='producer_recovery_audit'").get(),undefined);
 });
});
test('any completion intent, wrong binding, consumed or stale proof rejects before migration',async()=>{
 for(const kind of ['complete','binding','consumed','stale'])await fixture(async(s,c)=>{
  if(kind==='complete')s.db.prepare("INSERT INTO producer_ops VALUES(?,'complete',1,'unsafe','unknown',?,NULL)").run(ID,c.now());
  if(kind==='consumed')s.save(s.get(ID),{...s.get(ID).detail,preflight_at:null});
  if(kind==='stale')c.advance(READ_TTL_MS);
  assert.throws(()=>s.authorizeTicketRecovery(ID,kind==='binding'?{...authorization,file_id:'FWRONG'}:authorization));
 });
});
test('immutable audit and SQL dispatch fence reject stale original writers',()=>fixture(async(s,c)=>{
 const old=new ProducerUploadState(c.file,scope,{now:c.now});try{
  const original=ops(s);s.authorizeTicketRecovery(ID,authorization);
  for(const sql of ["DELETE FROM producer_recovery_audit","UPDATE producer_recovery_audit SET authorization_reference='changed'","DELETE FROM producer_ops","UPDATE producer_ops SET phase='confirmed' WHERE name='post'","INSERT INTO producer_ops VALUES('"+ID+"','post',2,'old-dispatch','unknown',1,NULL)","UPDATE producer_runs SET hash='different'","DELETE FROM producer_runs"] )assert.throws(()=>old.db.exec(sql));
  assert.equal(ops(s),original);assert.throws(()=>old.authorizeTicketRecovery(ID,authorization));
 }finally{old.close();}
}));
test('original flock must actually be inherited, not asserted by operator input',()=>fixture(async(s,c)=>{
 const lock=join(c.dir,'runner.lock');await writeFile(lock,'',{mode:0o600});await assert.rejects(requireOriginalRunnerLock(c.file),/inherit/);
 const code=`import {requireOriginalRunnerLock} from './scripts/producer-recovery-lock.mjs'; await requireOriginalRunnerLock(${JSON.stringify(c.file)});`;
 const good=spawnSync('flock',['-n',lock,process.execPath,'--input-type=module','-e',code],{encoding:'utf8'});assert.equal(good.status,0,good.stderr);
 const bad=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8'});assert.notEqual(bad.status,0);
}));
test('recovery namespace survives restart and cannot renew a lost successor ticket',()=>fixture(async(s,c)=>{
 s.authorizeTicketRecovery(ID,authorization);s.observeDownstream(ID,evidence(c.now()));const a=s.next(ID);assert.equal(a.next_action,'ticket');
 const restart=new ProducerUploadState(c.file,scope,{now:c.now});try{assert.equal(restart.next(ID).write_allowed,false);assert.equal(restart.activeOp(ID,'ticket').operation_id,a.operation_id);assert.throws(()=>restart.authorizeTicketRecovery(ID,authorization));assert.equal(restart.db.prepare('SELECT COUNT(*) n FROM producer_recovery_audit').get().n,1);}finally{restart.close();}
}));
test('one recovery per request reuses verified schema for a different original date',()=>fixture(async(s,c)=>{
 s.authorizeTicketRecovery(ID,authorization);
 const day='2026-11-02',id='second-day',files=new Map([...FILES].map(([p,b])=>[p.replaceAll(DAY,day),p.endsWith('report.json')?Buffer.from(JSON.stringify({...JSON.parse(b),date:day})):b]));
 const b=await encodeBundle(files,id,BASE,PROMPTS.commit),h=digest(b);await s.prepare(b);s.observeDownstream(id,evidence(c.now()));s.record(s.next(id),ticket);s.observeDownstream(id,evidence(c.now()));s.record(s.next(id),{...post(),bundle_sha256:h});s.observeDownstream(id,evidence(c.now()));s.authorizeTicketRecovery(id,{...authorization,bundle_sha256:h});assert.equal(s.db.prepare('SELECT COUNT(*) n FROM producer_recovery_audit').get().n,2);
}));
