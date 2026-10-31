// Single bounded tick, suitable for a separately approved 120-second service timer.
// No default config, environment token, daemon, scheduler or deployment is installed.
import {open,lstat,realpath} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {HandoffState} from "./handoff-state.mjs";
import {SlackHandoff,publicGitHub} from "./slack-handoff.mjs";
import {acceptMessage,decodeBundle,requireThat,verifyReportPublication} from "./report-handoff.mjs";
import {advanceHandoff} from "./handoff-worker.mjs";
import {proposeWithApp} from "./propose-with-app.mjs";
async function privateDirectory(dir){
 requireThat(path.isAbsolute(dir)&&await realpath(dir)===path.resolve(dir),"Private directory must be absolute and not symlinked");
 const s=await lstat(dir);requireThat(s.isDirectory()&&s.uid===process.getuid()&&(s.mode&0o077)===0,"Private directory must be owner-only");
}
async function privateFile(filename,limit,read=true){
 await privateDirectory(path.dirname(filename));
 const f=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await f.stat();requireThat(s.isFile()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size<=limit,"Private file ownership/mode/size");return read?await f.readFile():undefined;}finally{await f.close();}
}
export function validateConfig(c){
 const keys=["team_id","channel_id","sender_user_id","bot_user_id","bot_id","producer_app_id","merger_app_id","slack_token_file","producer_key_file","state_dir","ready_for_review"];
 const appSender=c&&(Object.hasOwn(c,"sender_bot_id")||Object.hasOwn(c,"sender_app_id"));
 const userAppSender=c&&(Object.hasOwn(c,"sender_user_app_id")||Object.hasOwn(c,"sender_attribution_text"));
 if(appSender)keys.push("sender_bot_id","sender_app_id");
 if(userAppSender)keys.push("sender_user_app_id","sender_attribution_text");
 requireThat(c&&Object.keys(c).sort().join()===keys.sort().join(),"Unexpected publisher config");
 for(const [key,prefix]of [["team_id","T"],["channel_id","[CG]"],["sender_user_id","U"],["bot_user_id","U"],["bot_id","B"]])requireThat(new RegExp("^"+prefix+"[A-Z0-9]+$").test(c[key]),"Publisher identity config");
 requireThat(c.sender_user_id!==c.bot_user_id&&typeof c.ready_for_review==="boolean"&&Number.isSafeInteger(c.producer_app_id)&&c.producer_app_id>0&&Number.isSafeInteger(c.merger_app_id)&&c.merger_app_id>0&&c.producer_app_id!==c.merger_app_id,"Independent publisher identities required");
 if(appSender)requireThat(typeof c.sender_bot_id==="string"&&/^B[A-Z0-9]+$/.test(c.sender_bot_id)&&typeof c.sender_app_id==="string"&&/^A[A-Z0-9]+$/.test(c.sender_app_id)&&c.sender_bot_id!==c.bot_id,"Explicit independent Slack App sender required");
 if(userAppSender)requireThat(!appSender&&typeof c.sender_user_app_id==="string"&&/^A[A-Z0-9]+$/.test(c.sender_user_app_id)&&typeof c.sender_attribution_text==="string"&&c.sender_attribution_text.length<=200&&/^\*[^*\r\n<>]+\* <@U[A-Z0-9]+>$/.test(c.sender_attribution_text),"Explicit user-authorized App and exact attribution required");
 for(const k of ["slack_token_file","producer_key_file","state_dir"])requireThat(typeof c[k]==="string"&&path.isAbsolute(c[k]),"Absolute private paths required");
 return c;
}
export async function runHandoff(configFile){
 requireThat(process.platform==="linux","Live publisher requires the reviewed Linux service layout");
 const config=validateConfig(JSON.parse((await privateFile(configFile,16384)).toString("utf8")));
 const token=(await privateFile(config.slack_token_file,8192)).toString("utf8").trim();requireThat(/^xoxb-[a-zA-Z0-9-]+$/.test(token),"Dedicated Slack bot token required");
 const slack=new SlackHandoff(config,token);await slack.preflight();
 await privateDirectory(config.state_dir);
 const filename=path.join(config.state_dir,"handoff.sqlite");
 try{const f=await open(filename,"wx",0o600);await f.close();}catch(e){if(e.code!=="EEXIST")throw e;}
 await privateFile(filename,10*1024*1024*1024,false);
 const {slack_token_file,producer_key_file,state_dir,...scope}=config;
 const state=new HandoffState(filename,scope);
 try{
  const messages=await slack.history();
  for(const message of messages){
   // Ignore other protocols; invalid matching commands fail closed without writes.
   const event=acceptMessage(message,config);if(!event)continue;
   const prior=state.get(event.request_id);
   if(prior){requireThat(prior.hash===event.hash&&prior.source_ts===event.source_ts,"Duplicate request conflict");continue;}
   const bytes=await slack.download(event),bundle=await decodeBundle(bytes);
   requireThat(bundle.data.request_id===event.request_id&&bundle.hash===event.hash,"Message and bundle mismatch");state.admit(event,bytes);
  }
  const io={
   propose:async(files,base)=>proposeWithApp(files,base,{appId:config.producer_app_id,mergerAppId:config.merger_app_id,privateKey:await privateFile(config.producer_key_file,32768)},{ready:config.ready_for_review}),
   readPR:n=>publicGitHub("/pulls/"+n),readCommit:sha=>publicGitHub("/git/commits/"+sha),
   verify:verifyReportPublication,receipt:(thread,proof)=>slack.receipt(thread,proof)
  };
  // One active request per tick bounds the public GitHub polling budget.
  const id=state.pending()[0];if(id)await advanceHandoff(state,id,io);
  return id?{request_id:id,phase:state.get(id).phase}:{phase:"idle"};
 }finally{state.close();}
}
if(import.meta.url===pathToFileURL(process.argv[1]||"").href){
 try{const [config,flag,...extra]=process.argv.slice(2);requireThat(config&&flag==="--live"&&!extra.length,"Usage: node scripts/run-handoff.mjs ABSOLUTE_CONFIG --live (requires separate deployment authorization)");console.log(JSON.stringify(await runHandoff(config)));}
 catch{console.error("Handoff stopped. Inspect durable phase and reconcile before retrying any mutation; no credentials or remote error bodies logged.");process.exitCode=1;}
}
