// Offline adapters only. Publisher grant/record decisions use the real outbox.
// Slack timestamps and the host wall clock can be varied independently.
import assert from 'node:assert/strict';
import {readReports,digest} from '../../scripts/archive.mjs';
import {decodeBundle} from '../../scripts/report-handoff.mjs';
import {HandoffState} from '../../scripts/handoff-state.mjs';
import {NoticeOutbox,advanceNotice,notificationScope} from '../../scripts/notice-outbox.mjs';
import {createNoticeManifest} from '../../scripts/notice-manifest.mjs';
import {CloudRunState,CloudSender,prepareCloudRun} from '../../scripts/cloud-sender.mjs';
import {publicationSite} from './publication-site.mjs';
export const TARGET=1793491200000, DAY='2026-11-01', ID='report-cloud-rebuilt', BASE='a'.repeat(40), MERGE='c'.repeat(40);
export const SCOPE={team_id:'T123',channel_id:'C123',notification_destination:'D123',sender_user_id:'U123',sender_user_app_id:'A123',sender_attribution_text:'*Sent using* <@U789>',bot_user_id:'U456',bot_id:'B456',transport_profile:{adapter:'offline-fixture',version:'v1',evidence_id:'not-production-evidence'}};
export const PROMPTS={commit:'b'.repeat(40),prompts:Object.fromEntries(['research.md','editor.md'].map(name=>{const b=Buffer.from('offline prompt '+name);return [name,{sha256:digest(b),base64:b.toString('base64')}];}))};
const dir=`reports/${DAY}/r1/`;
export const FILES=new Map([...await readReports('.')].filter(([p])=>p.startsWith(dir)));
function nativeCommand(text,ts,fileId,scope){return {type:'message',user:scope.sender_user_id,app_id:scope.sender_user_app_id,ts,text:text+' '+scope.sender_attribution_text,files:[{id:fileId}],blocks:[{type:'rich_text',elements:[{type:'rich_text_section',elements:[{type:'text',text}]}]},{type:'context',elements:[{type:'mrkdwn',text:scope.sender_attribution_text,verbatim:false}]}]};}
export async function rig({filename=':memory:',start=TARGET,target=TARGET,scope=SCOPE}={}){
 const clock={utc:start,wall:start},calls=[],counts={control:0,poster:0,complete:0},modes={},controls=new Map(),replies=new Map();let final=null,serial=1;
 const state=new CloudRunState(filename,scope);
 await prepareCloudRun(state,{id:ID,files:FILES,base:BASE,prompts:PROMPTS,not_before:new Date(target).toISOString()});
 const bundle=await decodeBundle(state.get(ID).bundle),poster=bundle.files.get(dir+bundle.report.poster),manifest=createNoticeManifest(bundle.files.get(dir+'report.json'),MERGE);
 const site=publicationSite({files:bundle.files,slug:`${DAY}/r1`,sourceCommit:MERGE});
 const publisherConfig={...scope,ready_for_review:true,producer_app_id:1,merger_app_id:2,notification_not_before:'1793480000.000001'};
 const publisher=new HandoffState(':memory:',publisherConfig),outbox=new NoticeOutbox(publisher,notificationScope(publisherConfig));
 const next=()=>`${Math.floor(clock.utc/1000)}.${String(serial++).padStart(6,'0')}`;
 const envelope=m=>({complete:true,read_context:{team_id:scope.team_id,channel_id:scope.channel_id},message:m});
 const reply=(text,ts)=>envelope({type:'message',subtype:'bot_message',user:scope.bot_user_id,bot_id:scope.bot_id,ts:next(),thread_ts:ts,text});
 const proof={schema_version:'1.0',status:'published',publication_status:'verified',delivery_allowed:false,request_id:ID,bundle_sha256:bundle.hash,edition:`${DAY}/r1`,commit:MERGE,url:manifest.index_url,poster_sha256:digest(poster),pr:'https://github.com/sfcloud-ai/ai-infra-reports/pull/10'};
 const io={
  shareControl:async ({channel_id,filename,bytes,initial_comment})=>{
   counts.control++;assert.equal(channel_id,scope.channel_id);if(modes.controlMissing)throw Error('unknown control outcome');
   const data=JSON.parse(bytes),commandId=data.command_id??data.request_id,source=next(),fileId='FC'+serial;
   controls.set(commandId,{...envelope(nativeCommand(initial_comment,source,fileId,scope)),bytes:Buffer.from(bytes),file:{id:fileId,user:scope.sender_user_id,user_team:scope.team_id,mode:'snippet',name:filename,is_external:false,size:bytes.length,shares:{private:{[scope.channel_id]:[{ts:source}]}}}});
   if(data.command_id){outbox.admit({request_id:data.command_id,hash:digest(bytes),source_ts:source},bytes);await advanceNotice(outbox,data.command_id,{verify:async()=>proof,receipt:async(ts,text)=>{const e=reply(text,ts);replies.set(ts,e);return e.message.ts;}});}
   else{publisher.admit({request_id:ID,hash:bundle.hash,source_ts:source},bytes);publisher.move(ID,'received','receipt_sent',{commit:MERGE});replies.set(source,reply('!ai-report receipt '+JSON.stringify(proof),source));}
   if(modes.controlTimeout)throw Error('lost acknowledgment');return {signed_url:'must-not-persist'};
  },
  readControlUpload:async ({command_id})=>{if(modes.controlReadError)throw Error('history temporarily unavailable');return controls.get(command_id)??null;},
  readPublication:async ({source_ts})=>{if(modes.publicationReadError)throw Error('receipt read unavailable');return replies.get(source_ts)??null;},
  readNoticeResponse:async ({source_ts})=>modes.grantPending?null:replies.get(source_ts)??null,
  assertTransport:async (profile,context)=>{assert.deepEqual(profile,scope.transport_profile);assert.equal(context.notification_destination,scope.notification_destination);if(modes.unverifiedTransport)throw Error('runtime transport not verified');},
  uploadUnsharedPoster:async ({bytes})=>{counts.poster++;assert.deepEqual(bytes,poster);if(modes.posterUnknown)throw Error('upload ticket acknowledgment lost');return {file_id:'FPOSTER',signed_url:'must-not-persist'};},
  completeFinalUpload:async ({channel_id,file_id,initial_comment})=>{counts.complete++;assert.equal(channel_id,scope.notification_destination);assert.equal(file_id,'FPOSTER');assert.equal(initial_comment,manifest.text);if(!modes.finalMissing)final={complete:true,read_context:{team_id:scope.team_id,channel_id:scope.notification_destination},file_id,ts:next(),poster:Buffer.from(poster),text:initial_comment};if(modes.finalTimeout)throw Error('completion acknowledgment lost');return {ok:true};},
  readFinalByFile:async ({channel_id,file_id})=>{assert.equal(channel_id,scope.notification_destination);assert.equal(file_id,'FPOSTER');if(modes.finalReadError)throw Error('DM read unavailable');return final;},
  // Native message parsing belongs to the external brief checker. This fixture
  // only asserts this adapter receives the original data; it is not its oracle.
  checkFinalNotice:async ({scope:context,manifest:planned,file_id,evidence})=>{assert.equal(context.notification_destination,scope.notification_destination);assert.equal(planned.text,manifest.text);assert.equal(file_id,evidence.file_id);if(modes.checkerError)throw Error('native notice rejected');return {slack_status:'verified',wecom_status:'not_checked',receipt:{channel:scope.notification_destination,ts:evidence.ts,file_id,transport_sha256:modes.posterMismatch?'0'.repeat(64):digest(evidence.poster),transport_bytes:evidence.poster.length}};},
  fetchPublic:async (url,options)=>{if(modes.pagesUnavailable)throw Error('public Pages unavailable');return site.fetcher(url,options);},
 };
 for(const [name,method] of Object.entries(io))io[name]=async(...args)=>{calls.push({name,utc:clock.utc,wall:clock.wall});return method(...args);};
 const makeSender=s=>new CloudSender(s??state,io,{now:()=>clock.wall});
 const sender=makeSender();
 return {state,scope,sender,makeSender,clock,calls,counts,modes,controls,replies,publisher,outbox,io,bundle,poster,manifest,advance(ms,{wall=ms}={}){clock.utc+=ms;clock.wall+=wall;},claimCount(){return [...controls.values()].filter(e=>JSON.parse(e.bytes).action==='claim').length;},close(){state.close();publisher.close();}};
}
export async function toClaim(r){for(let i=0;i<3;i++)await r.sender.step(ID);assert.equal(r.state.get(ID).phase,'claim_wait');}
export async function arm(r){await toClaim(r);await r.sender.step(ID);assert.equal(r.state.get(ID).phase,'final_ready');}
export async function send(r){await arm(r);await r.sender.step(ID);assert.equal(r.state.get(ID).phase,'final_pending');}
