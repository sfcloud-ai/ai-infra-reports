import {isRepositoryResearchPlan,isLayeredResearchPlan,operationBudget} from './research-budget.mjs';
// Public, commit-pinned inputs are recovered from Git; they are not private checkpoints.
import {digest} from './archive.mjs';
import {requireThat} from './report-handoff.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {producerCurlEnvironment} from './producer-upload-adapters.mjs';
const SHA=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/;
export const REPOSITORY_RESEARCH_INPUTS_VERSION=1;
export const REPOSITORY_INPUT_PATHS=Object.freeze([
 ...['audit','delivery','editor','research','sources'].map(name=>'ai_brief/resources/prompts/'+name+'.md'),
 'reports/index.json'
]);
export function repositoryResearchInputs(plan){
 requireThat(isRepositoryResearchPlan(plan)&&SHA.test(plan.prompt_commit_sha)&&SHA.test(plan.reports_commit_sha),'Pinned repository input plan required');
 requireThat(plan.files&&Object.keys(plan.files).sort().join()===REPOSITORY_INPUT_PATHS.slice().sort().join()&&Object.values(plan.files).every(hash=>typeof hash==='string'&&HASH.test(hash)),'Exact public repository input paths and hashes required');
 return REPOSITORY_INPUT_PATHS.map(path=>{
  const prompt=path.startsWith('ai_brief/'),repository=prompt?'sfcloud-ai/ai-infra-brief':'sfcloud-ai/ai-infra-reports';
  const commit=prompt?plan.prompt_commit_sha:plan.reports_commit_sha;
  return {repository,commit,path,sha256:plan.files[path],url:`https://raw.githubusercontent.com/${repository}/${commit}/${path}`};
 });
}
export const repositoryResearchInputsHash=plan=>digest(Buffer.from(JSON.stringify(repositoryResearchInputs(plan))));
export function assertResearchOutputFiles(plan,files){
 const refs=repositoryResearchInputs(plan),paths=new Set(refs.flatMap(ref=>[ref.path,repositoryInputCachePath(ref.path)])),hashes=new Set(refs.map(ref=>ref.sha256));
 requireThat(Array.isArray(files)&&files.every(file=>!paths.has(file.path)&&!hashes.has(file.sha256)),'Repository inputs must be references, not checkpoint files');
}
export function repositoryInputCachePath(path){
 requireThat(REPOSITORY_INPUT_PATHS.includes(path),'Unknown repository input');
 return path==='reports/index.json'?'history.json':path.replace('ai_brief/resources/','');
}
export async function fetchRepositoryInput(input,{run=promisify(execFile),environment=process.env,onDiagnostic=()=>{}}={}){
 // Use the existing managed proxy explicitly. No direct fallback, curl config,
 // redirects, inherited NO_PROXY, or automatic provider retries are allowed.
 try{
  const {stdout,stderr}=await run('curl',['-q','--silent','--fail','--proto','=https','--max-redirs','0','--retry','0','--connect-timeout','15','--max-time','30','--max-filesize',String(8*1024*1024),'--write-out','%{stderr}\nREPOSITORY_METRICS %{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total}\n',input.url],{env:producerCurlEnvironment('managed_proxy',environment),encoding:'buffer',maxBuffer:8*1024*1024,timeout:35000,windowsHide:true});
  onDiagnostic(repositoryTransferMetrics(stderr));
  return stdout;
 }catch(cause){
  const code=Number.isInteger(cause.code)?cause.code:null;
  const error=Error('Pinned repository input unavailable through original managed proxy');
  error.retryable=[5,6,7,18,28,52,55,56].includes(code);
  error.diagnostic={...repositoryTransferMetrics(cause.stderr),kind:code===28?'timeout':code===22?'http_error':code===60?'tls_verification':code===null?'transport_configuration':'transport',curl_exit:code,retryable:error.retryable};
  throw error;
 }
}
export async function readRepositoryResearchInputs(plan,read=fetchRepositoryInput){
 const refs=repositoryResearchInputs(plan),files=new Map();let total=0;
 for(const ref of refs){
  const bytes=await read(ref);
  requireThat(Buffer.isBuffer(bytes)&&bytes.length<=8*1024*1024&&digest(bytes)===ref.sha256,'Pinned repository input bytes differ');
  total+=bytes.length;requireThat(total<=12*1024*1024,'Pinned repository inputs too large');
  files.set(ref.path,bytes);
 }
 return files;
}

function repositoryTransferMetrics(stderr){
 const match=Buffer.isBuffer(stderr)||typeof stderr==='string'?String(stderr).match(/(?:^|\n)REPOSITORY_METRICS (\d{3}) ([0-9.]+) ([0-9.]+) ([0-9.]+) ([0-9.]+) ([0-9.]+)(?:\r?\n|$)/):null;
 if(!match)return {};
 const values=match.slice(1).map(Number);if(!values.every(Number.isFinite))return {};
 const [http_status,dns_seconds,tcp_seconds,tls_seconds,first_byte_seconds,total_seconds]=values;
 return {http_status,dns_seconds,tcp_seconds,tls_seconds,first_byte_seconds,total_seconds};
}
