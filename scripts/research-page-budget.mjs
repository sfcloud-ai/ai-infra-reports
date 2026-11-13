import {currentPageRound} from './research-page-authority.mjs';
// Page rounds do not create a second research run or reset global accounting.
// Only a host-authenticated open round can extend the original plan's model keys.
export function activePageResearch(db,run,plan){
 if(run.permit===null)return {active:true,modelKeys:plan.model_stages};
 const round=currentPageRound(db,run.request_id);
 if(!round||round.run_id!==run.request_id||round.permit!==null)return {active:false,modelKeys:[]};
 let added;try{added=JSON.parse(round.added);}catch{return {active:false,modelKeys:[]};}
 if(!Array.isArray(added)||added.length===0)return {active:false,modelKeys:[]};
 return {active:true,modelKeys:plan.model_stages.map(stage=>`${stage}:${round.request_id}`)};
}
export function pageModelKeyAllowed(scope,key){return scope.active&&scope.modelKeys.includes(key);}
