import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {encodeBundle} from '../scripts/report-handoff.mjs';
import {digest} from '../scripts/archive.mjs';
import {HandoffState,handoffScope} from '../scripts/handoff-state.mjs';
import {installPageAuthority,authenticatedPrevious,beginPageRound} from '../scripts/research-page-authority.mjs';
import {advanceScheduledDelivery} from '../scripts/scheduled-delivery-bridge.mjs';
import {FILES,SCOPE,DAY} from './helpers/cloud-sender-fixture.mjs';
const paired=process.env.AI_BRIEF_PAIRED_RELAY_DIR;
test('paired actual relay r1 r2 r3 receipts advance bridge and original authority',{skip:!paired},async()=>{
 const pinned=process.env.AI_BRIEF_PAIRED_COMMIT;assert.match(pinned??'',/^[a-f0-9]{40}$/,'Explicit paired Brief commit required');
 const actual=spawnSync('git',['-C',paired,'rev-parse','HEAD'],{encoding:'utf8'});assert.equal(actual.status,0,actual.stderr);assert.equal(actual.stdout.trim(),pinned,'Paired Brief revision differs');
 const config={...SCOPE,scheduled_delivery:{activation_date:DAY,executable:'/usr/bin/python3',args:[]}},s=new HandoffState(':memory:',handoffScope(config));
 try{
  s.db.exec('CREATE TABLE research_control_policy(id INTEGER);CREATE TABLE research_archives(request_id TEXT,hash TEXT,bytes BLOB);CREATE TABLE slack_staged_bundles(request_id TEXT)');installPageAuthority(s.db);
  const root=`reports/${DAY}/`,original=JSON.parse([...FILES].find(([p])=>p.endsWith('/report.json'))[1]);const topics=original.articles.map(a=>a.id),items=[];let previous=null;
  for(let revision=1;revision<=3;revision++){
   const report={...structuredClone(original),schema_version:'1.2',revision,articles:original.articles.slice(0,revision),entries:original.entries.filter(e=>topics.slice(0,revision).includes(e.article_id)),page_delivery:{previous,added:[topics[revision-1]],pending:topics.slice(revision).map(id=>({id,reason:'Pending verification'}))}};
   if(revision>1)report.revision_notice={kind:'page_completion',summary:'Newly verified page'};
   const files=new Map([...FILES].filter(([p])=>!p.includes('/articles/')||topics.slice(0,revision).some(id=>p.endsWith('/'+id+'.md'))).map(([p,b])=>[p.replace('/r1/','/'),b]));files.set(root+'report.json',Buffer.from(JSON.stringify(report)));
   const request_id=`morning-${DAY.replaceAll('-','')}-r${revision}`,bytes=await encodeBundle(files,request_id,'d'.repeat(40),'b'.repeat(40)),hash=digest(bytes),commit=String(revision).repeat(40);
   items.push({request_id,bytes,hash,report,commit,bundle_base64:bytes.toString('base64')});previous={request_id,bundle_sha256:hash};
  }
  const child=spawnSync('python',['tests/helpers/paired-page-relay.py',paired],{input:JSON.stringify(items.map(({bytes,...v})=>v)),encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(child.status,0,child.stderr);const receipts=JSON.parse(child.stdout);assert.equal(receipts[1].delivery_kind,'page_completion');assert.equal(receipts[2].delivery_kind,'page_completion');
  let run={request_id:items[0].request_id,report_date:DAY,permit:null};
  for(const [i,item] of items.entries()){
   const metadata=Buffer.from('{}'),audit=Buffer.from(JSON.stringify({inputs:{draft_sha256:digest(Buffer.from(JSON.stringify(item.report)))},evidence_metadata_sha256:digest(metadata)}));const archive=Buffer.from(JSON.stringify({schema_version:'research_archive_v1',command_id:'11111111-1111-4111-8111-111111111111',request_id:run.request_id,report_date:DAY,previous_sha256:null,files:[['audit.json',audit],['metadata.json',metadata]].map(([path,b])=>({path,sha256:digest(b),content_base64:b.toString('base64')}))}));s.db.prepare('INSERT INTO research_archives VALUES(?,?,?)').run(run.request_id,digest(archive),archive);
   const permit={request_id:item.request_id,bundle_sha256:item.hash,audit_sha256:digest(audit),archive_sha256:digest(archive)};
   if(i===0)run.permit=JSON.stringify(permit);else s.db.prepare('UPDATE research_page_rounds SET permit=? WHERE request_id=?').run(JSON.stringify(permit),item.request_id);
   s.admit({request_id:item.request_id,hash:item.hash,source_ts:`1793491202.00000${i+1}`},item.bytes);s.move(item.request_id,'received','verified',{commit:item.commit,proof:{publication_status:'verified',bundle_sha256:item.hash,commit:item.commit}});
   const result=await advanceScheduledDelivery(s,config,async(_c,q)=>receipts.find(r=>r.request_id===q.request_id));assert.equal(result.phase,'complete');
   assert.equal(authenticatedPrevious(s.db,run,item.request_id).evidence.bundle_sha256,item.hash);
   if(i<2)beginPageRound(s.db,run,{previous_request_id:item.request_id,added:[topics[i+1]]},1);
  }
  const unknownRun=spawnSync('python',['tests/helpers/paired-page-relay.py',paired],{input:JSON.stringify(items.slice(0,2).map(({bytes,...v},i)=>({...v,unknown:i===1}))),encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(unknownRun.status,0,unknownRun.stderr);const unknown=JSON.parse(unknownRun.stdout)[1];assert.equal(unknown.status,'unknown');
  s.db.prepare("UPDATE scheduled_handoffs SET result=?,phase='observed' WHERE request_id=?").run(JSON.stringify(unknown),items[1].request_id);
  assert.throws(()=>authenticatedPrevious(s.db,run,items[1].request_id),/page_previous_delivery_incomplete/);
 }finally{s.close();}
});
