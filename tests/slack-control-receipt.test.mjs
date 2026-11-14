import test from 'node:test';
import assert from 'node:assert/strict';
import {SlackHandoff} from '../scripts/slack-handoff.mjs';
const config={team_id:'T123',channel_id:'C123',bot_user_id:'U456',bot_id:'B456'};
const thread='1793491200.000001',ts='1793491201.000001';
const escaped=text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const receipt=text=>({type:'message',ts,thread_ts:thread,text,user:'U456',bot_id:'B456'});
function client(messages,{post=false,patch={}}={}){
 const calls=[];
 const slack=new SlackHandoff(config,'fixture',async(url,options)=>{
  calls.push(options.method);
  if(post){assert.equal(options.method,'POST');assert.equal(new URL(url).pathname,'/api/chat.postMessage');return Response.json({ok:true,channel:'C123',ts,message:{...messages[0],...patch}});}
  assert.equal(options.method,'GET','reconciliation must never resend');
  assert.equal(new URL(url).pathname,'/api/conversations.replies');
  return Response.json({ok:true,messages:messages.map(m=>({...m,...patch})),has_more:false});
 });return {slack,calls};
}
test('control receipt accepts raw or one-layer Slack escaping without modifying outbound text',async()=>{
 const text='!ai-research control-receipt '+JSON.stringify({value:'<node> & <@U123> &lt; &amp; &gt;'});
 for(const observed of [text,escaped(text)]){
  let calls=0;
  const slack=new SlackHandoff(config,'fixture',async(_url,options)=>{
   calls++;const request=JSON.parse(options.body);assert.equal(request.text,text);assert.equal(request.mrkdwn,false);assert.equal(request.parse,'none');
   return Response.json({ok:true,channel:'C123',ts,message:receipt(observed)});
  });
  assert.equal(await slack.controlReceipt(thread,text),ts);assert.equal(calls,1);
  const read=client([receipt(observed)]);assert.equal(await read.slack.findControlReceipt(thread,text),ts);assert.deepEqual(read.calls,['GET']);
 }
});
test('receipt matching never decodes the original, recursively decodes, or normalizes other entities',async()=>{
 for(const [text,observed] of [['literal &lt;','literal <'],['literal &amp;','literal &'],['value <','value &amp;lt;'],['value "','value &quot;'],['value <','value &#60;'],['value &','value &AMP;'],['a < b','a &lt;  b'],['receipt',null]]){
  const posted=client([receipt(observed)],{post:true});await assert.rejects(posted.slack.controlReceipt(thread,text));assert.deepEqual(posted.calls,['POST']);
  const read=client([receipt(observed)]);await assert.rejects(read.slack.findControlReceipt(thread,text));assert.deepEqual(read.calls,['GET']);
 }
});
test('escaped receipts retain identity and thread checks and reject ambiguous matches',async()=>{
 const text='receipt <node> & data',message=receipt(escaped(text));
 for(const patch of [{user:'UOTHER'},{bot_id:'BOTHER'},{thread_ts:'1793491200.000002'}]){
  await assert.rejects(client([message],{post:true,patch}).slack.controlReceipt(thread,text));
  await assert.rejects(client([message],{patch}).slack.findControlReceipt(thread,text));
 }
 for(const patch of [{edited:{}},{hidden:true},{team:'TOTHER'},{channel:'COTHER'},{type:'other'},{subtype:'changed'}])await assert.rejects(client([message],{patch}).slack.findControlReceipt(thread,text));
 const ambiguous=client([message,{...receipt(text),ts:'1793491202.000001'}]);
 await assert.rejects(ambiguous.slack.findControlReceipt(thread,text),/ambiguous/);assert.deepEqual(ambiguous.calls,['GET']);
});
