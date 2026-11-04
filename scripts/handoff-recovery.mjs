// Persist only structured, bounded diagnostics. Exception messages and HTTP
// bodies may contain credentials or report contents and are never recorded.
const SYMBOL=/^[A-Za-z0-9_.:-]{1,80}$/;
const SYSTEM_CODES=new Set(['ECONNRESET','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','EPIPE','EACCES','EPERM','SQLITE_BUSY','ABORT_ERR']);
const PROVIDER_SCOPES=new Set(['github.public','github.producer','github.app','slack.auth.test','slack.conversations.info','slack.conversations.history','slack.conversations.replies','slack.files.info','slack.chat.postMessage']);
// Only the in-process adapter can attest that no HTTP request was attempted.
// Serialized diagnostics or remote response fields cannot manufacture this proof.
const LOCAL_SLACK_COOLDOWNS=new WeakSet();
export function localSlackCooldown(error){LOCAL_SLACK_COOLDOWNS.add(error);return error;}
export const isLocalSlackCooldown=error=>LOCAL_SLACK_COOLDOWNS.has(error);
export function safeDiagnostic(error,stage='handoff',outcome='unknown'){
 const d=error?.diagnostic??{};
 const result={stage:SYMBOL.test(d.stage??'')?d.stage:stage,code:SYMBOL.test(d.code??'')?d.code:SYSTEM_CODES.has(error?.code)?error.code:'unclassified',outcome:['not_started','unknown'].includes(d.outcome)?d.outcome:outcome,retryable:d.retryable===true};
 if(Number.isInteger(d.http_status)&&d.http_status>=100&&d.http_status<=599)result.http_status=d.http_status;
 if(typeof d.request_id==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(d.request_id))result.request_id=d.request_id;
 if(Number.isSafeInteger(d.retry_at)&&d.retry_at>=0&&d.retry_at<=8640000000000000)result.retry_at=d.retry_at;
 if(Number.isSafeInteger(d.cleanup_after)&&d.cleanup_after>0&&d.cleanup_after<=8640000000000000)result.cleanup_after=d.cleanup_after;
 if(['github.public','github.producer','github.app'].includes(d.provider_scope))result.provider_scope=d.provider_scope;
 return result;
}
export function recoveryDelay(attempts){return Math.min(300000,1000*2**Math.min(9,Math.max(1,attempts)));}
export function failureDetail(detail,error,stage,now=Date.now()){
 const previous=detail.recovery??{},attempts=Math.min(1000000,(previous.attempts??0)+1);
 const last_error={...safeDiagnostic(error,stage),at:now};
 const cooldowns=Object.fromEntries(Object.entries(previous.cooldowns??{}).filter(([scope,at])=>PROVIDER_SCOPES.has(scope)&&Number.isSafeInteger(at)&&at>now&&at<=8640000000000000));
 const scope=last_error.provider_scope??last_error.stage;
 if(PROVIDER_SCOPES.has(scope)&&last_error.retry_at>now)cooldowns[scope]=Math.max(cooldowns[scope]??0,last_error.retry_at);
 // Token expiry constrains another proposal, not public reconciliation. Keep
 // that restriction independently so subsequent read failures cannot erase it.
 const proposal_after=Math.max(previous.proposal_after??0,last_error.cleanup_after??0);
 const publicReconciliation=stage==='proposal'&&last_error.outcome==='unknown'&&['github.app','github.producer'].includes(scope);
 return {...detail,recovery:{...previous,cooldowns,proposal_after,attempts,last_attempt_at:now,next_at:Math.max(now+recoveryDelay(attempts),publicReconciliation?0:last_error.retry_at??0),last_error,errors:[...(previous.errors??[]).slice(-7),last_error]}};
}
export function recordHandoffFailure(state,id,error,now=Date.now()){
 const job=state.metadata(id);if(!job)return;
 state.move(id,job.phase,job.phase,failureDetail(job.detail,error,job.phase,now));
}
export function attemptDetail(detail,now=Date.now()){
 return {...detail,recovery:{...detail.recovery,last_attempt_at:now,next_at:0}};
}
