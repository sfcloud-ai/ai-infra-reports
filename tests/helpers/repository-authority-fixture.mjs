// Synthetic authority grants for storage/publication regression fixtures.
// This helper never calls a provider and is not native acceptance evidence.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {digest} from '../../scripts/archive.mjs';
import {REPOSITORY_INPUT_PATHS} from '../../scripts/repository-research-inputs.mjs';
import {installResearchArchive,storeResearchArchive} from '../../scripts/research-archive.mjs';
import {installResearchControl,executeResearchControl,preparePublicationCheck} from '../../scripts/research-control.mjs';
export const fixtureNow=1793491210000,fixtureOwner='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export function fixtureCommand(s,c,action,args,id='morning-20261101-r1'){
 const run=s.db.prepare('SELECT epoch,revision FROM research_control_runs WHERE request_id=?').get(id);
 return Buffer.from(JSON.stringify({schema_version:'research_control_v2',command_id:randomUUID(),request_id:id,action,owner_id:fixtureOwner,epoch:run?.epoch??0,expected_revision:run?.revision??0,args}));
}
export function fixtureControl(s,c,action,args,id){const r=executeResearchControl(s.db,c,fixtureCommand(s,c,action,args,id),fixtureNow);assert.notEqual(r.status,'rejected',r.code);return r;}
export function installFixtureAuthority(s,c,{prompt='b'.repeat(40),reports='a'.repeat(40)}={}){
 if(!s.db.prepare("SELECT 1 FROM sqlite_master WHERE name='research_archive_policy'").get())installResearchArchive(s.db,c,'synthetic archive');
 installResearchControl(s.db,c,'synthetic repository authority');
 const p={schema_version:'research_plan_v3',request_id:'morning-20261101-r1',report_date:'2026-11-01',prompt_commit_sha:prompt,reports_commit_sha:reports,files:Object.fromEntries(REPOSITORY_INPUT_PATHS.map(path=>[path,'e'.repeat(64)])),model_stages:['editor','review'],limits:{max_attempts_per_source:2,max_attempts_per_model:1,operation_timeout_seconds:180,total_budget_seconds:3600}};
 fixtureControl(s,c,'claim',{plan_base64:Buffer.from(JSON.stringify(p)).toString('base64')});fixtureControl(s,c,'inputs',{});
}
export function fixtureNative(s,c,{hash,bytes,file_id='FSOURCE',permit=null,archive=hash,through='complete',source_ts=null}){
 const scope=permit?'permit:'+permit:'archive:'+hash;
 for(const step of ['ticket','post','complete','submit']){
  const key=scope+':'+step;
  let op=s.db.prepare('SELECT * FROM research_control_ops WHERE operation_key=?').get(key);
  if(!op){
   const input={archive_sha256:archive,permit_id:permit,step,file_id:step==='ticket'?null:file_id,source_ts:step==='submit'?source_ts:null,bytes,sha256:hash};
   const operation_id=randomUUID();fixtureControl(s,c,'reserve',{operations:[{operation_id,kind:'native',key,input_sha256:digest(Buffer.from(JSON.stringify(input))),input,max_seconds:0}]});
   op={operation_id,phase:'intent'};
  }
  if(step===through)break;
  if(op.phase!=='acknowledged')fixtureControl(s,c,'settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:null,file_sha256:null,native_result:{file_id,source_ts:step==='complete'?source_ts:null,sha256:hash,bytes}});
 }
}
export async function fixturePublication(s,c,bytes,{source_ts='1793491201.000001',file_id='FFIRST'}={}){
 const audit=Buffer.from(JSON.stringify({schema_version:'1.2',date:'2026-11-01',audit_valid:true,blockers:[],readiness:'ready'}));
 const packet=Buffer.from(JSON.stringify({schema_version:'research_archive_v1',command_id:randomUUID(),request_id:'morning-20261101-r1',report_date:'2026-11-01',previous_sha256:null,files:[['bundle.json',bytes],['audit.json',audit]].map(([path,data])=>({path,sha256:digest(data),content_base64:data.toString('base64')}))}));
 const hash=digest(packet);storeResearchArchive(s.db,{request_id:'morning-20261101-r1',hash,source_ts:'1793491200.000001',file_id:'FOUTPUT'},packet);
 const command=fixtureCommand(s,c,'permit',{archive_sha256:hash,bundle_sha256:digest(bytes),audit_sha256:digest(audit)});
 const result=executeResearchControl(s.db,c,command,fixtureNow,{publicationCheck:await preparePublicationCheck(s.db,command)});assert.equal(result.status,'committed',result.code);
 const permit=result.run.permit.permit_id;fixtureNative(s,c,{hash:digest(bytes),bytes:bytes.length,file_id,permit,archive:hash,through:'submit',source_ts});return permit;
}
