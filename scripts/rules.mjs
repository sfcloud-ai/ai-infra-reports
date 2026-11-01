import {PREFIX} from "./github.mjs";
import {REPOSITORY} from "./archive.mjs";
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const stable=v=>JSON.stringify(canonical(v));
const mainScope={ref_name:{include:["refs/heads/main"],exclude:[]}};
const reportCreationScope={ref_name:{include:["refs/heads/report/*"],exclude:[]}};
const otherCreationScope={ref_name:{include:["~ALL"],exclude:["refs/heads/main","refs/heads/report/*"]}};
const positive=n=>Number.isSafeInteger(n)&&n>0;
const attested=s=>structuredClone({...publicRuleset(s),bypass_actors:s.bypass_actors});
export function publicRuleset(s) {
 return {id:s.id,source:s.source,source_type:s.source_type,target:s.target,enforcement:s.enforcement,updated_at:s.updated_at,conditions:s.conditions,rules:s.rules};
}
function comparableRuleset(s) {
 // GitHub can return the same instant with an offset or Z. Preserve millisecond
 // precision, and reject unsupported/malformed timestamps instead of rounding.
 const value=s.updated_at;
 if(typeof value!=="string"||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))throw Error("Invalid ruleset timestamp");
 return {...publicRuleset(s),updated_at:new Date(value).toISOString()};
}
function active(s,now){
 if(!positive(s?.id)||s.source!==REPOSITORY||s.source_type!=="Repository"||s.target!=="branch"||s.enforcement!=="active"||!Array.isArray(s.bypass_actors)||!Array.isArray(s.rules))throw Error("Complete active repository ruleset required");
 const time=Date.parse(s.updated_at);if(!Number.isFinite(time)||now-time<5000)throw Error("Ruleset must remain unchanged for five seconds before verification");
}
function exactRules(s,types){
 return stable(s.rules.map(r=>r.type).sort())===stable([...types].sort());
}
function deniesFetchMerge(rule){
 // GitHub omits the entire optional parameters object when false is configured
 // on this non-fork repository. A present object must explicitly disable it.
 return rule?.type==="update"&&(rule.parameters===undefined||rule.parameters?.update_allows_fetch_and_merge===false);
}
function humanIds(actors,mode){
 if(!actors.length||actors.some(a=>a.actor_type!=="User"||!positive(a.actor_id)||a.bypass_mode!==mode))throw Error("Bypass must name human Users with the required mode");
 const ids=actors.map(a=>a.actor_id).sort((a,b)=>a-b);
 if(new Set(ids).size!==ids.length)throw Error("Duplicate human bypass identity");
 return ids;
}
function reviewRule(pr,codeOwners){
 return pr?.required_approving_review_count===0&&pr.require_code_owner_review===codeOwners&&pr.require_last_push_approval===false&&pr.dismiss_stale_reviews_on_push===true&&(!pr.required_reviewers||pr.required_reviewers.length===0);
}
export function configurationPolicy(main,other,actionsAppId,now=Date.now()) {
 for(const s of [main,other])active(s,now);
 if(!positive(actionsAppId)||main.id===other.id)throw Error("Distinct rulesets and Actions identity required");
 if(main.bypass_actors.length||stable(main.conditions)!==stable(mainScope))throw Error("Main ruleset must have exact scope and no bypass");
 const pr=main.rules.find(r=>r.type==="pull_request")?.parameters;
 if(!reviewRule(pr,false))throw Error("Main requires a PR with zero approvals and no code-owner or last-push approval requirement");
 const status=main.rules.find(r=>r.type==="required_status_checks")?.parameters;
 if(!exactRules(main,["pull_request","non_fast_forward","deletion","required_status_checks"])||status?.strict_required_status_checks_policy!==true||!status.required_status_checks?.some(c=>c.context==="validate"&&c.integration_id===actionsAppId))throw Error("Main requires strict Actions validate and PR/force/deletion protection");
 humanIds(other.bypass_actors,"always");
 if(stable(other.conditions)!==stable({ref_name:{include:["~ALL"],exclude:["refs/heads/main"]}})||!exactRules(other,["update","deletion"])||!deniesFetchMerge(other.rules.find(r=>r.type==="update")))throw Error("All non-main branches must deny App updates and deletion with creation handled separately");
 return {schema_version:"3.0",actions_app_id:actionsAppId,rulesets:[main,other].map(attested)};
}

export function mergerPolicy(quality,other,updates,codeReview,reportCreation,otherCreation,actionsAppId,producerAppId,mergerAppId,now=Date.now()){
 const basic=configurationPolicy(quality,other,actionsAppId,now);
 if(!positive(producerAppId)||!positive(mergerAppId)||producerAppId===mergerAppId||[producerAppId,mergerAppId].includes(actionsAppId))throw Error("Independent producer and merger App identities required");
 for(const s of [updates,codeReview,reportCreation,otherCreation])active(s,now);
 if(new Set([quality,other,updates,codeReview,reportCreation,otherCreation].map(s=>s.id)).size!==6)throw Error("Six distinct rulesets required");
 if(stable(updates.conditions)!==stable(mainScope)||!exactRules(updates,["update"])||!deniesFetchMerge(updates.rules[0]))throw Error("Main update restriction must be separate from quality rules");
 const mergerActors=updates.bypass_actors.filter(a=>a.actor_type==="Integration");
 if(mergerActors.length!==1||mergerActors[0].actor_id!==mergerAppId||mergerActors[0].bypass_mode!=="always")throw Error("Only the trusted merger App and named humans may update main");
 const humans=humanIds(other.bypass_actors,"always");
 if(stable(humanIds(updates.bypass_actors.filter(a=>a.actor_type!=="Integration"),"always"))!==stable(humans))throw Error("Main and non-main must allow the same named humans");
 if(stable(codeReview.conditions)!==stable(mainScope)||!exactRules(codeReview,["pull_request"])||!reviewRule(codeReview.rules[0].parameters,true))throw Error("Separate code-owner review with stale approval dismissal is required for Apps");
 // Humans bypass only this approval rule, through a PR. Quality rules still block
 // unresolved Request changes and failed/outdated checks for every actor.
 if(stable(humanIds(codeReview.bypass_actors,"pull_request"))!==stable(humans))throw Error("Code-review bypass must match the named human writers");
 // Creation exceptions must not grant updates or deletion. The Producer can
 // create one-level report branches; other non-main branches are human-only.
 for(const [s,scope]of [[reportCreation,reportCreationScope],[otherCreation,otherCreationScope]]){
  if(stable(s.conditions)!==stable(scope)||stable(s.rules)!==stable([{type:"creation"}]))throw Error("Separate exact branch creation scopes and creation-only rules required");
 }
 const creators=reportCreation.bypass_actors.filter(a=>a.actor_type==="Integration");
 if(creators.length!==1||creators[0].actor_id!==producerAppId||creators[0].bypass_mode!=="always")throw Error("Only the trusted Producer App may create report branches alongside named humans");
 if(stable(humanIds(reportCreation.bypass_actors.filter(a=>a.actor_type!=="Integration"),"always"))!==stable(humans)||stable(humanIds(otherCreation.bypass_actors,"always"))!==stable(humans))throw Error("Creation exceptions must match the named human writers");
 return {...basic,producer_app_id:producerAppId,merger_app_id:mergerAppId,rulesets:[...basic.rulesets,...[updates,codeReview,reportCreation,otherCreation].map(attested)]};
}
export async function verifyRules(api,actionsAppId,policy,identity) {
 if(!policy||policy.schema_version!=="3.0"||policy.actions_app_id!==actionsAppId||policy.rulesets?.length!==6||identity?.producerAppId!==policy.producer_app_id||identity?.mergerAppId!==policy.merger_app_id)throw Error("Owner-verified six-ruleset policy and separate App identities required");
 const normalized=mergerPolicy(...policy.rulesets,actionsAppId,policy.producer_app_id,policy.merger_app_id);
 for(const expected of normalized.rulesets){
  const live=await api.request("GET",PREFIX+"/rulesets/"+expected.id);
  if(!live||stable(comparableRuleset(live))!==stable(comparableRuleset(expected)))throw Error("Ruleset changed since owner verification");
  if(live.bypass_actors!==undefined&&stable(live.bypass_actors)!==stable(expected.bypass_actors))throw Error("Ruleset bypass changed");
 }
 return true;
}
