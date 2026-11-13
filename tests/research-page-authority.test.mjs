import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {digest} from '../scripts/archive.mjs';
import {installPageAuthority,beginPageRound,authenticatedPrevious,pagePublicationBinding,appendPagePermit,publicationPermit} from '../scripts/research-page-authority.mjs';
import {TOPIC_IDS} from '../scripts/page-delivery.mjs';
const root='morning-20261113-r1',sha='a'.repeat(40),audit='b'.repeat(64),archive='c'.repeat(64);
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE research_archives(request_id TEXT,hash TEXT,bytes BLOB); CREATE TABLE research_control_policy(id INTEGER); CREATE TABLE jobs(id TEXT,hash TEXT,bytes BLOB,detail TEXT); CREATE TABLE scheduled_handoffs(request_id TEXT,phase TEXT,binding TEXT,result TEXT); CREATE TABLE slack_staged_bundles(request_id TEXT)');installPageAuthority(db);
 const article={id:TOPIC_IDS[0],title:'Original',summary:'Original summary',sha256:digest(Buffer.from('article'))};
 const report={schema_version:'1.2',date:'2026-11-13',revision:1,articles:[article],page_delivery:{previous:null,added:[article.id],pending:TOPIC_IDS.slice(1).map(id=>({id,reason:'Pending evidence'}))}};
 const file=(path,text)=>({path,base64:Buffer.from(text).toString('base64'),sha256:digest(Buffer.from(text))});
 const files=[file('reports/2026-11-13/report.json',JSON.stringify(report)),file('reports/2026-11-13/articles/'+article.id+'.md','article')];
 const bundle={request_id:root,files},bytes=Buffer.from(JSON.stringify(bundle)),hash=digest(bytes);
 const metadata=Buffer.from('{}'),summary=Buffer.from(JSON.stringify({inputs:{draft_sha256:files[0].sha256},evidence_metadata_sha256:digest(metadata)}));
 const ar=Buffer.from(JSON.stringify({schema_version:'research_archive_v1',command_id:'11111111-1111-4111-8111-111111111111',request_id:root,report_date:report.date,previous_sha256:null,files:[['audit.json',metadata],['summary.json',summary]].map(([path,data])=>({path,sha256:digest(data),content_base64:data.toString('base64')}))}));
 db.prepare('INSERT INTO research_archives VALUES(?,?,?)').run(root,digest(ar),ar);
 const permit={permit_id:'first',request_id:root,bundle_sha256:hash,audit_sha256:digest(summary),archive_sha256:digest(ar)};
 const run={request_id:root,report_date:report.date,permit:JSON.stringify(permit)};
 db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run(root,hash,bytes,JSON.stringify({commit:sha,proof:{publication_status:'verified',bundle_sha256:hash,commit:sha}}));
 const binding={request_id:root,report_date:report.date,report_commit:sha,bundle_sha256:hash};
 const receipt={...binding,status:'sent',phase:'complete',parts_sent:2,parts_total:2,images:[{file_id:'scheduled-poster',status:'sent',error:null}]};
 db.prepare('INSERT INTO scheduled_handoffs VALUES(?,?,?,?)').run(root,'complete',JSON.stringify(binding),JSON.stringify(receipt));
 return {db,run,report,bundle,receipt,permit};
}
test('successor round is additive, idempotent and original permit survives',()=>{
 const {db,run}=fixture(),args={previous_request_id:root,added:[TOPIC_IDS[1]]};
 const round=beginPageRound(db,run,args,123);assert.equal(round.request_id,'morning-20261113-r2');assert.deepEqual(beginPageRound(db,run,args,456),round);assert.equal(JSON.parse(run.permit).permit_id,'first');
 assert.throws(()=>beginPageRound(db,run,{...args,added:[TOPIC_IDS[2]]},456),/immutable_page_round/);db.close();
});
test('unknown, partial or incomplete per-image receipts cannot open successor',()=>{
 for(const mutate of [r=>r.status='unknown',r=>r.parts_sent=1,r=>r.images[0].status='unknown',r=>r.bundle_sha256='f'.repeat(64)]){
  const {db,run,receipt}=fixture();mutate(receipt);db.prepare('UPDATE scheduled_handoffs SET result=?').run(JSON.stringify(receipt));assert.throws(()=>beginPageRound(db,run,{previous_request_id:root,added:[TOPIC_IDS[1]]},123),/page_previous_delivery/);db.close();
 }
});
test('old unpartitioned/manual/unknown IDs cannot create page authority',()=>{
 const {db,run}=fixture();assert.throws(()=>beginPageRound(db,run,{previous_request_id:'manual-morning-20261113-r1',added:[TOPIC_IDS[1]]},123),/page_previous_permit/);assert.throws(()=>beginPageRound(db,run,{previous_request_id:root,added:[TOPIC_IDS[0]]},123),/page_added_scope/);db.close();
});
test('successor binds exact ready metadata and original article bytes',()=>{
 const {db,run,report,bundle}=fixture();beginPageRound(db,run,{previous_request_id:root,added:[TOPIC_IDS[1]]},123);
 const previous=authenticatedPrevious(db,run,root);const next=structuredClone(report);next.revision=2;next.articles.push({id:TOPIC_IDS[1],title:'Hardware',summary:'New',sha256:'d'.repeat(64)});next.page_delivery={previous:{request_id:root,bundle_sha256:previous.evidence.bundle_sha256},added:[TOPIC_IDS[1]],pending:next.page_delivery.pending.slice(1)};
 const make=()=>{const result=structuredClone(bundle);result.request_id='morning-20261113-r2';result.expected_base_sha=sha;const bytes=Buffer.from(JSON.stringify(next));result.files[0]={...result.files[0],base64:bytes.toString('base64'),sha256:digest(bytes)};return result;};
 assert.equal(pagePublicationBinding(db,run,make()).round.revision,2);
 const changed=make();changed.files[1].base64=Buffer.from('altered').toString('base64');assert.throws(()=>pagePublicationBinding(db,run,changed),/page_previous_(bytes|assets)_changed/);
 next.articles[0].title='Changed';assert.throws(()=>pagePublicationBinding(db,run,make()),/Already delivered pages/);db.close();
});
test('per-round permit is immutable and independently addressable',()=>{
 const {db,run}=fixture();beginPageRound(db,run,{previous_request_id:root,added:[TOPIC_IDS[1]]},123);
 const permit={request_id:'morning-20261113-r2',permit_id:'second',bundle_sha256:'d'.repeat(64)};appendPagePermit(db,run,permit);appendPagePermit(db,run,permit);assert.deepEqual(publicationPermit(db,run,'second'),permit);assert.equal(publicationPermit(db,run,'first').permit_id,'first');assert.throws(()=>appendPagePermit(db,run,{...permit,bundle_sha256:'e'.repeat(64)}),/immutable_page_permit/);db.close();
});
import {permitSubmission,settlePermitSubmission} from '../scripts/research-control-publication.mjs';
import {nativeResearchAuthority} from '../scripts/research-control-client.mjs';
import {randomUUID} from 'node:crypto';
test('successor native intent belongs to original run and unknown completion reconciles without replacing permit',()=>{
 const {db,run}=fixture();beginPageRound(db,run,{previous_request_id:root,added:[TOPIC_IDS[1]]},123);
 db.exec('CREATE TABLE scope(id INTEGER,value TEXT); CREATE TABLE research_control_runs(request_id TEXT,permit TEXT,plan BLOB,revision INTEGER); CREATE TABLE research_control_submissions(source_ts TEXT,permit_id TEXT); CREATE TABLE research_control_ops(operation_id TEXT,request_id TEXT,kind TEXT,operation_key TEXT,phase TEXT,input TEXT,native_result TEXT)');
 db.prepare('INSERT INTO scope VALUES(1,?)').run('scope');
 db.prepare('INSERT INTO research_control_runs VALUES(?,?,?,1)').run(root,run.permit,Buffer.from(JSON.stringify({schema_version:'research_plan_v4'})));
 const permit={permit_id:randomUUID(),request_id:'morning-20261113-r2',report_date:run.report_date,bundle_sha256:'d'.repeat(64),archive_sha256:'e'.repeat(64),publisher_scope_sha256:'scope'};appendPagePermit(db,run,permit);
 const row={request_id:permit.request_id,source_ts:'1794543470.395659',kind:'stage',hash:permit.bundle_sha256,file_id:'FORIGINAL'};
 db.prepare('INSERT INTO research_control_submissions VALUES(?,?)').run(row.source_ts,permit.permit_id);
 const input={permit_id:permit.permit_id,sha256:row.hash,archive_sha256:permit.archive_sha256,file_id:row.file_id,source_ts:null,bytes:10};
 db.prepare('INSERT INTO research_control_ops VALUES(?,?,?,?,?,?,NULL)').run('operation',root,'native','permit:'+permit.permit_id+':complete','unknown',JSON.stringify(input));
 const proof=permitSubmission(db,{research_control:{first_report_date:run.report_date}},row);assert.equal(proof.run_id,root);
 settlePermitSubmission(db,proof,row,10);assert.equal(db.prepare('SELECT revision FROM research_control_runs').get().revision,2);
 assert.equal(db.prepare('SELECT phase FROM research_control_ops').get().phase,'acknowledged');assert.equal(JSON.parse(db.prepare('SELECT permit FROM research_control_runs').get().permit).permit_id,'first');
 assert.throws(()=>permitSubmission(db,{research_control:{first_report_date:run.report_date}},{...row,file_id:'FREPLACEMENT'}),/publication_original_file/);db.close();
});
test('client reserves successor upload under root run and never replays unknown step',async()=>{
 const owner=randomUUID(),permitId=randomUUID(),bytes=Buffer.from('successor'),hash=digest(bytes),archive='f'.repeat(64),child='morning-20261113-r2';
 const permit={permit_id:permitId,request_id:child,bundle_sha256:hash,archive_sha256:archive};let ops=[];const commands=[];
 const control=async raw=>{const c=JSON.parse(raw);commands.push(c);assert.equal(c.request_id,root);const run={owner_id:owner,epoch:1,revision:1,lease_until:10000,permit:{permit_id:'first'}};if(c.action==='upload_status')return {status:'observed',run,permit,operations:ops};assert.equal(c.action,'reserve');return {dispatch_granted:true,operations:c.args.operations};};
 const client=nativeResearchAuthority({request_id:root,owner_id:owner,permit_id:permitId,archive_sha256:archive},control,()=>1);
 await client.before('ticket',null,bytes);assert.equal(client.publication_request_id,child);const op=commands.at(-1).args.operations[0];ops=[{...op,operation_key:op.key,input_hash:op.input_sha256,phase:'unknown'}];
 await assert.rejects(client.before('ticket',null,bytes),/requires reconciliation/);assert.equal(commands.filter(c=>c.action==='reserve').length,1);
});
