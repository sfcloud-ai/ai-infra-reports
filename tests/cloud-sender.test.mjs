import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {digest} from '../scripts/archive.mjs';
import {CloudRunState,CloudSender,pinPrompts,prepareCloudRun,prepareNoSelection,ReadPending,ReconciliationRequired,PREFLIGHT_REFRESH_MS} from '../scripts/cloud-sender.mjs';
import {rig,toClaim,arm,send,ID,TARGET,DAY,BASE,SCOPE,PROMPTS,FILES} from './helpers/cloud-sender-fixture.mjs';

async function inRig(run,options){const r=await rig(options);try{return await run(r);}finally{r.close();}}
const rejected=fn=>assert.rejects(fn);

test('delivery deadlines reject ambiguous dates and normalize equivalent explicit instants',async()=>{
 const state=new CloudRunState(':memory:',SCOPE);
 try{
  for(const not_before of ['2026-11-01T08:00:00','2026-11-01','11/01/2026 08:00:00','2026-02-30T00:00:00Z','2026-11-01T24:00:00Z','2026-11-01T08:00:00+99:00']){
   await rejected(()=>prepareCloudRun(state,{id:ID,files:FILES,base:BASE,prompts:PROMPTS,not_before}));assert.equal(state.get(ID),null);
  }
  for(const not_before of ['2026-11-01T08:00:00+08:00','2026-11-01T00:00:00Z','2026-11-01T00:00:00.000Z']){
   const row=await prepareCloudRun(state,{id:ID,files:FILES,base:BASE,prompts:PROMPTS,not_before});assert.equal(row.detail.not_before,new Date(TARGET).toISOString());
  }
 }finally{state.close();}
});
test('persisted deadline keeps its UTC boundary across processes with different timezones',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'cloud-timezone-')),filename=join(directory,'state.sqlite'),target=Date.parse('2026-11-01T08:00:00Z');
 const common=`import {CloudRunState,prepareCloudRun,ReadPending} from './scripts/cloud-sender.mjs';import {rig,arm,ID,FILES,BASE,PROMPTS,SCOPE} from './tests/helpers/cloud-sender-fixture.mjs';import assert from 'node:assert/strict';`;
 try{
  const prepare=spawnSync(process.execPath,['--input-type=module','-e',common+`const state=new CloudRunState(${JSON.stringify(filename)},SCOPE);await prepareCloudRun(state,{id:ID,files:FILES,base:BASE,prompts:PROMPTS,not_before:'2026-11-01T16:00:00+08:00'});state.close();`],{encoding:'utf8',env:{...process.env,TZ:'UTC'}});assert.equal(prepare.status,0,prepare.stderr);
  const consume=spawnSync(process.execPath,['--input-type=module','-e',common+`const target=${target},r=await rig({filename:${JSON.stringify(filename)},start:target-30000,target});try{await arm(r);await assert.rejects(()=>r.sender.step(ID),ReadPending);assert.equal(r.counts.poster,1);assert.equal(r.counts.complete,0);r.advance(30000);await r.sender.step(ID);console.log(JSON.stringify({not_before:r.state.get(ID).detail.not_before,complete_utc:r.calls.find(c=>c.name==='completeFinalUpload').utc,count:r.counts.complete}));}finally{r.close();}`],{encoding:'utf8',env:{...process.env,TZ:'Asia/Shanghai'}});assert.equal(consume.status,0,consume.stderr);assert.deepEqual(JSON.parse(consume.stdout),{not_before:'2026-11-01T08:00:00.000Z',complete_utc:target,count:1});
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('legacy noncanonical stored deadlines fail before any adapter call',()=>inRig(async r=>{
 const row=r.state.get(ID);r.state.move(ID,'prepared','prepared',{...row.detail,not_before:'2026-11-01T08:00:00'});
 await rejected(()=>r.sender.step(ID));assert.equal(r.calls.length,0);assert.deepEqual(r.counts,{control:0,poster:0,complete:0});
}));
test('G-prefixed private control channels preserve the existing Publisher contract',()=>inRig(async r=>{
 await send(r);await r.sender.step(ID);assert.equal(r.state.get(ID).phase,'sender_reported');assert.equal(r.outbox.notice(ID).phase,'sender_reported');assert.equal(r.counts.complete,1);
},{scope:{...SCOPE,channel_id:'G123'}}));

test('prompt resolution is fresh, same-commit, byte-preserving and fail closed',async()=>{
 const calls=[];let main=0;const io={readPromptMain:async()=>{calls.push('main');return (++main===1?'a':'b').repeat(40);},readPrompt:async(sha,name)=>{calls.push([sha,name]);return Buffer.from('你好 '+name);}};
 const a=await pinPrompts(io),b=await pinPrompts(io);assert.notEqual(a.commit,b.commit);assert.deepEqual(calls.slice(1,3),[['a'.repeat(40),'research.md'],['a'.repeat(40),'editor.md']]);assert.equal(a.prompts['research.md'].sha256,digest(Buffer.from('你好 research.md')));
 await rejected(()=>pinPrompts({...io,readPrompt:async()=>null}));await rejected(()=>pinPrompts({...io,readPrompt:async()=>Buffer.from([0xff])}));
});
test('happy path uses real outbox grant and record, preserving separate WeCom status',()=>inRig(async r=>{
 for(let n=0;n<8&&r.state.get(ID).phase!=='sender_reported';n++)await r.sender.step(ID);
 assert.equal(r.state.get(ID).phase,'sender_reported');assert.equal(r.state.get(ID).detail.wecom_status,'not_checked');assert.equal(r.outbox.notice(ID).phase,'sender_reported');assert.deepEqual(r.counts,{control:4,poster:1,complete:1});
 await r.sender.step(ID);assert.equal(r.counts.complete,1);assert.equal(JSON.stringify(r.state.op(ID,'poster_upload')).includes('signed_url'),false);assert.equal(r.state.op(ID,'publish').result,null);
}));
test('immutable run input and unique edition reject changed prompt, base, timing and ID',()=>inRig(async r=>{
 for(const change of [{base:'f'.repeat(40)},{not_before:new Date(TARGET+1).toISOString()},{id:'different-edition-request'},{prompts:{...PROMPTS,commit:'e'.repeat(40)}}])await rejected(()=>prepareCloudRun(r.state,{id:ID,files:FILES,base:BASE,prompts:PROMPTS,not_before:new Date(TARGET).toISOString(),...change}));
}));
test('durable scope cannot silently change notification destination or transport identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cloud-scope-')),filename=join(dir,'state.sqlite');const r=await rig({filename});try{assert.throws(()=>new CloudRunState(filename,{...SCOPE,notification_destination:'DOTHER'}));assert.throws(()=>new CloudRunState(filename,{...SCOPE,transport_profile:{...SCOPE.transport_profile,evidence_id:'different'}}));}finally{r.close();await rm(dir,{recursive:true,force:true});}
});
test('lost control acknowledgment is reconciled from actual bytes without another upload',()=>inRig(async r=>{r.modes.controlTimeout=true;await r.sender.step(ID);assert.equal(r.state.get(ID).phase,'publication_wait');assert.equal(r.state.op(ID,'publish').phase,'unknown');assert.equal(r.counts.control,1);}));
test('unknown absent control write cannot be retried by a new execution',()=>inRig(async r=>{r.modes.controlMissing=true;await rejected(()=>r.sender.step(ID));r.modes.controlMissing=false;await rejected(()=>r.makeSender().step(ID));assert.equal(r.counts.control,1);assert.equal(r.state.get(ID).phase,'prepared');}));
test('transient history read failure preserves the original operation for read-only retry',()=>inRig(async r=>{r.modes.controlReadError=true;await rejected(()=>r.sender.step(ID));r.modes.controlReadError=false;await r.sender.step(ID);assert.equal(r.counts.control,1);assert.equal(r.state.get(ID).phase,'publication_wait');}));
test('old original control history can reconcile without replaying intake',()=>inRig(async r=>{r.modes.controlReadError=true;await rejected(()=>r.sender.step(ID));r.modes.controlReadError=false;r.advance(86400000);await r.makeSender().step(ID);assert.equal(r.counts.control,1);assert.equal(r.state.get(ID).phase,'publication_wait');}));
test('control identity, read context, original bytes and native blocks are all required',async()=>{
 for(const change of [e=>e.complete=false,e=>e.read_context.channel_id='COTHER',e=>e.file.user='UOTHER',e=>e.file.size++,e=>e.bytes=Buffer.from('different'),e=>e.message.blocks[0].elements[0].elements[0].text='different'])await inRig(async r=>{r.modes.controlReadError=true;await rejected(()=>r.sender.step(ID));r.modes.controlReadError=false;change(r.controls.get(ID));await rejected(()=>r.sender.step(ID));assert.equal(r.state.get(ID).phase,'prepared');assert.equal(r.counts.control,1);});
});
test('publication read failure or publisher impersonation never starts poster upload',async()=>{
 await inRig(async r=>{await r.sender.step(ID);r.modes.publicationReadError=true;await rejected(()=>r.sender.step(ID));assert.equal(r.counts.poster,0);});
 await inRig(async r=>{await r.sender.step(ID);r.replies.values().next().value.message.bot_id='BOTHER';await rejected(()=>r.sender.step(ID));assert.equal(r.counts.poster,0);});
});
test('actual public proof and scheduled transport remain required before poster preparation',async()=>{
 for(const fault of ['pagesUnavailable','unverifiedTransport'])await inRig(async r=>{await r.sender.step(ID);await r.sender.step(ID);r.modes[fault]=true;await rejected(()=>r.sender.step(ID));assert.equal(r.counts.poster,0);assert.equal(r.counts.complete,0);});
});
test('unshared poster upload uncertainty never allocates a replacement file',()=>inRig(async r=>{await r.sender.step(ID);await r.sender.step(ID);r.modes.posterUnknown=true;await rejected(()=>r.sender.step(ID));r.modes.posterUnknown=false;await rejected(()=>r.sender.step(ID));assert.equal(r.counts.poster,1);assert.equal(r.counts.complete,0);}));
test('grant reads can retry without repeating the claim write',()=>inRig(async r=>{await toClaim(r);r.modes.grantPending=true;await assert.rejects(()=>r.sender.step(ID),ReadPending);r.modes.grantPending=false;await r.sender.step(ID);await r.sender.step(ID);assert.equal(r.counts.complete,1);assert.equal(r.claimCount(),1);}));
test('restart before completion intent can verify the original claim and start once',()=>inRig(async r=>{await toClaim(r);r.modes.grantPending=true;await rejected(()=>r.sender.step(ID));r.modes.grantPending=false;const restarted=r.makeSender();await restarted.step(ID);await restarted.step(ID);assert.equal(r.counts.complete,1);assert.equal(r.claimCount(),1);assert.equal(r.state.get(ID).phase,'final_pending');}));

test('concurrent consumers share one durable first completion',()=>inRig(async r=>{await toClaim(r);const second=r.makeSender();await Promise.allSettled([r.sender.step(ID),second.step(ID)]);await Promise.allSettled([r.sender.step(ID),second.step(ID)]);assert.equal(r.counts.complete,1);assert.equal(r.claimCount(),1);}));
test('unknown final completion with actual delivery reconciles and records without resend',()=>inRig(async r=>{r.modes.finalTimeout=true;await send(r);assert.equal(r.state.op(ID,'final_complete').phase,'unknown');await r.makeSender().step(ID);assert.equal(r.state.get(ID).phase,'sender_reported');assert.equal(r.counts.complete,1);assert.equal(r.counts.poster,1);}));
test('unknown final completion with no message stays unresolved without retries',()=>inRig(async r=>{r.modes.finalTimeout=true;r.modes.finalMissing=true;await send(r);for(let i=0;i<3;i++)await rejected(()=>r.sender.step(ID));assert.equal(r.counts.complete,1);assert.equal(r.counts.poster,1);assert.equal(r.claimCount(),1);}));
test('final DM read, checker, or byte mismatch cannot authorize another send',async()=>{
 for(const fault of ['finalReadError','checkerError','posterMismatch'])await inRig(async r=>{await send(r);r.modes[fault]=true;await rejected(()=>r.sender.step(ID));assert.equal(r.counts.complete,1);assert.equal(r.counts.poster,1);assert.equal(r.state.get(ID).phase,'final_pending');});
});
test('zero-selection stores the precise reason but is explicitly not sent',async()=>{
 const state=new CloudRunState(':memory:',SCOPE);try{prepareNoSelection(state,{id:'zero-cloud-report',date:DAY,prompts:PROMPTS,reason:'source_access_failure',search_scope:['arXiv 72h and official repositories 7d; source request failed']});const sender=new CloudSender(state,new Proxy({}, {get(){assert.fail('zero branch cannot invoke transport');}}));const row=await sender.step('zero-cloud-report');assert.equal(row.phase,'zero_selection_blocked');assert.equal(row.detail.delivery_status,'not_sent');assert.equal(row.detail.reason,'source_access_failure');}finally{state.close();}
});
test('SQLite reopen retains unknown completion intent and original message binding',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cloud-reopen-')),filename=join(dir,'state.sqlite');const r=await rig({filename});let reopened;try{r.modes.finalTimeout=true;await send(r);r.state.close();reopened=new CloudRunState(filename,SCOPE);await r.makeSender(reopened).step(ID);assert.equal(reopened.get(ID).phase,'sender_reported');assert.equal(r.counts.complete,1);}finally{reopened?.close();r.publisher.close();await rm(dir,{recursive:true,force:true});}
});
test('two separate database connections still permit only one final completion',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cloud-two-connections-')),filename=join(dir,'state.sqlite');const r=await rig({filename}),other=new CloudRunState(filename,SCOPE);try{await toClaim(r);const second=r.makeSender(other);await Promise.allSettled([r.sender.step(ID),second.step(ID)]);await Promise.allSettled([r.sender.step(ID),second.step(ID)]);assert.equal(r.counts.complete,1);assert.equal(r.claimCount(),1);}finally{other.close();r.close();await rm(dir,{recursive:true,force:true});}
});
test('process death after durable completion fence cannot resume the missing write',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cloud-process-crash-')),filename=join(dir,'state.sqlite');const r=await rig({filename});let reopened;try{await arm(r);r.state.close();const code=`import {CloudRunState} from './scripts/cloud-sender.mjs';const s=new CloudRunState(${JSON.stringify(filename)},${JSON.stringify(SCOPE)});const j=s.get(${JSON.stringify(ID)});s.beginCompletion(j,{file_id:j.detail.file_id,text_sha256:'test'},()=>{});process.exit(29);`;const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8'});assert.equal(child.status,29,child.stderr);reopened=new CloudRunState(filename,SCOPE);await rejected(()=>r.makeSender(reopened).step(ID));assert.equal(r.counts.complete,0);assert.equal(reopened.get(ID).phase,'final_pending');}finally{reopened?.close();r.publisher.close();await rm(dir,{recursive:true,force:true});}
});
test('process death after control intent never reissues the unknown upload',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cloud-control-crash-')),filename=join(dir,'state.sqlite');const r=await rig({filename});let reopened;try{const input={kind:'publish',hash:r.bundle.hash,commandId:ID};r.state.close();const code=`import {CloudRunState} from './scripts/cloud-sender.mjs';const s=new CloudRunState(${JSON.stringify(filename)},${JSON.stringify(SCOPE)});s.begin(${JSON.stringify(ID)},'publish',${JSON.stringify(input)});process.exit(30);`;const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8'});assert.equal(child.status,30,child.stderr);reopened=new CloudRunState(filename,SCOPE);await rejected(()=>r.makeSender(reopened).step(ID));assert.equal(r.counts.control,0);}finally{reopened?.close();r.publisher.close();await rm(dir,{recursive:true,force:true});}
});
test('pre-send publication failure can recover after restart without duplicate claim',()=>inRig(async r=>{await arm(r);r.modes.pagesUnavailable=true;await rejected(()=>r.sender.step(ID));assert.equal(r.state.get(ID).phase,'final_ready');assert.equal(r.state.op(ID,'final_complete'),null);r.modes.pagesUnavailable=false;await r.makeSender().step(ID);assert.equal(r.counts.complete,1);assert.equal(r.claimCount(),1);}));

test('spoofed or mismatched grant cannot authorize final completion',async()=>{
 for(const change of [e=>e.message.bot_id='BOTHER',e=>{const p=JSON.parse(e.message.text.slice('!ai-notice receipt '.length));p.send_authorized=false;e.message.text='!ai-notice receipt '+JSON.stringify(p);},e=>{const p=JSON.parse(e.message.text.slice('!ai-notice receipt '.length));p.notice.detail.text_sha256='0'.repeat(64);e.message.text='!ai-notice receipt '+JSON.stringify(p);},e=>e.read_context.channel_id='COTHER'])await inRig(async r=>{await toClaim(r);r.modes.grantPending=true;await rejected(()=>r.sender.step(ID));r.modes.grantPending=false;const claim=[...r.controls.values()].find(e=>JSON.parse(e.bytes).action==='claim');change(r.replies.get(claim.message.ts));await rejected(()=>r.sender.step(ID));assert.equal(r.counts.complete,0);assert.equal(r.claimCount(),1);});
});
test('incomplete or wrong-destination actual-message read cannot be recorded',async()=>{
 for(const change of [e=>e.complete=false,e=>e.read_context.channel_id='DOTHER'])await inRig(async r=>{await send(r);const read=r.io.readFinalByFile;r.io.readFinalByFile=async args=>{const e=await read(args);change(e);return e;};await rejected(()=>r.sender.step(ID));assert.equal(r.state.get(ID).phase,'final_pending');assert.equal(r.counts.complete,1);assert.equal([...r.controls.values()].filter(e=>JSON.parse(e.bytes).action==='record').length,0);});
});
test('missing final native-message checker cannot silently become a successful record',()=>inRig(async r=>{await send(r);r.io.checkFinalNotice=undefined;await rejected(()=>r.sender.step(ID));assert.equal(r.state.get(ID).phase,'final_pending');assert.equal(r.counts.complete,1);assert.equal([...r.controls.values()].filter(e=>JSON.parse(e.bytes).action==='record').length,0);}));

test('poster and claim prepare early, with only final completion called at due time',()=>inRig(async r=>{
 await arm(r);assert.equal(r.counts.poster,1);assert.equal(r.claimCount(),1);
 await assert.rejects(()=>r.sender.step(ID),ReadPending);assert.equal(r.counts.complete,0);assert.equal(r.state.op(ID,'final_complete'),null);
 const calls=r.calls.length;r.advance(30000);await r.sender.step(ID);
 assert.deepEqual(r.calls.slice(calls).map(c=>c.name),['completeFinalUpload']);
 assert.equal(r.counts.complete,1);assert.equal(r.calls.at(-1).wall,TARGET);
},{start:TARGET-30000}));

test('a delayed grant remains the same unstarted attempt, without renewal or replacement',()=>inRig(async r=>{
 await toClaim(r);r.modes.grantPending=true;await rejected(()=>r.sender.step(ID));r.advance(600000);
 r.modes.grantPending=false;const restarted=r.makeSender();await restarted.step(ID);await restarted.step(ID);
 assert.equal(r.counts.complete,1);assert.equal(r.counts.poster,1);assert.equal(r.claimCount(),1);
}));

test('reopened final-ready journal resumes after fresh evidence checks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cloud-ready-reopen-')),filename=join(dir,'state.sqlite');const r=await rig({filename});let reopened;
 try{
  await arm(r);assert.equal(r.state.op(ID,'final_complete'),null);r.state.close();
  reopened=new CloudRunState(filename,SCOPE);const calls=r.calls.length;await r.makeSender(reopened).step(ID);
  const reads=r.calls.slice(calls).map(c=>c.name);
  for(const name of ['readControlUpload','readNoticeResponse','fetchPublic','assertTransport'])assert.ok(reads.includes(name),name);
  assert.equal(reads.at(-1),'completeFinalUpload');assert.equal(reopened.get(ID).phase,'final_pending');assert.equal(r.counts.complete,1);
 }finally{reopened?.close();r.publisher.close();await rm(dir,{recursive:true,force:true});}
});

test('recovery rejects changed claim, grant or transport before recording completion intent',async()=>{
 for(const change of [
  r=>r.controls.get([...r.controls.keys()].find(k=>k.startsWith('cloud-claim-'))).message.user='UOTHER',
  r=>r.replies.get(r.state.get(ID).detail.claim_source.source_ts).message.bot_id='BOTHER',
  r=>r.modes.unverifiedTransport=true,
 ])await inRig(async r=>{
  await arm(r);change(r);await rejected(()=>r.makeSender().step(ID));
  assert.equal(r.state.op(ID,'final_complete'),null);assert.equal(r.counts.complete,0);assert.equal(r.claimCount(),1);
 });
});

test('transaction rollback leaves both phase and completion intent unstarted',()=>inRig(async r=>{
 await arm(r);const move=r.state.move.bind(r.state);
 r.state.move=(id,from,...rest)=>{if(from==='final_ready')throw Error('simulated transaction failure');return move(id,from,...rest);};
 await rejected(()=>r.sender.step(ID));assert.equal(r.state.get(ID).phase,'final_ready');assert.equal(r.state.op(ID,'final_complete'),null);assert.equal(r.counts.complete,0);
 r.state.move=move;await r.makeSender().step(ID);assert.equal(r.counts.complete,1);
}));

test('time is checked after remote reads and again after acquiring the write lock',async()=>{
 for(const during of ['reads','lock'])await inRig(async r=>{
  await arm(r);
  if(during==='reads'){const check=r.io.assertTransport;r.io.assertTransport=async(...args)=>{await check(...args);r.clock.wall=TARGET-1;};}
  else{const begin=r.state.beginCompletion.bind(r.state);r.state.beginCompletion=(job,input,check)=>begin(job,input,()=>{r.clock.wall=TARGET-1;check();});}
  await assert.rejects(()=>r.sender.step(ID),ReadPending);assert.equal(r.state.get(ID).phase,'final_ready');assert.equal(r.state.op(ID,'final_complete'),null);assert.equal(r.counts.complete,0);
 });
});

test('rollback observed after a committed intent cannot re-enable completion',()=>inRig(async r=>{
 await arm(r);const begin=r.state.beginCompletion.bind(r.state);
 r.state.beginCompletion=(...args)=>{const won=begin(...args);r.clock.wall=TARGET-1;return won;};
 await r.sender.step(ID);assert.equal(r.state.get(ID).phase,'final_pending');assert.equal(r.state.op(ID,'final_complete').phase,'unknown');assert.equal(r.counts.complete,0);
 r.clock.wall=TARGET;await rejected(()=>r.makeSender().step(ID));assert.equal(r.counts.complete,0);assert.equal(r.counts.poster,1);
}));

test('unavailable host time refuses delivery without requiring an independent clock adapter',async()=>{
 for(const now of [NaN,Infinity,0,-1,1.5])await inRig(async r=>{
  await r.sender.step(ID);await r.sender.step(ID);r.clock.wall=now;const calls=r.calls.length;
  await rejected(()=>r.sender.step(ID));assert.equal(r.calls.length,calls);assert.equal(r.counts.poster,0);
 });
});

test('an older journal is rejected rather than migrated into fresh send permission',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cloud-old-journal-')),filename=join(dir,'state.sqlite');
 try{
  const r=await rig({filename});await arm(r);r.close();
  const db=new DatabaseSync(filename);db.prepare('UPDATE cloud_scope SET hash=?').run('0'.repeat(64));db.close();
  assert.throws(()=>new CloudRunState(filename,SCOPE),/Cloud scope changed/);
  const inspect=new DatabaseSync(filename,{readOnly:true});assert.equal(inspect.prepare('SELECT phase FROM cloud_runs WHERE id=?').get(ID).phase,'final_ready');assert.equal(inspect.prepare("SELECT count(*) AS n FROM cloud_ops WHERE name='final_complete'").get().n,0);inspect.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('early preparation absorbs a Publisher tick before the due-time critical path',()=>inRig(async r=>{
 await toClaim(r);r.modes.grantPending=true;await assert.rejects(()=>r.sender.step(ID),ReadPending);
 assert.equal(r.counts.poster,1);assert.equal(r.claimCount(),1);assert.equal(r.state.op(ID,'final_complete'),null);
 r.advance(120000);r.modes.grantPending=false;await r.sender.step(ID);
 await assert.rejects(()=>r.sender.step(ID),ReadPending);assert.equal(r.counts.complete,0);
 r.advance(750000);await assert.rejects(()=>r.sender.step(ID),ReadPending); // 07:59:30: refresh reads.
 const calls=r.calls.length;r.advance(30000);await r.sender.step(ID);
 assert.deepEqual(r.calls.slice(calls).map(c=>c.name),['completeFinalUpload']);
 assert.equal(r.calls.at(-1).wall,TARGET);assert.equal(r.counts.complete,1);assert.equal(r.claimCount(),1);assert.equal(r.counts.poster,1);
},{start:TARGET-900000}));

test('restart before due rebuilds preflight with the same durable file and grant',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cloud-early-reopen-')),filename=join(dir,'state.sqlite');const r=await rig({filename,start:TARGET-120000});let reopened;
 try{
  await arm(r);await assert.rejects(()=>r.sender.step(ID),ReadPending);r.state.close();r.advance(90000);
  reopened=new CloudRunState(filename,SCOPE);const restarted=r.makeSender(reopened),reads=r.calls.length;
  await assert.rejects(()=>restarted.step(ID),ReadPending);
  for(const name of ['readControlUpload','readNoticeResponse','fetchPublic','assertTransport'])assert.ok(r.calls.slice(reads).some(c=>c.name===name));
  assert.equal(reopened.op(ID,'final_complete'),null);assert.equal(r.counts.complete,0);
  const calls=r.calls.length;r.advance(30000);await restarted.step(ID);
  assert.deepEqual(r.calls.slice(calls).map(c=>c.name),['completeFinalUpload']);assert.equal(r.counts.complete,1);assert.equal(r.claimCount(),1);assert.equal(r.counts.poster,1);
 }finally{reopened?.close();r.publisher.close();await rm(dir,{recursive:true,force:true});}
});

test('missing grant after restart blocks due-time completion without forfeiting the first attempt',()=>inRig(async r=>{
 await arm(r);await assert.rejects(()=>r.sender.step(ID),ReadPending);
 const restarted=r.makeSender();r.modes.grantPending=true;await assert.rejects(()=>restarted.step(ID),ReadPending);
 r.advance(30000);await assert.rejects(()=>restarted.step(ID),ReadPending);assert.equal(r.counts.complete,0);assert.equal(r.state.op(ID,'final_complete'),null);
 r.modes.grantPending=false;await restarted.step(ID);assert.equal(r.counts.complete,1);assert.equal(r.counts.poster,1);assert.equal(r.claimCount(),1);
},{start:TARGET-30000}));

test('failed refresh cannot reuse stale cached grant evidence',()=>inRig(async r=>{
 await arm(r);await assert.rejects(()=>r.sender.step(ID),ReadPending);
 r.advance(60001);r.modes.grantPending=true;await assert.rejects(()=>r.sender.step(ID),ReadPending);
 r.advance(29999);await assert.rejects(()=>r.sender.step(ID),ReadPending);assert.equal(r.counts.complete,0);assert.equal(r.state.op(ID,'final_complete'),null);
 r.modes.grantPending=false;await r.sender.step(ID);assert.equal(r.counts.complete,1);assert.equal(r.claimCount(),1);
},{start:TARGET-90000}));

test('cache age is rechecked inside the completion transaction and can refresh afterward',()=>inRig(async r=>{
 await arm(r);await assert.rejects(()=>r.sender.step(ID),ReadPending);r.advance(30000);
 const begin=r.state.beginCompletion.bind(r.state);r.state.beginCompletion=(job,input,check)=>begin(job,input,()=>{r.advance(PREFLIGHT_REFRESH_MS);check();});
 await assert.rejects(()=>r.sender.step(ID),ReadPending);assert.equal(r.state.get(ID).phase,'final_ready');assert.equal(r.state.op(ID,'final_complete'),null);assert.equal(r.counts.complete,0);
 r.state.beginCompletion=begin;await r.sender.step(ID);assert.equal(r.counts.complete,1);assert.equal(r.claimCount(),1);
},{start:TARGET-30000}));

test('slow preflight reads are refreshed, not stamped fresh when they finally return',()=>inRig(async r=>{
 await arm(r);const check=r.io.assertTransport;r.io.assertTransport=async(...args)=>{await check(...args);r.advance(PREFLIGHT_REFRESH_MS);};
 await assert.rejects(()=>r.sender.step(ID),ReadPending);assert.equal(r.state.op(ID,'final_complete'),null);assert.equal(r.counts.complete,0);
 r.io.assertTransport=check;await r.makeSender().step(ID);assert.equal(r.counts.complete,1);assert.equal(r.claimCount(),1);
},{start:TARGET-30000}));

test('an early-prepared unknown completion remains read-only after restart',()=>inRig(async r=>{
 await arm(r);await assert.rejects(()=>r.sender.step(ID),ReadPending);r.advance(30000);
 r.modes.finalTimeout=true;r.modes.finalMissing=true;await r.sender.step(ID);
 assert.equal(r.state.op(ID,'final_complete').phase,'unknown');assert.equal(r.counts.complete,1);
 for(let i=0;i<2;i++)await rejected(()=>r.makeSender().step(ID));
 assert.equal(r.counts.complete,1);assert.equal(r.counts.poster,1);assert.equal(r.claimCount(),1);
},{start:TARGET-30000}));

test('two consumers with early preflight caches still share one completion fence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cloud-early-race-')),filename=join(dir,'state.sqlite');const r=await rig({filename,start:TARGET-30000}),other=new CloudRunState(filename,SCOPE);
 try{
  await arm(r);const second=r.makeSender(other);
  await Promise.all([assert.rejects(()=>r.sender.step(ID),ReadPending),assert.rejects(()=>second.step(ID),ReadPending)]);
  assert.equal(r.state.op(ID,'final_complete'),null);r.advance(30000);
  await Promise.all([r.sender.step(ID),second.step(ID)]);
  assert.equal(r.counts.complete,1);assert.equal(r.claimCount(),1);assert.equal(r.counts.poster,1);
 }finally{other.close();r.close();await rm(dir,{recursive:true,force:true});}
});
