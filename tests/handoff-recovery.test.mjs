import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HandoffState,withLockedHandoffState} from '../scripts/handoff-state.mjs';
import {spawnSync} from 'node:child_process';
import {encodeBundle} from '../scripts/report-handoff.mjs';
import {digest} from '../scripts/archive.mjs';
import {handoffTick,handoffMain} from '../scripts/run-handoff.mjs';
import {advanceHandoff} from '../scripts/handoff-worker.mjs';
import {safeDiagnostic} from '../scripts/handoff-recovery.mjs';
import {withHandoffLock,withHandoffReadLock} from '../scripts/handoff-lock.mjs';
import {GitHub,PREFIX,operationError} from '../scripts/github.mjs';
import {SlackHandoff,publicGitHub,publicMergeCommit} from '../scripts/slack-handoff.mjs';
import {ProviderCooldowns,providerIO} from '../scripts/provider-cooldowns.mjs';
import {FILES,BASE,MERGE} from './helpers/cloud-sender-fixture.mjs';
const HEAD='d'.repeat(40),TREE='e'.repeat(40),REPO='sfcloud-ai/ai-infra-reports';
const config={};
async function rig(ids=['original'],filename=':memory:'){
 const state=new HandoffState(filename,config),calls=[];let clock=100000;
 for(const [index,id]of ids.entries()){
  const bytes=await encodeBundle(FILES,id,BASE,'b'.repeat(40));
  state.admit({request_id:id,hash:digest(bytes),source_ts:`179349120${index}.000001`},bytes);
 }
 const io={now:()=>clock,propose:async()=>{calls.push('propose');return {url:`https://github.com/${REPO}/pull/1`,sha:HEAD};},readPR:async()=>({number:1,state:'closed',merged:true,head:{sha:HEAD,repo:{full_name:REPO}},base:{ref:'main',repo:{full_name:REPO}}}),readMergeCommit:async()=>MERGE,readCommit:async sha=>({sha,tree:{sha:TREE},parents:[{sha:BASE}]}),verify:async(_commit,bundle)=>({publication_status:'verified',commit:MERGE,bundle_sha256:bundle.hash}),receipt:async()=>{calls.push('receipt');return '1793491300.000001';}};
 return {state,io,calls,advance:ms=>clock+=ms};
}
test('completed stages advance and schedule within a single tick',async()=>{
 const r=await rig();let admitted=false;
 try{
  const c={scheduled_delivery:{activation_date:'2026-11-01',executable:'/usr/bin/python3',args:[]}};
  const result=await handoffTick(r.state,c,{history:async()=>[]},{...r.io,scheduleQuery:async(_c,q)=>{
   if(q.action==='status')return {status:'not_found'};
   admitted=true;assert.equal(q.request_id,'original');assert.equal(r.state.get('original').phase,'receipt_sent');
   return {request_id:'original',report_date:'2026-11-01',report_commit:MERGE,bundle_sha256:r.state.get('original').hash,status:'queued',phase:'pending',parts_total:2,parts_sent:0};
  }});
  assert.equal(result.errors.length,0);assert.equal(result.phase,'receipt_sent');assert.equal(admitted,true);assert.deepEqual(r.calls,['propose','receipt']);
 }finally{r.state.close();}
});

test('a concurrent local Slack cooldown preserves an unattempted report receipt',async()=>{
 const r=await rig(),receipt=r.io.receipt;let deferred=false;
 const slack=new SlackHandoff({},'synthetic',()=>assert.fail('no HTTP attempt'),{now:r.io.now,cooldowns:{deadline:()=>1900000}});
 r.io.receipt=async(...args)=>{if(!deferred){deferred=true;slack.assertReady('chat.postMessage');}return receipt(...args);};
 try{
  await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(r.state.get('original').phase,'verified');assert.deepEqual(r.calls,['propose']);
  r.advance(1800000);await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(r.state.get('original').phase,'receipt_sent');assert.deepEqual(r.calls,['propose','receipt']);
 }finally{r.state.close();}
});

test('failed parallel commit reads drain before shared quota cleanup and retain the later limit',async()=>{
 const r=await rig(),cooldowns=new ProviderCooldowns(':memory:','fixture');let release,lateFinished=false;
 const late=new Promise(resolve=>{release=resolve;});
 const io=providerIO({...r.io,readCommit:async sha=>{
  if(sha===HEAD)throw operationError('fixture failure',{stage:'public_github_read',code:'http_503',retryable:true});
  await late;lateFinished=true;throw operationError('fixture limit',{stage:'public_github_read',provider_scope:'github.public',code:'rate_limited',retryable:true,retry_at:1900000});
 }},cooldowns,r.io.now);
 try{
  await advanceHandoff(r.state,'original',io);
  let returned=false;const advancing=advanceHandoff(r.state,'original',io).then(()=>{returned=true;},()=>{returned=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(returned,false);
  release();await advancing;assert.equal(lateFinished,true);assert.equal(cooldowns.deadline('github.public'),1900000);assert.equal(r.state.get('original').phase,'pr_open');
 }finally{release?.();cooldowns.close();r.state.close();}
});

test('recoverable token cleanup waits for expiry across restart before another proposal',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'cleanup-recovery-')),filename=path.join(directory,'handoff.sqlite');let r=await rig(['original'],filename),attempts=0;
 const propose=r.io.propose;
 r.io.propose=async(...args)=>{if(++attempts===1)throw operationError('fixture cleanup',{stage:'token_revoke',code:'transport',outcome:'not_started',retryable:true,cleanup_after:3760000});return propose(...args);};
 try{
  await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(r.state.get('original').phase,'received');assert.equal(r.state.get('original').detail.recovery.next_at,3760000);
  r.state.close();r.state=new HandoffState(filename,config);
  r.advance(3659999);await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(attempts,1);
  r.advance(1);await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(attempts,2);assert.equal(r.state.get('original').phase,'receipt_sent');
 }finally{r.state.close();await rm(directory,{recursive:true,force:true});}
});

test('token cleanup allows public reconciliation while renewed proposal writes wait across restart',async()=>{
 for(const outcome of ['published','absent','branch_only']){
  const directory=await mkdtemp(path.join(os.tmpdir(),'cleanup-reconcile-')),filename=path.join(directory,'handoff.sqlite'),r=await rig(['original'],filename);
  let attempts=0,reads=0;const propose=r.io.propose;
  r.io.propose=async(...args)=>{if(++attempts===1)throw operationError('fixture uncertain cleanup',{stage:'token_revoke',code:'rate_limited',provider_scope:'github.producer',retry_at:3700000,outcome:'unknown',cleanup_after:3760000});return propose(...args);};
  r.io.reconcileProposal=async()=>{if(++reads===1)throw operationError('fixture public read outage',{stage:'public_github_read',code:'transport',retryable:true});return {outcome,url:`https://github.com/${REPO}/pull/1`,sha:HEAD};};
  try{
   await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(r.state.get('original').phase,'proposal_unknown');
   r.state.close();r.state=new HandoffState(filename,config);
   r.advance(2000);await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(reads,1);
   r.advance(4000);await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(reads,2);assert.equal(attempts,1);
   if(outcome==='published'){assert.equal(r.state.get('original').phase,'receipt_sent');assert.deepEqual(r.calls,['receipt']);}
   else{
    assert.equal(r.state.get('original').phase,'received');assert.equal(r.state.get('original').detail.recovery.proposal_after,3760000);
    await advanceHandoff(r.state,'original',r.io);assert.equal(attempts,1);
    r.state.close();r.state=new HandoffState(filename,config);
    r.advance(3653999);await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(attempts,1);
    r.advance(1);await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(attempts,2);assert.equal(r.state.get('original').phase,'receipt_sent');
   }
  }finally{r.state.close();await rm(directory,{recursive:true,force:true});}
 }
});

test('one-shot CLI reports unhealthy ticks and exceptions as failures while preserving diagnostics',async()=>{
 for(const scenario of ['healthy','intake','proposal','backoff']){
  const r=await rig(),outputs=[];let warnings=0;
  const slack={history:async()=>{if(scenario==='intake')throw Error('private intake failure');return [];}};
  if(scenario==='proposal')r.io.propose=async()=>{throw operationError('private proposal failure',{stage:'proposal',code:'transport',outcome:'unknown'});};
  if(scenario==='backoff')r.state.move('original','received','proposal_unknown',{recovery:{next_at:1900000}});
  try{
   const result=await handoffMain(['fixture.json','--live'],{run:()=>handoffTick(r.state,config,slack,r.io),log:text=>outputs.push(JSON.parse(text)),error:()=>warnings++});
   assert.equal(result,scenario==='healthy'?0:1);assert.equal(outputs.length,1);assert.equal(outputs[0].healthy,scenario==='healthy');assert.equal(warnings,0);
   assert(!JSON.stringify(outputs).includes('private'));
  }finally{r.state.close();}
 }
 const errors=[];assert.equal(await handoffMain(['fixture.json','--live'],{run:async()=>{throw Error('private credentials');},log:()=>assert.fail('no result'),error:text=>errors.push(text)}),1);
 assert.equal(errors.length,1);assert(!errors[0].includes('private credentials'));
 assert.equal(await handoffMain(['fixture.json'],{run:()=>assert.fail('invalid arguments'),error:()=>{}}),1);
});

test('scheduling and health inspect metadata without loading unselected backlog payloads',async()=>{
 const ids=Array.from({length:32},(_,i)=>'backlog-'+String(i).padStart(3,'0')),r=await rig(ids),get=r.state.get.bind(r.state);let allowed=new Set(),loaded=[];
 for(const [index,id]of ids.entries())r.state.db.prepare('UPDATE jobs SET source_ts=? WHERE id=?').run(`${1793491200+index}.000001`,id);
 for(const id of ids.slice(24)){const job=r.state.metadata(id);r.state.move(id,job.phase,job.phase,{recovery:{next_at:1900000}});}
 r.state.get=id=>{assert(allowed.has(id),'unselected payload loaded: '+id);loaded.push(id);return get(id);};
 r.io.propose=async()=>{throw operationError('fixture outage',{stage:'read_main',code:'transport',retryable:true});};
 try{
  for(let offset=0;offset<24;offset+=8){
   allowed=new Set(ids.slice(offset,offset+8));loaded=[];
   const result=await handoffTick(r.state,config,{history:async()=>[]},r.io);
   assert.deepEqual([...new Set(loaded)].sort(),[...allowed].sort());assert.equal(loaded.length,8);assert.equal(result.healthy,false);
  }
  assert(r.state.pendingMetadata().every(job=>!Object.hasOwn(job,'bytes')));
 }finally{r.state.close();}
});
test('uncertain original is isolated while another request progresses',async()=>{
 const r=await rig(['original','later-request']);try{
  r.state.move('original','received','proposal_unknown',{});
  const result=await handoffTick(r.state,config,{history:async()=>[]},{...r.io,reconcileProposal:async()=>{throw Error('read unavailable with secret');}});
  assert.equal(r.state.get('original').phase,'proposal_unknown');assert.equal(r.state.get('later-request').phase,'receipt_sent');assert.deepEqual(r.calls,['propose','receipt']);assert.equal(result.errors.length,1);assert(!JSON.stringify(result).includes('secret'));
 }finally{r.state.close();}
});
test('a failed intake read does not strand already admitted work',async()=>{
 const r=await rig();try{
  const result=await handoffTick(r.state,config,{history:async()=>{throw Error('network');}},r.io);
  assert.equal(r.state.get('original').phase,'receipt_sent');assert.equal(result.errors[0].stage,'intake_history');
 }finally{r.state.close();}
});

test('slow intake leaves a separately bounded report processing budget',async()=>{
 const r=await rig(['original','later-request']),propose=r.io.propose;
 try{
  const result=await handoffTick(r.state,config,{history:async()=>{r.advance(180000);return [];}},{...r.io,propose:async(...args)=>{r.advance(100000);return propose(...args);}});
  assert.equal(result.phase,'pr_open');assert.deepEqual(r.calls,['propose']);
  assert.equal(r.state.get('later-request').phase,'received');
 }finally{r.state.close();}
});
test('known pre-write failure retries only when its durable deadline is due',async()=>{
 const r=await rig();let attempts=0;const propose=r.io.propose;
 r.io.propose=async()=>{attempts++;if(attempts===1)throw Object.assign(Error('token=secret'),{diagnostic:{stage:'read_main',code:'transport',outcome:'not_started',retryable:true}});return propose();};
 try{
  const first=await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(r.state.get('original').phase,'received');assert.equal(first.next_delay_ms,2000);
  await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(attempts,1);
  r.advance(2000);await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(attempts,2);assert.equal(r.state.get('original').phase,'receipt_sent');assert(!JSON.stringify(r.state.get('original').detail).includes('secret'));
 }finally{r.state.close();}
});

test('provider retry deadline survives restart and prevents early publication retries',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'handoff-rate-limit-')),filename=path.join(directory,'state.sqlite'),r=await rig(['original'],filename);
 const api=new GitHub('fixture',{now:r.io.now,fetcher:async()=>new Response('{}',{status:429,headers:{'retry-after':'60'}})}),propose=r.io.propose;let attempts=0;
 r.io.propose=async()=>{if(++attempts===1)await api.request('GET',PREFIX+'/git/ref/heads/main');return propose();};
 try{
  const first=await handoffTick(r.state,config,{history:async()=>[]},r.io);
  assert.equal(first.next_delay_ms,60000);assert.equal(r.state.get('original').detail.recovery.next_at,160000);
  r.state.close();r.state=new HandoffState(filename,config);r.advance(59999);
  await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(attempts,1);
  r.advance(1);const completed=await handoffTick(r.state,config,{history:async()=>[]},r.io);
  assert.equal(attempts,2);assert.equal(completed.phase,'receipt_sent');assert.equal(completed.healthy,true);
 }finally{r.state.close();await api.close();await rm(directory,{recursive:true,force:true});}
});

test('production public GitHub readers preserve throttling deadlines in the durable PR phase',async()=>{
 for(const stage of ['readPR','readMergeCommit','readCommit'])for(const kind of ['retry-after','reset','secondary']){
  const r=await rig();let requests=0;
  const delay=kind==='reset'?3600000:60000,deadline=r.io.now()+delay;
  const fetcher=async(_url,options)=>{requests++;assert.equal(options.headers.authorization,undefined);return Response.json({message:'You have exceeded a secondary rate limit.',private_detail:'secret'},{status:kind==='retry-after'?429:403,headers:kind==='retry-after'?{'retry-after':'60'}:kind==='reset'?{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(deadline/1000)}:{'x-ratelimit-remaining':'99'}});};
  const readPR=r.io.readPR;
  r.io.readPR=async()=>({...await readPR(),merged_at:'2026-11-04T00:00:00Z',merged_by:{id:1}});
  r.io[stage]=stage==='readPR'?n=>publicGitHub('/pulls/'+n,fetcher,r.io.now):stage==='readMergeCommit'?(n,pr)=>publicMergeCommit(n,pr,fetcher,r.io.now):sha=>publicGitHub('/git/commits/'+sha,fetcher,r.io.now);
  try{
   r.state.move('original','received','pr_open',{pr:`https://github.com/${REPO}/pull/1`,head:HEAD});
   const result=await handoffTick(r.state,config,{history:async()=>[]},r.io);
   assert.equal(result.phase,'pr_open');assert.equal(r.state.get('original').detail.recovery.next_at,deadline);assert.equal(result.next_delay_ms,Math.min(delay,120000));
   assert.equal(result.errors[0].code,'rate_limited');assert(!JSON.stringify(result).includes('secret'));const previous=requests;
   r.advance(delay-1);await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(requests,previous);
   r.advance(1);await handoffTick(r.state,config,{history:async()=>[]},r.io);assert(requests>previous);assert.deepEqual(r.calls,[]);
  }finally{r.state.close();}
 }
});

test('retry deadlines expiring during other report work wake promptly and permanent failures do not',async()=>{
 for(const retryable of [true,false]){
  const r=await rig(['original','later-request']),propose=r.io.propose;let attempts=0;
  r.io.propose=async()=>{if(++attempts===1)throw Object.assign(Error('private'),{diagnostic:{stage:'read_main',code:'transport',outcome:'not_started',retryable}});r.advance(5000);return propose();};
  try{
   const result=await handoffTick(r.state,config,{history:async()=>[]},r.io);
   assert.equal(r.state.get('later-request').phase,'receipt_sent');assert.equal(r.state.get('original').detail.recovery.next_at,102000);
   assert.equal(result.next_delay_ms,retryable?1000:120000);
   r.advance(result.next_delay_ms);await handoffTick(r.state,config,{history:async()=>[]},r.io);
   assert.equal(r.state.get('original').phase,retryable?'receipt_sent':'proposal_failed');
  }finally{r.state.close();}
 }
});

test('Slack receipt reconciliation retains its provider deadline across a ledger restart',async()=>{
 for(const status of [429,200]){
  const directory=await mkdtemp(path.join(os.tmpdir(),'handoff-slack-limit-')),filename=path.join(directory,'state.sqlite'),r=await rig(['original'],filename);let requests=0;
  const slack=new SlackHandoff({},'fixture',async()=>{requests++;return Response.json({ok:false,error:'ratelimited',private_detail:'secret'},{status,headers:{'retry-after':'60'}});},{now:r.io.now});
  r.io.findReceipt=()=>slack.call('conversations.replies');
  try{
   r.state.move('original','received','receipt_unknown',{proof:{publication_status:'verified',commit:MERGE},pr:`https://github.com/${REPO}/pull/1`});
   const first=await handoffTick(r.state,config,{history:async()=>[]},r.io);
   assert.equal(first.next_delay_ms,60000);assert.equal(r.state.get('original').detail.recovery.next_at,160000);assert(!JSON.stringify(first).includes('secret'));
   r.state.close();r.state=new HandoffState(filename,config);r.advance(59999);
   await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(requests,1);
   r.advance(1);await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(requests,2);assert.deepEqual(r.calls,[]);assert.equal(r.state.get('original').phase,'receipt_unknown');
  }finally{r.state.close();await rm(directory,{recursive:true,force:true});}
 }
});

test('reports share a Slack method deadline across jobs, new admissions and restart',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'shared-slack-limit-')),filename=path.join(directory,'state.sqlite'),r=await rig(['original','second-report','unrelated'],filename);let reads=0;
 const slack=new SlackHandoff({},'fixture',async()=>{reads++;return r.io.now()<1900000?new Response('',{status:429,headers:{'retry-after':'1800'}}):Response.json({ok:true});},{now:r.io.now});
 r.io.findReceipt=async()=>{await slack.call('conversations.replies');return '1793750461.000001';};
 const unknown=id=>r.state.move(id,'received','receipt_unknown',{proof:{publication_status:'verified',commit:MERGE},pr:`https://github.com/${REPO}/pull/1`});
 try{
  unknown('original');unknown('second-report');
  await handoffTick(r.state,config,{history:async()=>[]},r.io);
  assert.equal(reads,1);assert.equal(r.state.get('second-report').phase,'receipt_unknown');assert.equal(r.state.get('second-report').detail.recovery.next_at,1900000);
  assert.equal(r.state.get('unrelated').phase,'receipt_sent');assert.deepEqual(r.calls,['propose','receipt']);
  r.state.close();r.state=new HandoffState(filename,config);
  const bytes=await encodeBundle(FILES,'new-request',BASE,'b'.repeat(40));r.state.admit({request_id:'new-request',hash:digest(bytes),source_ts:'1793491204.000001'},bytes);unknown('new-request');
  r.advance(1799999);await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(reads,1);assert.equal(r.state.get('new-request').detail.recovery.next_at,1900000);
  r.advance(1);await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(reads,4);
  for(const id of ['original','second-report','new-request'])assert.equal(r.state.get(id).phase,'receipt_sent');
 }finally{r.state.close();await rm(directory,{recursive:true,force:true});}
});

test('shared post throttling defers before a second write intent while GitHub work progresses',async()=>{
 const r=await rig(['original','second-report','unrelated']);let posts=0;
 const slack=new SlackHandoff({},'fixture',async()=>{posts++;return new Response('',{status:429,headers:{'retry-after':'1800'}});},{now:r.io.now});
 r.io.receipt=()=>slack.call('chat.postMessage',{},true);
 const readPR=r.io.readPR;r.io.readPR=async()=>({...await readPR(),merged:false,state:'open'});
 try{
  for(const id of ['original','second-report'])r.state.move(id,'received','verified',{commit:MERGE,pr:`https://github.com/${REPO}/pull/1`});
  await handoffTick(r.state,config,{history:async()=>[]},r.io);
  assert.equal(posts,1);assert.equal(r.state.get('original').phase,'receipt_unknown');assert.equal(r.state.get('second-report').phase,'verified');
  assert.equal(r.state.get('second-report').detail.recovery.next_at,1900000);assert.equal(r.state.get('unrelated').phase,'pr_open');assert.deepEqual(r.calls,['propose']);
 }finally{r.state.close();}
});

test('public GitHub throttling is shared across reports and restart without blocking Producer or Slack work',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'shared-public-limit-')),filename=path.join(directory,'state.sqlite'),r=await rig(['original','second-report','fresh-proposal','receipt-job'],filename);let reads=0;
 const readPR=r.io.readPR;
 r.io.readPR=n=>publicGitHub('/pulls/'+n,async()=>{reads++;return r.io.now()<1900000?new Response('',{status:429,headers:{'retry-after':'1800'}}):Response.json(await readPR());},r.io.now);
 r.io.findReceipt=async()=> '1793750461.000001';
 const open=id=>r.state.move(id,'received','pr_open',{pr:`https://github.com/${REPO}/pull/1`,head:HEAD});
 try{
  open('original');open('second-report');r.state.move('receipt-job','received','receipt_unknown',{proof:{publication_status:'verified',commit:MERGE},pr:`https://github.com/${REPO}/pull/1`});
  await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(reads,1);assert.equal(r.state.get('fresh-proposal').phase,'pr_open');assert.equal(r.state.get('receipt-job').phase,'receipt_sent');assert.deepEqual(r.calls,['propose']);
  r.state.close();r.state=new HandoffState(filename,config);
  const bytes=await encodeBundle(FILES,'new-request',BASE,'b'.repeat(40));r.state.admit({request_id:'new-request',hash:digest(bytes),source_ts:'1793491204.000001'},bytes);open('new-request');
  r.advance(1799999);await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(reads,1);assert.equal(r.state.get('new-request').detail.recovery.next_at,1900000);
  r.advance(1);await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(reads,5);
  for(const id of ['original','second-report','fresh-proposal','new-request'])assert.equal(r.state.get(id).phase,'receipt_sent');
 }finally{r.state.close();await rm(directory,{recursive:true,force:true});}
});

test('App and Producer cooldowns defer other proposals while public publication checks continue',async()=>{
 for(const scope of ['github.app','github.producer']){
  const r=await rig(['original','second-report','already-open']),propose=r.io.propose;let attempts=0;
  const api=new GitHub('fixture',{now:r.io.now,fetcher:async()=>new Response('',{status:429,headers:{'retry-after':'1800'}})});
  r.io.propose=async()=>{attempts++;if(r.io.now()<1900000){if(scope==='github.producer')await api.request('GET',PREFIX+'/git/ref/heads/main');throw operationError('fixture',{stage:'token_issue',code:'rate_limited',provider_scope:scope,retryable:true,retry_at:1900000});}return propose();};
  try{
   r.state.move('already-open','received','pr_open',{pr:`https://github.com/${REPO}/pull/1`,head:HEAD});
   await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(attempts,1);assert.equal(r.state.get('second-report').phase,'received');assert.equal(r.state.get('already-open').phase,'receipt_sent');
   r.advance(1800000);await handoffTick(r.state,config,{history:async()=>[]},r.io);assert.equal(attempts,3);
   assert.equal(r.state.get('original').phase,'receipt_sent');assert.equal(r.state.get('second-report').phase,'receipt_sent');
  }finally{r.state.close();await api.close();}
 }
});

test('backoff ticks retain unhealthy status until the original request completes',async()=>{
 const r=await rig(),propose=r.io.propose;let attempts=0;
 r.io.propose=async()=>{attempts++;throw Object.assign(Error('secret'),{diagnostic:{stage:'token_issue',code:'rate_limited',outcome:'not_started',retryable:true}});};
 try{
  const failed=await handoffTick(r.state,config,{history:async()=>[]},r.io);
  assert.equal(failed.healthy,false);assert.equal(failed.blocked_reports[0].error.code,'rate_limited');
  const waiting=await handoffTick(r.state,config,{history:async()=>[]},r.io);
  assert.equal(waiting.errors.length,0);assert.equal(waiting.healthy,false);assert.equal(attempts,1);assert(!JSON.stringify(waiting).includes('secret'));
  r.advance(2000);r.io.propose=propose;
  const completed=await handoffTick(r.state,config,{history:async()=>[]},r.io);
  assert.equal(completed.phase,'receipt_sent');assert.equal(completed.healthy,true);assert.deepEqual(completed.blocked_reports,[]);
 }finally{r.state.close();}
});

test('permanent proposal failure remains unhealthy after a ledger restart without retrying',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'handoff-health-')),filename=path.join(dir,'state.sqlite');
 const r=await rig(['original'],filename);let reopened;
 try{
  await handoffTick(r.state,config,{history:async()=>[]},{...r.io,propose:async()=>{throw Object.assign(Error('secret'),{diagnostic:{stage:'installation_read',code:'http_403',outcome:'not_started',retryable:false}});}});
  assert.equal(r.state.get('original').phase,'proposal_failed');
  r.state.close();reopened=new HandoffState(filename,config);r.advance(3600000);
  const result=await handoffTick(reopened,config,{history:async()=>[]},{...r.io,propose:()=>assert.fail('no permanent-failure retry')});
  assert.equal(result.errors.length,0);assert.equal(result.healthy,false);assert.equal(result.blocked_reports[0].phase,'proposal_failed');assert.equal(result.blocked_reports[0].error.code,'http_403');
 }finally{if(reopened)reopened.close();else r.state.close();await rm(dir,{recursive:true,force:true});}
});
test('restart reconciles original PR without creating another proposal',async()=>{
 const r=await rig();try{
  r.state.move('original','received','proposing',{});
  const result=await handoffTick(r.state,config,{history:async()=>[]},{...r.io,propose:()=>assert.fail('no duplicate mutation'),reconcileProposal:async()=>({outcome:'published',url:`https://github.com/${REPO}/pull/1`,sha:HEAD})});
  assert.equal(result.phase,'receipt_sent');assert.deepEqual(r.calls,['receipt']);
 }finally{r.state.close();}
});
test('missing or ambiguous reconciliation never permits a new write',async()=>{
 const r=await rig();try{
  r.state.move('original','received','proposal_unknown',{});
  await handoffTick(r.state,config,{history:async()=>[]},{...r.io,propose:()=>assert.fail('no write'),reconcileProposal:async()=>({outcome:'blocked',reason:'ambiguous'})});
  assert.equal(r.state.get('original').phase,'proposal_unknown');assert.deepEqual(r.calls,[]);
 }finally{r.state.close();}
});
test('a lost publication receipt is found without reposting it',async()=>{
 const r=await rig();try{
  r.state.move('original','received','receipt_unknown',{proof:{publication_status:'verified',commit:MERGE},pr:`https://github.com/${REPO}/pull/1`});
  await advanceHandoff(r.state,'original',{receipt:()=>assert.fail('no resend'),findReceipt:async(_thread,proof)=>{assert.equal(proof.status,'published');return '1793491300.000001';}});
  assert.equal(r.state.get('original').phase,'receipt_sent');
 }finally{r.state.close();}
});
test('diagnostics never copy raw exception or response data',()=>{
 const d=safeDiagnostic(Object.assign(Error('Bearer secret'),{code:'secret payload',response:{token:'secret'}}),'read');
 assert.deepEqual(d,{stage:'read',code:'unclassified',outcome:'unknown',retryable:false});
});
test('OS lock excludes a concurrent process and releases after failure',{skip:process.platform!=='linux'},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'handoff-lock-'));
 try{
  await withHandoffLock(dir,async()=>{await assert.rejects(()=>withHandoffLock(dir,()=>assert.fail('overlap')),/owns the ledger/);});
  await assert.rejects(()=>withHandoffLock(dir,async()=>{throw Error('failed tick');}),/failed tick/);
  assert.equal(await withHandoffLock(dir,async()=>42),42);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('operational recovery writes and close-time checkpoints exclude read-only snapshots',{skip:process.platform!=='linux'},async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'recovery-write-lock-'));let closedUnderLock=false;
 try{
  await withLockedHandoffState({state_dir:directory},async state=>{
   await assert.rejects(()=>withHandoffReadLock(directory,()=>assert.fail('snapshot overlapped writer')),/owns the ledger/);
   const close=state.close.bind(state);
   state.close=()=>{try{assert.equal(spawnSync('/usr/bin/flock',['--shared','--nonblock',path.join(directory,'handoff.lock'),'/bin/true']).status,1);closedUnderLock=true;}finally{close();}};
  });
  assert.equal(closedUnderLock,true);
  await withHandoffReadLock(directory,async()=>{
   await assert.rejects(()=>withLockedHandoffState({state_dir:directory},()=>assert.fail('writer overlapped snapshot')),/owns the ledger/);
  });
  await assert.rejects(()=>withLockedHandoffState({state_dir:directory},async()=>{throw Error('failed authorization');}),/failed authorization/);
  assert.equal(await withHandoffReadLock(directory,()=>42),42);
 }finally{await rm(directory,{recursive:true,force:true});}
});
