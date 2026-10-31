import {createPrivateKey, sign} from "node:crypto";
import {REPOSITORY} from "./archive.mjs";

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
 if(!positiveInteger(appId)||!positiveInteger(mergerAppId)||appId===mergerAppId)throw Error("Independent pinned Producer and Merger App IDs required");
 const jwt=producerJWT(appId,privateKey,now());
 async function request(method,route,credential,body) {
  let response;
  try {
   response=await fetcher(API+route,{method,headers:{accept:"application/vnd.github+json",authorization:"Bearer "+credential,"x-github-api-version":"2026-03-10","content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000),redirect:"error"});
  } catch {throw Error("Producer authentication request failed; outcome may be unknown; do not retry automatically");}
  if(!response.ok)throw Error("Producer authentication request failed (HTTP "+response.status+"); do not retry automatically");
  if(response.status===204)return {};
  try {return await response.json();} catch {throw Error("Invalid Producer authentication response; do not retry automatically");}
 }
 const installation=await request("GET","/repos/"+REPOSITORY+"/installation",jwt);
 if(!positiveInteger(installation?.id)||installation.app_id!==appId||installation.account?.login!==owner||installation.account?.type!=="Organization"||installation.repository_selection!=="selected"||installation.suspended_at!==null||!exactPermissions(installation.permissions))throw Error("Producer installation identity, selection or permissions mismatch");
 const issued=await request("POST","/app/installations/"+installation.id+"/access_tokens",jwt,{repositories:[repository],permissions});
 if(typeof issued?.token!=="string"||!issued.token||/[\r\n]/.test(issued.token))throw Error("Installation token unavailable; inspect issuance before retrying");
 let result,failure;
 try {
  const expires=Date.parse(issued.expires_at),remaining=expires-now();
  if(!Number.isFinite(remaining)||remaining<60000||remaining>3660000||!exactPermissions(issued.permissions))throw Error("Producer token lifetime or permissions mismatch");
  const accessible=await request("GET","/installation/repositories?per_page=2",issued.token);
  if(accessible?.total_count!==1||accessible.repositories?.length!==1||accessible.repositories[0].full_name!==REPOSITORY||accessible.repositories[0].private!==false)throw Error("Producer token must access only the public report repository");
  result=await use(issued.token);
 } catch(error){failure=error;}
 try {await request("DELETE","/installation/token",issued.token);}
 catch {throw Error("Producer token revocation unconfirmed; inspect the proposal before retrying and let the token expire");}
 if(failure)throw failure;
 return result;
}
