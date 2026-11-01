// Invoke the installed read-only checker, never a command selected by a message.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {requireThat} from './report-handoff.mjs';

export function validateCheckerConfig(c){
 requireThat(c&&Object.keys(c).sort().join()==='args,executable'&&typeof c.executable==='string'&&path.isAbsolute(c.executable)&&!c.executable.includes('\0')&&Array.isArray(c.args)&&c.args.length<=8&&c.args.every(a=>typeof a==='string'&&a.length<=4096&&!a.includes('\0')),'Fixed local checker command required');
 return c;
}
export function runNoticeChecker(config,request,{timeout=180000}={}){
 validateCheckerConfig(config);
 const input=Buffer.from(JSON.stringify(request));
 requireThat(input.length<=131072&&Number.isSafeInteger(timeout)&&timeout>0&&timeout<=180000,'Checker input/deadline limit');
 return new Promise((resolve,reject)=>{
  const child=spawn(config.executable,config.args,{shell:false,windowsHide:true,stdio:['pipe','pipe','ignore'],env:{PATH:process.env.PATH??'',LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1'}});
  const parts=[];let size=0,failed=false;
  const fail=()=>{if(failed)return;failed=true;child.kill('SIGKILL');reject(Error('Notice checker unavailable'));};
  const timer=setTimeout(fail,timeout);
  child.on('error',fail);child.stdin.on('error',fail);
  child.stdout.on('data',part=>{size+=part.length;if(size>16384)fail();else parts.push(part);});
  child.on('close',code=>{
   clearTimeout(timer);if(failed)return;
   try{
    const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
    requireThat((code===0&&result?.slack_status==='verified')||(code===1&&result?.slack_status==='not_verified'),'Checker did not return a valid outcome');
    resolve(result);
   }catch{reject(Error('Notice checker unavailable'));}
  });
  child.stdin.end(input);
 });
}

export function checkedNoticeResult(result,{request,destination,posterBytes}){
 const invalid={slack_status:'not_verified',wecom_status:'not_checked',publication_status:'not_checked',reason:'notice_read_unverified'};
 if(result?.slack_status!=='verified')return invalid;
 const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.sort().join();
 const r=result.receipt;
 requireThat(exact(result,['slack_status','wecom_status','publication_status','receipt','observed_publication_commit','messages_sent','state_changed'])&&result.wecom_status==='not_checked'&&result.publication_status==='not_checked'&&result.messages_sent===0&&result.state_changed===false&&typeof result.observed_publication_commit==='string'&&/^[a-f0-9]{40}$/.test(result.observed_publication_commit),'Unexpected checker authority/result');
 requireThat(exact(r,['channel','ts','relay_request_id','file_id','transport_sha256','transport_bytes'])&&r.channel===destination&&r.ts===request.message_ts&&r.relay_request_id==='auto:'+request.message_ts&&r.file_id===request.file_id&&r.transport_sha256===request.notice_manifest.poster.sha256&&r.transport_bytes===posterBytes,'Checker receipt differs from reserved notice');
 return {slack_status:'verified',wecom_status:'not_checked',publication_status:'not_checked',receipt:{...r},observed_publication_commit:result.observed_publication_commit};
}
