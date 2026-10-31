import {REPOSITORY} from "../../scripts/archive.mjs";
export function sets(){
 const common={source:REPOSITORY,source_type:"Repository",target:"branch",enforcement:"active",updated_at:"2026-10-30T00:00:00Z",bypass_actors:[]};
 return [
 {...common,id:1,conditions:{ref_name:{include:["refs/heads/main"],exclude:[]}},rules:[{type:"pull_request",parameters:{require_code_owner_review:true,dismiss_stale_reviews_on_push:true}},{type:"non_fast_forward"},{type:"deletion"},{type:"required_status_checks",parameters:{strict_required_status_checks_policy:true,required_status_checks:[{context:"validate",integration_id:99}]}}]},
 {...common,id:2,conditions:{ref_name:{include:["~ALL"],exclude:["refs/heads/main"]}},rules:[{type:"update",parameters:{update_allows_fetch_and_merge:false}},{type:"deletion"}]},
 {...common,id:3,conditions:{ref_name:{include:["refs/heads/main"],exclude:[]}},rules:[{type:"update",parameters:{update_allows_fetch_and_merge:false}}],bypass_actors:[{actor_type:"Integration",actor_id:102,bypass_mode:"always"}]}
 ];
}
