import test from 'node:test';
import assert from 'node:assert/strict';
import {SlackHandoff} from '../scripts/slack-handoff.mjs';

const config={team_id:'T123',channel_id:'C123',sender_user_id:'U123',sender_user_app_id:'A123'};
const event={file_id:'F123',source_ts:'1794359436.371839'};
function fixture({bytes=Buffer.alloc(845574,97),extra={},size=bytes.length,body=bytes}={}){
 const calls=[];
 const fetcher=async(url,options)=>{
  calls.push(url);assert.notEqual(options.method,'POST');
  if(new URL(url).hostname==='files.slack.com')return new Response(body);
  return Response.json({ok:true,file:{id:'F123',user:'U123',user_team:'T123',name:'ai-brief-bundle.json',mode:'snippet',is_external:false,size,shares:{private:{C123:[{ts:event.source_ts}]}},url_private_download:'https://files.slack.com/files-pri/T123-F123/ai-brief-bundle.json',...extra}});
 };
 return {slack:new SlackHandoff(config,'synthetic',fetcher),calls,bytes};
}
test('native snippet metadata above one MiB preserves exact original file download',async()=>{
 const r=fixture({extra:{content: 'a'.repeat(845574),highlighted_content:'a'.repeat(845574)}});
 assert.deepEqual(await r.slack.download(event),r.bytes);assert.equal(r.calls.length,2);
});
test('metadata envelope and original file limits stay independent and bounded',async()=>{
 const r=fixture({bytes:Buffer.from('small'),extra:{preview:'x'.repeat(1024*1024+100)}});
 await assert.rejects(()=>r.slack.download(event,{limit:10}),/Remote byte limit/);assert.equal(r.calls.length,1);
 const oversized=fixture({size:9*1024*1024});await assert.rejects(()=>oversized.slack.download(event),/metadata/);assert.equal(oversized.calls.length,1);
 const changed=fixture({body:Buffer.alloc(845575,97)});await assert.rejects(()=>changed.slack.download(event),/size mismatch/);
 const tooManyBytes=fixture({bytes:Buffer.from('small'),body:Buffer.alloc(11)});await assert.rejects(()=>tooManyBytes.slack.download(event,{limit:10}),/Remote byte limit/);
});
test('larger metadata allowance does not apply to other Slack API calls',async()=>{
 const slack=new SlackHandoff(config,'synthetic',async()=>Response.json({ok:true,padding:'x'.repeat(1024*1024)}));
 await assert.rejects(()=>slack.call('conversations.history'),/Remote byte limit/);
 await assert.rejects(()=>slack.call('conversations.history',{},false,2*1024*1024),/Bounded Slack metadata/);
 await assert.rejects(()=>slack.call('files.info',{},false,34*1024*1024),/Bounded Slack metadata/);
});
