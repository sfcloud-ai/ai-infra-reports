// stdin is the original host plan; this directory is a disposable cache, never authority.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {decodeResearchPlan} from './research-control.mjs';
import {readRepositoryResearchInputs,repositoryResearchInputsHash,repositoryInputCachePath} from './repository-research-inputs.mjs';
import {requireThat} from './report-handoff.mjs';
try{
 requireThat(process.argv.length===3&&path.isAbsolute(process.argv[2]),'An unused absolute cache directory is required');
 let size=0;const chunks=[];
 for await(const chunk of process.stdin){size+=chunk.length;requireThat(size<=7500,'Original host plan too large');chunks.push(chunk);}
 const bytes=Buffer.concat(chunks),parsed=JSON.parse(bytes),{value:plan}=decodeResearchPlan(bytes.toString('base64'),parsed.request_id);
 const files=await readRepositoryResearchInputs(plan),root=process.argv[2];
 await mkdir(root,{mode:0o700});
 for(const [name,data] of files){const target=path.join(root,repositoryInputCachePath(name));await mkdir(path.dirname(target),{recursive:true,mode:0o700});await writeFile(target,data,{flag:'wx',mode:0o600});}
 console.log(JSON.stringify({request_id:plan.request_id,inputs_hash:repositoryResearchInputsHash(plan),cache:root,files:[...files.keys()].map(repositoryInputCachePath),state_authority:'original_host',persistent_cloud_state_required:false}));
}catch{
 console.error('Repository inputs unavailable or mismatched; preserve the original host plan and retry within the original budget.');process.exitCode=1;
}
