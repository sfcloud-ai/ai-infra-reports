import test from "node:test";
import assert from "node:assert/strict";
import {SlackHandoff} from "../scripts/slack-handoff.mjs";
import {digest} from "../scripts/archive.mjs";
const config={team_id:"T123",channel_id:"C123",sender_user_id:"U123",sender_user_app_id:"A123",sender_attribution_text:"*Tool* <@U123>"};
const now=1793448100000,ts="1793448050.000001",original=Buffer.from("exact original file bytes");
const expected={message_ts:ts,file_id:"F123",name:"poster.png",sha256:digest(original),bytes:original.length};
const envelope=()=>({type:"message",user:"U123",app_id:"A123",ts,files:[{id:"F123"}],text:"Preview only"});
function rig({message=envelope(),file={},data={},download=original}={}){
 const calls=[];
 const fetcher=async(url,options)=>{
  calls.push({url,options});assert.notEqual(options.method,"POST");
  if(url.startsWith("https://files.slack.com/"))return new Response(download);
  const method=new URL(url).pathname.split("/").at(-1);
  if(method==="conversations.history")return Response.json({ok:true,messages:[message],...data});
  assert.equal(method,"files.info");
  return Response.json({ok:true,file:{id:"F123",user:"U123",user_team:"T123",name:"poster.png",mode:"hosted",is_external:false,size:original.length,shares:{private:{C123:[{ts}]}},url_private_download:"https://files.slack.com/files-pri/T123-F123/poster.png",...file}});
 };
 return {slack:new SlackHandoff(config,"synthetic-token",fetcher),calls};
}
test("control image reads exact original file with pinned sender, share, URL and hash",async()=>{
 const r=rig();const proof=await r.slack.controlAsset(expected,now);
 assert.deepEqual(proof,{status:"verified",channel_id:"C123",message_ts:ts,file_id:"F123",sha256:digest(original),bytes:original.length,messages_sent:0});
 const history=new URL(r.calls[0].url);
 assert.equal(history.searchParams.get("channel"),"C123");assert.equal(history.searchParams.get("oldest"),ts);assert.equal(history.searchParams.get("latest"),ts);assert.equal(history.searchParams.get("inclusive"),"true");
 assert.equal(r.calls.length,3);assert.equal(r.calls[2].options.redirect,"error");
});
test("forged, edited, partial or out-of-window control messages cannot authorize an image read",async()=>{
 for(const patch of [{user:"UOTHER"},{app_id:"AOTHER"},{bot_id:"BOTHER"},{edited:{}},{hidden:true},{thread_ts:"1793448000.000001"},{files:[{id:"FOTHER"}]},{ts:"1793448050.000002"},{channel:"COTHER"},{team:"TOTHER"}]){
  const r=rig({message:{...envelope(),...patch}});await assert.rejects(()=>r.slack.controlAsset(expected,now));assert.equal(r.calls.length,1);
 }
 for(const data of [{has_more:true},{response_metadata:{next_cursor:"more"}},{messages:[]},{messages:[envelope(),envelope()]}]){
  const r=rig({data});await assert.rejects(()=>r.slack.controlAsset(expected,now));assert.equal(r.calls.length,1);
 }
 await assert.rejects(()=>rig().slack.controlAsset(expected,now+16*60000),/window/);
});
test("thumbnail, foreign ownership, wrong shares and changed original bytes fail closed",async()=>{
 for(const file of [{user:"UOTHER"},{user_team:"TOTHER"},{name:"renamed.png"},{mode:"external"},{is_external:true},{shares:{private:{C123:[{ts:"1793448051.000001"}]}}},{url_private_download:"https://files.slack.com/files-tmb/T123-F123/poster.png"},{url_private_download:"https://other.invalid/poster.png"}]){
  const r=rig({file});await assert.rejects(()=>r.slack.controlAsset(expected,now));assert.equal(r.calls.length,2);
 }
 await assert.rejects(()=>rig({download:Buffer.alloc(original.length)}).slack.controlAsset(expected,now),/bytes changed/);
 await assert.rejects(()=>rig({download:Buffer.concat([original,Buffer.from("x")])}).slack.controlAsset(expected,now),/size mismatch/);
});
