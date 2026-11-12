import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../scripts/archive.mjs';
import {REPOSITORY_INPUT_PATHS,repositoryResearchInputs,repositoryResearchInputsHash,readRepositoryResearchInputs,fetchRepositoryInput} from '../scripts/repository-research-inputs.mjs';
const original=new Map(REPOSITORY_INPUT_PATHS.map(path=>[path,Buffer.from(path+'\r\n')]));
const plan={schema_version:'research_plan_v3',prompt_commit_sha:'a'.repeat(40),reports_commit_sha:'b'.repeat(40),files:Object.fromEntries([...original].map(([path,bytes])=>[path,digest(bytes)]))};

test('fresh reads recover exact Git bytes using separate fixed commits, never main or prior cache',async()=>{
 const requests=[],read=async ref=>{requests.push(ref);return Buffer.from(original.get(ref.path));};
 const first=await readRepositoryResearchInputs(plan,read);first.clear();
 const recovered=await readRepositoryResearchInputs(plan,read);
 assert.deepEqual(recovered,original);assert.equal(requests.length,12);
 for(const ref of requests){const prompt=ref.path.startsWith('ai_brief/');assert.equal(ref.commit,prompt?plan.prompt_commit_sha:plan.reports_commit_sha);assert.equal(ref.url,`https://raw.githubusercontent.com/sfcloud-ai/ai-infra-${prompt?'brief':'reports'}/${ref.commit}/${ref.path}`);}
 assert.equal(repositoryResearchInputsHash({...plan,files:Object.fromEntries(Object.entries(plan.files).reverse())}),repositoryResearchInputsHash(plan));
 assert.notEqual(repositoryResearchInputsHash({...plan,reports_commit_sha:'c'.repeat(40)}),repositoryResearchInputsHash(plan));
});

test('missing, changed or oversized Git inputs fail without a cached or main fallback',async()=>{
 for(const read of [async()=>{throw Error('unavailable');},async()=>Buffer.from('changed'),async()=>Buffer.alloc(8*1024*1024+1)]){
  let calls=0;await assert.rejects(readRepositoryResearchInputs(plan,async ref=>{calls++;return read(ref);}));assert.equal(calls,1);
 }
 for(const changed of [{...plan,prompt_commit_sha:'main'},{...plan,files:{...plan.files,'../private':digest(Buffer.from('x'))}},{...plan,files:{...plan.files,'reports/index.json':'x'}}])assert.throws(()=>repositoryResearchInputs(changed));
});

test('managed fetch keeps proxy, TLS, no redirects/retries and bounded execution',async()=>{
 const calls=[],environment={PATH:'/bin',https_proxy:'http://managed.invalid:3128',NO_PROXY:'*',SECRET:'hidden'};
 const run=async(exe,args,options)=>{calls.push({exe,args,options});const path=REPOSITORY_INPUT_PATHS.find(path=>args.at(-1).endsWith('/'+path));return {stdout:original.get(path)};};
 assert.deepEqual(await readRepositoryResearchInputs(plan,ref=>fetchRepositoryInput(ref,{run,environment})),original);
 assert.equal(calls.length,6);
 for(const {exe,args,options} of calls){assert.equal(exe,'curl');assert.equal(args[0],'-q');assert(args.includes('--fail'));assert(!args.includes('--location'));assert(!args.includes('-k'));assert.equal(args[args.indexOf('--retry')+1],'0');assert.equal(args[args.indexOf('--max-redirs')+1],'0');assert.equal(options.timeout,35000);assert.equal(options.env.NO_PROXY,'');assert.equal(options.env.SECRET,undefined);}
 await assert.rejects(fetchRepositoryInput(repositoryResearchInputs(plan)[0],{run:async()=>{throw Error('403 private response');},environment}),/^Error: Pinned repository input unavailable/);
 await assert.rejects(fetchRepositoryInput(repositoryResearchInputs(plan)[0],{run:()=>assert.fail('no direct fallback'),environment:{}}),/unavailable/);
});
