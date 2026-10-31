import {PREFIX} from "./github.mjs";
import {REPOSITORY} from "./archive.mjs";
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const stable=v=>JSON.stringify(canonical(v));
export function publicRuleset(s) {
 return {id:s.id,source:s.source,source_type:s.source_type,target:s.target,enforcement:s.enforcement,updated_at:s.updated_at,conditions:s.conditions,rules:s.rules};
}
export function configurationPolicy(main,other,actionsAppId,now=Date.now()) {
 for(const s of [main,other]){
  if(!Number.isSafeInteger(s?.id)||s.source!==REPOSITORY||s.source_type!=="Repository"||s.target!=="branch"||s.enforcement!=="active"||!Array.isArray(s.bypass_actors)||!Array.isArray(s.rules))throw Error("Complete active repository ruleset required");
  const time=Date.parse(s.updated_at);if(!Number.isFinite(time)||now-time<5000)throw Error("Ruleset must remain unchanged for five seconds before verification");
 }
 if(!Number.isSafeInteger(actionsAppId)||actionsAppId<=0||main.id===other.id)throw Error("Distinct rulesets and Actions identity required");
 if(main.bypass_actors.length||stable(main.conditions)!==stable({ref_name:{include:["refs/heads/main"],exclude:[]}}))throw Error("Main ruleset must have exact scope and no bypass");
 const pr=main.rules.find(r=>r.type==="pull_request")?.parameters;
 if(pr?.require_code_owner_review!==true||pr.dismiss_stale_reviews_on_push!==true)throw Error("Code-owner review with stale approval dismissal is required");
 const has=t=>main.rules.some(r=>r.type===t),status=main.rules.find(r=>r.type==="required_status_checks")?.parameters;
 if(!has("pull_request")||!has("non_fast_forward")||!has("deletion")||status?.strict_required_status_checks_policy!==true||!status.required_status_checks?.some(c=>c.context==="validate"&&c.integration_id===actionsAppId))throw Error("Main requires strict Actions validate and PR/force/deletion protection");
 // Only explicitly named human users may maintain non-main branches. Apps cannot bypass.
 if(other.bypass_actors.some(a=>a.actor_type!=="User"||!Number.isSafeInteger(a.actor_id)||a.actor_id<=0||a.bypass_mode!=="always"))throw Error("Non-main bypass may name human Users only");
 if(stable(other.conditions)!==stable({ref_name:{include:["~ALL"],exclude:["refs/heads/main"]}})||!other.rules.some(r=>r.type==="update"&&r.parameters?.update_allows_fetch_and_merge===false)||!other.rules.some(r=>r.type==="deletion"))throw Error("All non-main branches must deny App updates and deletion");
 if(other.rules.some(r=>r.type==="creation"))throw Error("Report Apps must be able to create a fresh non-main branch");
 return {schema_version:"1.0",actions_app_id:actionsAppId,rulesets:[main,other].map(s=>({...publicRuleset(s),bypass_actors:s.bypass_actors}))};
}

export function mergerPolicy(quality,other,updates,actionsAppId,producerAppId,mergerAppId,now=Date.now()){
 const basic=configurationPolicy(quality,other,actionsAppId,now);
 if(!Number.isSafeInteger(producerAppId)||!Number.isSafeInteger(mergerAppId)||producerAppId<=0||mergerAppId<=0||producerAppId===mergerAppId||[producerAppId,mergerAppId].includes(actionsAppId))throw Error("Independent producer and merger App identities required");
 if(updates?.source!==REPOSITORY||updates.source_type!=="Repository"||updates.target!=="branch"||updates.enforcement!=="active"||!Number.isSafeInteger(updates.id)||[quality.id,other.id].includes(updates.id))throw Error("Separate active main update ruleset required");
 if(stable(updates.conditions)!==stable({ref_name:{include:["refs/heads/main"],exclude:[]}})||updates.rules?.length!==1||updates.rules[0].type!=="update"||updates.rules[0].parameters?.update_allows_fetch_and_merge!==false)throw Error("Main update restriction must be separate from quality rules");
 if(!Array.isArray(updates.bypass_actors)||updates.bypass_actors.filter(a=>a.actor_type==="Integration"&&a.actor_id===mergerAppId&&a.bypass_mode==="always").length!==1||updates.bypass_actors.some(a=>!(a.actor_type==="Integration"&&a.actor_id===mergerAppId&&a.bypass_mode==="always")&&!(a.actor_type==="User"&&Number.isSafeInteger(a.actor_id)&&a.actor_id>0&&a.bypass_mode==="always")))throw Error("Only the trusted merger App and named humans may update main");
 const time=Date.parse(updates.updated_at);if(!Number.isFinite(time)||now-time<5000)throw Error("Update ruleset must remain unchanged for five seconds");
 return {...basic,producer_app_id:producerAppId,merger_app_id:mergerAppId,rulesets:[...basic.rulesets,{...publicRuleset(updates),bypass_actors:updates.bypass_actors}]};
}
export async function verifyRules(api,actionsAppId,policy,identity) {
 if(!policy||policy.schema_version!=="1.0"||policy.actions_app_id!==actionsAppId||policy.rulesets?.length!==3||identity?.producerAppId!==policy.producer_app_id||identity?.mergerAppId!==policy.merger_app_id)throw Error("Owner-verified ruleset policy and separate App identities required");
 const normalized=mergerPolicy(...policy.rulesets,actionsAppId,policy.producer_app_id,policy.merger_app_id);
 for(const expected of normalized.rulesets){
  const live=await api.request("GET",PREFIX+"/rulesets/"+expected.id);
  if(!live||stable(publicRuleset(live))!==stable(publicRuleset(expected)))throw Error("Ruleset changed since owner verification");
  if(live.bypass_actors!==undefined&&stable(live.bypass_actors)!==stable(expected.bypass_actors))throw Error("Ruleset bypass changed");
 }
 return true;
}
