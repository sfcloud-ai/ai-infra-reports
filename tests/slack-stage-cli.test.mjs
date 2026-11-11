import test from 'node:test';
import assert from 'node:assert/strict';
import {stageFile} from '../scripts/slack-stage-cli.mjs';
import {PRODUCER_TOOLS,producerTicket} from '../scripts/producer-upload.mjs';
import {encodeBundle} from '../scripts/report-handoff.mjs';
import {digest} from '../scripts/archive.mjs';
import {FILES} from './helpers/cloud-sender-fixture.mjs';
const bytes=await encodeBundle(FILES,'morning-20261101-r1','a'.repeat(40),'b'.repeat(40));
const ticket={file_id:'FFIRST',upload_url:'https://files.slack.com/upload/v1/synthetic-test-only'};
const confirmed={adapter:'producer_curl_managed_proxy_v1',file_id:ticket.file_id,url_sha256:producerTicket(ticket).url_sha256,bundle_sha256:digest(bytes),metrics:{curl_exit:0,http_status:200,upload_bytes:bytes.length,num_redirects:0,ssl_verify_result:0}};
test('one-shot staging uses real native tool arguments and original bytes; never submits a report',async()=>{
 const calls=[],evidence=[];
 const result=await stageFile(bytes,'C123',async(tool,args)=>{calls.push({tool,args});return tool===PRODUCER_TOOLS.ticket?ticket:{content:[]};},{observe:e=>evidence.push(e),upload:async(request,options)=>{assert.deepEqual(request.bytes,bytes);assert.deepEqual(options,{transport:'managed_proxy'});return confirmed;}});
 assert.deepEqual(calls,[{tool:PRODUCER_TOOLS.ticket,args:{filename:'ai-brief-bundle.json',content_length:bytes.length}},{tool:PRODUCER_TOOLS.complete,args:{file_id:'FFIRST',channel_id:'C123',initial_comment:`!ai-report stage morning-20261101-r1 ${digest(bytes)}`}}]);
 assert.equal(result.publication_allowed,false);assert.equal(evidence[0].file_id,'FFIRST');assert(!JSON.stringify([result,evidence]).includes('https://'));
});
test('unknown POST stops before completion without refreshing ticket or replaying data',async()=>{
 for(const result of [{...confirmed,metrics:{...confirmed.metrics,http_status:0}},{...confirmed,metrics:{...confirmed.metrics,curl_exit:28}},null]){
  let tools=0,posts=0;await assert.rejects(stageFile(bytes,'C123',async()=>{tools++;return ticket;},{upload:async()=>{posts++;if(!result)throw Error('unknown');return result;}}));
  assert.equal(tools,1);assert.equal(posts,1);
 }
});
test('inert probe cannot emit stage or submit commands and requires an exact tiny payload',async()=>{
 const probe=Buffer.from(JSON.stringify({schema_version:'slack_staging_probe_v1',nonce:'11111111-1111-4111-8111-111111111111',payload:'transport validation; no report publication'}));let comment;
 await stageFile(probe,'C123',async(tool,args)=>{if(tool===PRODUCER_TOOLS.ticket){assert.equal(args.filename,'ai-brief-transport-probe.json');return ticket;}comment=args.initial_comment;return {};},{probe:true,upload:async()=>({...confirmed,bundle_sha256:digest(probe),metrics:{...confirmed.metrics,upload_bytes:probe.length}})});
 assert.match(comment,/^!ai-transport-probe /);await assert.rejects(stageFile(bytes,'C123',()=>assert.fail(),{probe:true}));
});
test('private research upload uses its own file and command domain with the same one-shot transport',async()=>{
 const data=Buffer.from('original private source\r\n'),archive=Buffer.from(JSON.stringify({schema_version:'research_archive_v1',command_id:'11111111-1111-4111-8111-111111111111',request_id:'morning-20261101-r1',report_date:'2026-11-01',previous_sha256:null,files:[{path:'audit/source.txt',sha256:digest(data),content_base64:data.toString('base64')}]}));
 const calls=[];
 const result=await stageFile(archive,'C123',async(tool,args)=>{calls.push({tool,args});return tool===PRODUCER_TOOLS.ticket?ticket:{};},{research:true,upload:async({bytes:actual})=>{assert.deepEqual(actual,archive);return {...confirmed,bundle_sha256:digest(archive),metrics:{...confirmed.metrics,upload_bytes:archive.length}};}});
 assert.equal(calls.length,2);assert.equal(calls[0].args.filename,'ai-brief-research-archive.json');assert.equal(calls[1].args.initial_comment,`!ai-research save morning-20261101-r1 ${digest(archive)}`);assert.equal(result.publication_allowed,false);
 await assert.rejects(stageFile(archive,'C123',()=>assert.fail('no write on conflicting modes'),{research:true,probe:true}));
});
