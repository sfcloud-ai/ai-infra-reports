// Local integration fixtures only: no live Slack, publication or delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {HandoffState,handoffScope} from '../scripts/handoff-state.mjs';
import {PublisherInbox} from '../scripts/publisher-inbox.mjs';
import {inspectPublisherDay} from '../scripts/producer-inspect.mjs';
import {installFence,FENCE_SCHEMA} from '../scripts/producer-admission-fence.mjs';
import {encodeBundle} from '../scripts/report-handoff.mjs';
import {digest} from '../scripts/archive.mjs';
import {FILES,SCOPE,DAY} from './helpers/cloud-sender-fixture.mjs';

const id='morning-20261101-r1',bytes=await encodeBundle(FILES,id,'a'.repeat(40),'b'.repeat(40)),hash=digest(bytes);
const fence={generation:'a1111111-1111-4111-8111-111111111111',activation_ts:'1793491200.000000',producer_scope_sha256:'b'.repeat(64),installation:{journal_device:'1',journal_inode:'2',lock_device:'1',lock_inode:'3'}};
const config={...SCOPE,ready_for_review:false,durable_intake:{not_before:'1793462400.000000'},producer_fence:fence};
const query={query_id:'11111111-1111-4111-8111-111111111111',kind:'inspect',request_id:'morning-20261102-r1',report_date:'2026-11-02',bundle_sha256:'d'.repeat(64)};
const source='1793577600.000010';
const old={request_id:id,hash,file_id:'FOLD',source_ts:'1793491201.000001'};
const current={...old,file_id:'FNEW',source_ts:'1793491202.000001'};
function setup(file=':memory:'){
 const state=new HandoffState(file,handoffScope(config));installFence(state.db,fence,'synthetic migration',[]);
 const inbox=new PublisherInbox(state,config);
 state.db.prepare('UPDATE publisher_intake_scan SET watermark=?').run(source);
 return {state,inbox};
}
function insert(state,event){state.db.prepare('INSERT INTO publisher_inbox(source_ts,request_id,file_id,hash) VALUES (?,?,?,?)').run(event.source_ts,event.request_id,event.file_id,event.hash);}
function grant(state,event=current){state.db.prepare('INSERT INTO producer_admission_grants VALUES(?,?,?,?,?,?,?,NULL)').run(id,DAY,hash,event.file_id,fence.generation,'b1111111-1111-4111-8111-111111111111',1793491201000);}
function message(event){const text=`!ai-report publish ${id} ${hash}`;return {type:'message',user:SCOPE.sender_user_id,app_id:SCOPE.sender_user_app_id,ts:event.source_ts,text:text+' '+SCOPE.sender_attribution_text,files:[{id:event.file_id}],blocks:[{type:'rich_text',elements:[{type:'rich_text_section',elements:[{type:'text',text}]}]},{type:'context',elements:[{type:'mrkdwn',text:SCOPE.sender_attribution_text,verbatim:false}]}]};}

test('late obsolete envelope stays fenced after the designated upload is admitted and next-day inspect progresses',async()=>{
 const {state,inbox}=setup();let downloads=0;
 const slack={exactPublish:async()=>message(current),download:async()=>{downloads++;return bytes;}};
 try{
  insert(state,old);assert.equal((await inbox.admitOne(slack)).code,'producer_upload_fenced');assert.equal(downloads,0);
  grant(state);insert(state,current);assert.equal(await inbox.admitOne(slack),undefined);assert.equal(downloads,1);
  assert.equal(state.metadata(id).detail.intake_file_id,current.file_id);
  assert.equal((await inspectPublisherDay(state,config,query,source)).publisher,null);
  assert.equal(state.db.prepare('SELECT phase FROM publisher_inbox WHERE source_ts=?').get(old.source_ts).phase,'fenced');
 }finally{state.close();}
});

const python=process.platform==='win32'?'python':'python3';
function snapshot(file,settled=true){return spawnSync(python,['-B','-c',`from pathlib import Path; from deployment.publisher_cd import snapshot; print(snapshot(Path(${JSON.stringify(file)}), settled=${settled?'True':'False'}))`],{encoding:'utf8',timeout:10000});}
test('CD fingerprints the exact installed fence and retained ineligible inbox without blocking settled upgrades',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'producer-fence-cd-')),file=join(dir,'handoff.sqlite'),{state,inbox}=setup(file);
 try{
  insert(state,old);await inbox.admitOne({});
  const original=snapshot(file);assert.equal(original.status,0,original.stderr);
  state.db.prepare('INSERT INTO producer_quarantined_dates VALUES(?,?)').run('2026-10-31','original unresolved operation');
  const changed=snapshot(file);assert.equal(changed.status,0,changed.stderr);assert.notEqual(changed.stdout,original.stdout);
  // A label alone is insufficient: a now-eligible grant must defer the switch.
  grant(state,old);assert.notEqual(snapshot(file).status,0);assert.equal(snapshot(file,false).status,0);
  state.db.exec('CREATE INDEX unexpected_fence_index ON producer_admission_grants(hash)');
  const malformed=snapshot(file,false);assert.notEqual(malformed.status,0);assert.match(malformed.stderr,/unsupported_producer_fence_schema/);
 }finally{state.close();await rm(dir,{recursive:true,force:true});}
});
test('CD fence schema matches the runtime exactly',()=>{
 const result=spawnSync(python,['-B','-c','import json; from deployment.publisher_cd import PRODUCER_FENCE_SCHEMA; print(json.dumps(PRODUCER_FENCE_SCHEMA))'],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),FENCE_SCHEMA);
});
