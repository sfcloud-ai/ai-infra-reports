import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReportFields,revisionNoticeText} from '../scripts/revision-notice.mjs';
import {encodeBundle,decodeBundle} from '../scripts/report-handoff.mjs';
import {verifyScheduledDelivery} from '../scripts/verify-scheduled-delivery.mjs';
import {createNoticeManifest} from '../scripts/notice-manifest.mjs';
import {HandoffState,handoffScope} from '../scripts/handoff-state.mjs';
import {advanceScheduledDelivery} from '../scripts/scheduled-delivery-bridge.mjs';
import {NoticeOutbox,notificationScope,advanceNotice} from '../scripts/notice-outbox.mjs';
import {encodeNoticeCommand} from '../scripts/notice-command.mjs';
import {digest} from '../scripts/archive.mjs';
import {checkDailyDelivery} from '../scripts/publisher-watchdog.mjs';
import {installScheduledTables,requireSettledScheduled} from '../scripts/scheduled-delivery-state.mjs';
import {readReports,migrateArchive,replaceCurrentReport,validateArchive} from '../scripts/archive.mjs';
import {publicationSite} from './helpers/publication-site.mjs';
import {FILES,MERGE,DAY} from './helpers/cloud-sender-fixture.mjs';
const id='morning-20261101-r2',dir=`reports/${DAY}/`;
function files(kind='correction'){
 const result=new Map([...FILES].map(([p,b])=>[p.replace('/r1/','/'),b]));
 const r=JSON.parse(result.get(dir+'report.json'));
 Object.assign(r,{schema_version:'1.1',revision:2,revision_notice:{kind,summary:'更正实验条件与结论。'}});
 result.set(dir+'report.json',Buffer.from(JSON.stringify(r)));return result;
}
const bytes=await encodeBundle(files(),id,'a'.repeat(40),'b'.repeat(40)),bundle=await decodeBundle(bytes);
const report=()=>JSON.parse(bundle.files.get(dir+'report.json'));

test('explicit versioned policy preserves complete initial manifest and original poster',async()=>{
 const r=report();assert.equal(validateReportFields(r).kind,'correction');
 assert.equal(revisionNoticeText(r),`AI Infra 晨报 · ${DAY} · 重要更正\n\n更正实验条件与结论。\n\nhttps://sfcloud-ai.github.io/ai-infra-reports/${DAY}/`);
 const m=createNoticeManifest(bundle.files.get(dir+'report.json'),MERGE,{stableUrls:true});
 assert.equal(m.articles.length,r.articles.length);assert.equal(m.poster.sha256,r.images.find(i=>i.path===r.poster).sha256);
 const site=publicationSite({files:bundle.files,slug:`${DAY}/r2`,sourceCommit:MERGE,stable:true});
 const plan=await verifyScheduledDelivery({bundle_base64:bytes.toString('base64'),report_commit:MERGE},site.fetcher);
 assert.deepEqual(plan.revision_notice,{revision:2,...r.revision_notice});assert.equal(plan.text,m.text);
 assert.deepEqual(Buffer.from(plan.poster_base64,'base64'),bundle.files.get(dir+r.poster));
});

test('legacy metadata remains byte-compatible and maintenance has no update text',()=>{
 const r=report();r.schema_version='1.0';delete r.revision_notice;
 assert.equal(validateReportFields(r),null);assert.doesNotThrow(()=>createNoticeManifest(Buffer.from(JSON.stringify(r)),MERGE));
 const maintenance=report();maintenance.revision_notice.kind='maintenance';assert.equal(revisionNoticeText(maintenance),'');
});

test('legacy revision send routes settle a durable negative response without blocking later commands',async()=>{
 const c={...config,notification_destination:'D123',notification_not_before:'1793447000.000001'};
 const s=new HandoffState(':memory:',handoffScope(c));
 try{
  s.admit({request_id:id,hash:bundle.hash,source_ts:'1793491200.000001'},bytes);
  s.move(id,'received','receipt_sent',{commit:MERGE});
  const outbox=new NoticeOutbox(s,notificationScope(c));let responses=0;
  for(const [i,action] of ['claim','prepare','prepare_bundle','begin','recover_begin','status'].entries()){
   const command={schema_version:'1.0',command_id:`revision-command-${i}`,action,report_request_id:id,bundle_sha256:bundle.hash,attempt_id:'revision-attempt',file_id:'F123'};
   if(action==='recover_begin')continue; // 该命令另有原始恢复凭据，普通发送入口不构造它。
   if(action==='status'){delete command.attempt_id;delete command.file_id;}
   const raw=encodeNoticeCommand(command);outbox.admit({request_id:command.command_id,hash:digest(raw),source_ts:`179349120${i+1}.000001`},raw);
   await advanceNotice(outbox,command.command_id,{verify:()=>assert.fail('policy rejection does not need a new network proof'),receipt:async()=>{responses++;return '1793491210.000001';}});
   assert.equal(outbox.command(command.command_id).phase,'response_sent');
   assert.equal(outbox.command(command.command_id).response.send_authorized,false);
   if(action!=='status')assert.equal(outbox.command(command.command_id).response.reason,'revision_uses_scheduled_delivery');
  }
  assert.equal(responses,5);assert.deepEqual(outbox.pending(),[]);assert.equal(outbox.notice(id),null);
 }finally{s.close();}
});

test('malformed policy and noncanonical revision transport fail before admission',async()=>{
 for(const patch of [{kind:'other'},{summary:' x'},{summary:'x\ny'},{summary:'x'.repeat(601)},{summary:''},{destination:'other'}]){
  const r=report();Object.assign(r.revision_notice,patch);assert.throws(()=>validateReportFields(r));
 }
 for(const patch of [{revision:1},{schema_version:'1.0'},{schema_version:'1.2'}])assert.throws(()=>validateReportFields({...report(),...patch}));
 await assert.rejects(()=>encodeBundle(files(),'arbitrary-new-id','a'.repeat(40),'b'.repeat(40)),/Canonical revision/);
});

test('current archive validates and indexes the revision declaration',async()=>{
 const source=migrateArchive(await readReports('tests/fixtures/archive')),prefix='reports/2026-10-31/';
 const incoming=new Map([...source].filter(([p])=>p.startsWith(prefix)));
 const r=JSON.parse(incoming.get(prefix+'report.json'));Object.assign(r,{schema_version:'1.1',revision:2,revision_notice:{kind:'maintenance',summary:'修复排版。'}});
 incoming.set(prefix+'report.json',Buffer.from(JSON.stringify(r)));
 const next=replaceCurrentReport(source,incoming),parsed=validateArchive(next);
 assert.deepEqual(parsed.reports.find(r=>r.date==='2026-10-31').revision_notice,r.revision_notice);
 r.schema_version='1.0';delete r.revision_notice;incoming.set(prefix+'report.json',Buffer.from(JSON.stringify(r)));
 assert.throws(()=>replaceCurrentReport(source,incoming),/explicit notification policy/);
});

const scheduled={activation_date:DAY,executable:'/usr/bin/python3',args:['/trusted/client.py']};
const config={team_id:'T123',channel_id:'C123',sender_user_id:'U123',bot_user_id:'U456',bot_id:'B456',producer_app_id:10,merger_app_id:11,ready_for_review:false,scheduled_delivery:scheduled};
function state(){const s=new HandoffState(':memory:',handoffScope(config));s.admit({request_id:id,hash:bundle.hash,source_ts:'1793491200.000001'},bytes);s.move(id,'received','verified',{commit:MERGE,proof:{publication_status:'verified',commit:MERGE,bundle_sha256:bundle.hash}});return s;}
const base={request_id:id,report_date:DAY,report_commit:MERGE,bundle_sha256:bundle.hash,report_revision:2,delivery_kind:'revision_update',status:'sent',phase:'complete',parts_total:1,parts_sent:1,images:[]};
test('bridge accepts actual one-part revision receipt and does not invent an image',async()=>{
 const s=state();try{assert.equal((await advanceScheduledDelivery(s,config,async()=>base)).phase,'complete');await advanceScheduledDelivery(s,config,()=>assert.fail('no resend'));}finally{s.close();}
});
test('website-only decision is terminal but never counted as a sent notification',async()=>{
 const s=state();try{
  const result=await advanceScheduledDelivery(s,config,async()=>({...base,delivery_kind:'web_only',phase:'skipped',status:'skipped',parts_total:0,parts_sent:0}));
  assert.equal(result.phase,'skipped');assert.equal(result.wecom_status,'skipped');
  await advanceScheduledDelivery(s,config,()=>assert.fail('no send for policy skip'));
 }finally{s.close();}
});
test('wrong revision, forged completion and incomplete initial cannot pass',async()=>{
 for(const patch of [{report_revision:3},{parts_total:2},{images:[{file_id:'scheduled-poster',status:'sent'}]},{delivery_kind:'initial'},{delivery_kind:'web_only'}]){
  const s=state();try{assert.equal((await advanceScheduledDelivery(s,config,async()=>({...base,...patch}))).phase,'reconcile_pending');}finally{s.close();}
 }
});

test('watchdog follows revision receipts without hiding unknowns or treating a pending edit as a missing day',async()=>{
 const first={request_id:'morning-20261101-r1',report_date:DAY,report_commit:MERGE,bundle_sha256:'1'.repeat(64),published:true};
 const second={...first,request_id:id,bundle_sha256:bundle.hash,report_revision:2,revision_kind:'correction'};
 const original={...first,status:'sent',phase:'complete',parts_sent:2,parts_total:2,images:[{file_id:'scheduled-poster',status:'sent',error:null}]};
 const update={...base};const responses=new Map([[first.request_id,original],[id,update]]);
 const query=async request=>responses.get(request);
 assert.deepEqual((await checkDailyDelivery([first,second],query)).issues,[]);
 responses.set(id,{...base,delivery_kind:'web_only',status:'skipped',phase:'skipped',parts_total:0,parts_sent:0});
 assert.deepEqual((await checkDailyDelivery([first,{...second,revision_kind:'maintenance'}],query)).issues,[]);
 responses.set(id,{...base,status:'unknown',phase:'unknown',parts_sent:0});
 assert.deepEqual((await checkDailyDelivery([first,second],query)).issues,['revision_delivery_incomplete']);
 assert.deepEqual((await checkDailyDelivery([first,{...second,published:false}],query)).issues,[]);
 responses.set(first.request_id,{...original,status:'queued',phase:'superseded',parts_sent:0,superseded_by:id});
 responses.set(id,{...base,delivery_kind:'initial',parts_total:2,parts_sent:2,images:original.images});
 assert.deepEqual((await checkDailyDelivery([first,second],query)).issues,[]);
 responses.set(first.request_id,{...original,status:'unknown',phase:'unknown',parts_sent:0});
 assert.deepEqual((await checkDailyDelivery([first,second],query)).issues,['daily_delivery_incomplete']);
});

test('readiness migration accepts bound terminal revision chains and rejects missing or forged successors',()=>{
 const s=state();try{
  installScheduledTables(s.db,['scheduled_handoffs','scheduled_bridge_scope']);
  const binding={request_id:id,report_date:DAY,report_commit:MERGE,bundle_sha256:bundle.hash};
  const skipped={...base,delivery_kind:'web_only',status:'skipped',phase:'skipped',parts_total:0,parts_sent:0};
  s.db.prepare('INSERT INTO scheduled_handoffs VALUES(?,?,?,?,0)').run(id,JSON.stringify(binding),'skipped',JSON.stringify(skipped));
  requireSettledScheduled(s.db);
  const previous={...binding,request_id:'morning-20261101-r1',bundle_sha256:'1'.repeat(64)};
  s.db.prepare('INSERT INTO scheduled_handoffs VALUES(?,?,?,?,0)').run(previous.request_id,JSON.stringify(previous),'superseded',JSON.stringify({...previous,status:'queued',phase:'superseded',superseded_by:id}));
  requireSettledScheduled(s.db);
  s.db.prepare('UPDATE scheduled_handoffs SET result=? WHERE request_id=?').run(JSON.stringify({...skipped,bundle_sha256:'0'.repeat(64)}),id);
  assert.throws(()=>requireSettledScheduled(s.db));
  s.db.prepare('DELETE FROM scheduled_handoffs WHERE request_id=?').run(id);assert.throws(()=>requireSettledScheduled(s.db));
 }finally{s.close();}
});
