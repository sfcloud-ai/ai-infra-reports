import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {openProviderCooldowns,ProviderCooldowns} from '../scripts/provider-cooldowns.mjs';
import {scopeDigest} from '../scripts/handoff-state.mjs';
import {SlackHandoff} from '../scripts/slack-handoff.mjs';
import {WatchdogSlack,WatchdogJournal,advanceWatchdogAlerts} from '../scripts/publisher-watchdog.mjs';
import {privateFile,privateDirectory} from '../scripts/run-handoff.mjs';
import {serialTicks} from '../scripts/publisher-service.mjs';
import {withHandoffLock} from '../scripts/handoff-lock.mjs';
const config={team_id:'T123',channel_id:'C123',bot_user_id:'U456',bot_id:'B456'};
const headers={'x-oauth-scopes':'chat:write,files:read,groups:history,groups:read'};
const success=method=>new Response(JSON.stringify({ok:true,...(method==='auth.test'?{team_id:'T123',user_id:'U456',bot_id:'B456'}:method==='conversations.info'?{channel:{id:'C123',is_private:true,is_member:true}}:{messages:[]})}),{headers});
const openStore=(directory,extra={})=>openProviderCooldowns({...config,state_dir:directory,...extra},{privateFile,privateDirectory,createDirectory:true});

// Fault-injection fixtures, not live Slack or a production reproduction.
for(const method of ['auth.test','conversations.history'])test(method+' cooldown survives new clients and store reopen at fast tick intervals',{skip:process.platform!=='linux'},async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'provider-cooldown-'));let clock=100000,calls=0;
 try{
  const fetcher=async url=>{const name=new URL(url).pathname.split('/').pop();if(name===method&&++calls===1)return new Response('',{status:429,headers:{'retry-after':'1800'}});return success(name);};
  const tick=async()=>{
   const cooldowns=await openStore(directory);
   try{const slack=new SlackHandoff(config,'synthetic',fetcher,{now:()=>clock,cooldowns});if(method==='auth.test')await slack.preflight();else await slack.history();}
   finally{cooldowns.close();}
  };
  const stop=new AbortController();let ticks=0;
  await serialTicks(tick,async()=>{},async()=>{clock+=++ticks%2?1000:120000;if(ticks===10)stop.abort();},stop.signal,async error=>{assert.equal(error.diagnostic.retry_at,1900000);});
  assert.equal(calls,1);
  const persisted=await openStore(directory);
  try{
   assert.equal(persisted.deadline(method),1900000);
   await new SlackHandoff(config,'synthetic',async()=>success('files.info'),{now:()=>clock,cooldowns:persisted}).call('files.info');
  }finally{persisted.close();}
  clock=1900000;await tick();assert.equal(calls,2);
  assert(!(await readFile(path.join(directory,'provider-cooldowns','cooldowns.sqlite'))).includes(Buffer.from('synthetic')));
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('provider identity and invalid deadlines fail closed; competing clients retain the longest deadline',{skip:process.platform!=='linux'},async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'provider-cooldown-'));let first,second;
 try{
  first=await openStore(directory);second=await openStore(directory);
  const slack=new SlackHandoff(config,'synthetic',async()=>new Response('{"ok":false,"error":"ratelimited"}',{headers:{'retry-after':'300'}}),{now:()=>100000,cooldowns:first});
  await assert.rejects(slack.call('conversations.info'),error=>error.diagnostic.retry_at===400000);
  second.defer('conversations.info',200000);assert.equal(first.deadline('slack.conversations.info'),400000);
  await assert.rejects(openStore(directory,{bot_id:'B999'}),/identity/);
  assert.throws(()=>first.defer('untrusted',123));assert.throws(()=>first.defer('auth.test',-1));
  first.db.prepare('UPDATE provider_deadlines SET retry_at=-1').run();assert.throws(()=>second.deadline('conversations.info'),/Invalid/);
 }finally{first?.close();second?.close();await rm(directory,{recursive:true,force:true});}
});

test('Publisher and watchdog observe each other and another process without reopening or losing deadlines',{skip:process.platform!=='linux'},async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'provider-process-'));let publisher,watchdog,calls=0;
 try{
  publisher=await openStore(directory);watchdog=await openStore(directory);
  const alert=new WatchdogSlack(config,'synthetic',async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'1800'}});},{now:()=>100000,cooldowns:watchdog});
  await assert.rejects(alert.alert('fixture'),error=>error.outcome==='not_sent');
  const client=new SlackHandoff(config,'synthetic',()=>assert.fail('known deadline must prevent HTTP'),{now:()=>100001,cooldowns:publisher});
  await assert.rejects(client.call('chat.postMessage',{},true),error=>error.diagnostic.retry_at===1900000);assert.equal(calls,1);
  publisher.defer('auth.test',2000000);
  const filename=path.join(directory,'provider-cooldowns','cooldowns.sqlite'),identity=scopeDigest({team_id:config.team_id,bot_id:config.bot_id,bot_user_id:config.bot_user_id});
  const source=`import {ProviderCooldowns} from ${JSON.stringify(new URL('../scripts/provider-cooldowns.mjs',import.meta.url).href)}; const c=new ProviderCooldowns(${JSON.stringify(filename)},${JSON.stringify(identity)}); try{if(c.deadline('auth.test')!==2000000)throw Error('missing parent deadline'); c.defer('conversations.history',2100000); c.defer('chat.postMessage',1500000);}finally{c.close();}`;
  const result=await withHandoffLock(directory,async()=>spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:20000}));assert.equal(result.status,0,result.stderr);
  assert.equal(publisher.deadline('chat.postMessage'),1900000);assert.equal(watchdog.deadline('conversations.history'),2100000);
  await assert.rejects(client.history(),error=>error.diagnostic.retry_at===2100000);
  await assert.rejects(alert.preflight(),error=>error.diagnostic.retry_at===2000000);
 }finally{publisher?.close();watchdog?.close();await rm(directory,{recursive:true,force:true});}
});

test('a Publisher cooldown defers watchdog intent and the original alert posts once at the deadline',async()=>{
 const shared=new ProviderCooldowns(':memory:','fixture'),journal=new WatchdogJournal(':memory:',{});let now=1000,posts=0;
 const slack=new WatchdogSlack(config,'synthetic',async(_url,request)=>{posts++;const {text}=JSON.parse(request.body),ts='1793491203.000001';return new Response(JSON.stringify({ok:true,channel:config.channel_id,ts,message:{type:'message',text,user:config.bot_user_id,bot_id:config.bot_id,ts}}));},{now:()=>now,cooldowns:shared});
 const inspection={checked_at:new Date(now).toISOString(),observations:[{category:'publisher_health',issues:['publisher_not_running']}]};
 try{
  shared.defer('chat.postMessage',5000);
  await advanceWatchdogAlerts(journal,slack,inspection,{now});assert.equal(posts,0);assert.equal(journal.pending()[0].phase,'pending');assert.equal(journal.pending()[0].attempts,0);
  now=5000;await advanceWatchdogAlerts(journal,slack,inspection,{now});assert.equal(posts,1);assert.equal(journal.pending().length,0);
  await advanceWatchdogAlerts(journal,slack,inspection,{now});assert.equal(posts,1);
 }finally{shared.close();journal.close();}
});
