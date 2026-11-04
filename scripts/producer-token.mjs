import {createPrivateKey, sign} from "node:crypto";
import {REPOSITORY} from "./archive.mjs";
import {operationError,rateLimitInfo} from "./github.mjs";

const API="https://api.github.com";
const [owner,repository]=REPOSITORY.split("/");
const permissions=Object.freeze({contents:"write",pull_requests:"write"});
const positiveInteger=n=>Number.isSafeInteger(n)&&n>0;

export function producerJWT(appId,privateKey,now=Date.now()) {
 if(!positiveInteger(appId)||!Number.isFinite(now))throw Error("Pinned Producer App identity and clock required");
 let key;
 try {key=createPrivateKey(privateKey);} catch {throw Error("A valid Producer RSA private key is required");}
 if(key.asymmetricKeyType!=="rsa")throw Error("A Producer RSA private key is required");
 const seconds=Math.floor(now/1000);
 const encode=value=>Buffer.from(JSON.stringify(value)).toString("base64url");
 const message=encode({alg:"RS256",typ:"JWT"})+"."+encode({iss:String(appId),iat:seconds-60,exp:seconds+540});
 return message+"."+sign("RSA-SHA256",Buffer.from(message),key).toString("base64url");
}

function exactPermissions(actual) {
 return actual?.contents==="write"&&actual.pull_requests==="write"&&
  Object.entries(actual).every(([name,value])=>permissions[name]===value||(name==="metadata"&&value==="read"));
}

// Secrets remain in memory. No request retries, redirects, response bodies or tokens are logged.
export async function withProducerToken({appId,mergerAppId,privateKey},use,{fetcher=fetch,now=Date.now}={}) {
 if(!positiveInteger(appId)||!positiveInteger(mergerAppId)||appId===mergerAppId)throw operationError("Independent pinned Producer and Merger App IDs required",{stage:"producer_identity",code:"identity_mismatch"});
 let jwt;
 try {jwt=producerJWT(appId,privateKey,now());}catch {throw operationError("Producer signing identity is invalid",{stage:"producer_identity",code:"signing_failed"});}
 async function request(method,route,credential,body) {
  const stage=method==="POST"?"token_issue":method==="DELETE"?"token_revoke":route.startsWith("/installation/")?"token_scope":"installation_read";
  let response;
  try {
   response=await fetcher(API+route,{method,headers:{accept:"application/vnd.github+json",authorization:"Bearer "+credential,"x-github-api-version":"2026-03-10","content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000),redirect:"error"});
  } catch {throw operationError("Producer authentication request failed; do not retry automatically",{stage,code:"transport",retryable:method==="GET"});}
  const evidence={stage,http_status:response.status,request_id:response.headers?.get?.("x-github-request-id")};
  const {limited,retry_at}=await rateLimitInfo(response,now());
  // Explicit throttling rejects issuance before any proposal runs. Uncertain
  // issuance and revocation still require reconciliation, never a blind retry.
  if(!response.ok)throw operationError("Producer authentication request failed (HTTP "+response.status+"); do not retry automatically",{...evidence,retry_at,provider_scope:limited?(['installation_read','token_issue'].includes(stage)?'github.app':'github.producer'):undefined,code:limited?"rate_limited":"http_"+response.status,retryable:method!=="DELETE"&&limited||method==="GET"&&(response.status===408||response.status>=500)});
  if(response.status===204)return {};
  try {return await response.json();} catch {throw operationError("Invalid Producer authentication response; do not retry automatically",{...evidence,code:"invalid_response",retryable:method==="GET"});}
 }
 const installation=await request("GET","/repos/"+REPOSITORY+"/installation",jwt);
 if(!positiveInteger(installation?.id)||installation.app_id!==appId||installation.account?.login!==owner||installation.account?.type!=="Organization"||installation.repository_selection!=="selected"||installation.suspended_at!==null||!exactPermissions(installation.permissions))throw operationError("Producer installation identity, selection or permissions mismatch",{stage:"installation_read",code:"identity_mismatch"});
 const issued=await request("POST","/app/installations/"+installation.id+"/access_tokens",jwt,{repositories:[repository],permissions});
 if(typeof issued?.token!=="string"||!issued.token||/[\r\n]/.test(issued.token))throw operationError("Installation token unavailable; inspect issuance before retrying",{stage:"token_issue",code:"invalid_response"});
 let result,failure,expiryKnown=false;const expires=Date.parse(issued.expires_at);
 try {
  const remaining=expires-now();
  if(!Number.isFinite(remaining)||remaining<60000||remaining>3660000||!exactPermissions(issued.permissions))throw operationError("Producer token lifetime or permissions mismatch",{stage:"token_scope",code:"identity_mismatch"});
  expiryKnown=true;
  const accessible=await request("GET","/installation/repositories?per_page=2",issued.token);
  if(accessible?.total_count!==1||accessible.repositories?.length!==1||accessible.repositories[0].full_name!==REPOSITORY||accessible.repositories[0].private!==false)throw operationError("Producer token must access only the public report repository",{stage:"token_scope",code:"identity_mismatch"});
  result=await use(issued.token);
 } catch(error){failure=error;}
 try {await request("DELETE","/installation/token",issued.token);}
 catch(error) {
  // A confirmed pre-write transient failure may resume only after this issued
  // credential expires. Cleanup delay is distinct from a provider quota reset.
  const recoverable=expiryKnown&&failure?.diagnostic?.outcome==='not_started'&&failure.diagnostic.retryable===true;
  const retry_at=Math.max(error.diagnostic?.retry_at??0,failure?.diagnostic?.retry_at??0)||undefined;
  throw operationError("Producer token revocation unconfirmed; inspect the proposal before retrying and let the token expire",{...error.diagnostic,provider_scope:error.diagnostic?.provider_scope??failure?.diagnostic?.provider_scope,retry_at,cleanup_after:expiryKnown?expires+60000:undefined,outcome:failure?.diagnostic?.outcome||"unknown",retryable:recoverable});
 }
 if(failure)throw failure;
 return result;
}
