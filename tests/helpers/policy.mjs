import {REPOSITORY} from "../../scripts/archive.mjs";
export function sets(){
 const common={source:REPOSITORY,source_type:"Repository",target:"branch",enforcement:"active",updated_at:"2026-10-30T00:00:00Z"};
 const main={ref_name:{include:["refs/heads/main"],exclude:[]}};
 const review={required_approving_review_count:0,require_code_owner_review:false,require_last_push_approval:false,dismiss_stale_reviews_on_push:true};
 const humans=mode=>[123,456].map(actor_id=>({actor_type:"User",actor_id,bypass_mode:mode}));
 return [
 {...common,id:1,conditions:structuredClone(main),bypass_actors:[],rules:[{type:"pull_request",parameters:{...review}},{type:"non_fast_forward"},{type:"deletion"},{type:"required_status_checks",parameters:{strict_required_status_checks_policy:true,required_status_checks:[{context:"validate",integration_id:99}]}}]},
 {...common,id:2,conditions:{ref_name:{include:["~ALL"],exclude:["refs/heads/main"]}},rules:[{type:"update",parameters:{update_allows_fetch_and_merge:false}},{type:"deletion"}],bypass_actors:humans("always")},
 {...common,id:3,conditions:structuredClone(main),rules:[{type:"update",parameters:{update_allows_fetch_and_merge:false}}],bypass_actors:[{actor_type:"Integration",actor_id:102,bypass_mode:"always"},...humans("always")]},
 {...common,id:4,conditions:structuredClone(main),rules:[{type:"pull_request",parameters:{...review,require_code_owner_review:true}}],bypass_actors:humans("pull_request")},
 {...common,id:5,conditions:{ref_name:{include:["refs/heads/report/*"],exclude:[]}},rules:[{type:"creation"}],bypass_actors:[...humans("always"),{actor_type:"Integration",actor_id:101,bypass_mode:"always"}]},
 {...common,id:6,conditions:{ref_name:{include:["~ALL"],exclude:["refs/heads/main","refs/heads/report/*"]}},rules:[{type:"creation"}],bypass_actors:humans("always")}
 ];
}
