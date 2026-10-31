import {pathToFileURL} from "node:url";
const origin="https://sfcloud-ai.github.io/ai-infra-reports";
export async function verifyPublication(expectedCommit,date,revision,fetcher=fetch) {
 if(!/^[a-f0-9]{40}$/.test(expectedCommit)||!/^\d{4}-\d\d-\d\d$/.test(date)||!Number.isSafeInteger(revision)||revision<1)throw Error("Exact publication identity required");
 const options={redirect:"error",signal:AbortSignal.timeout(15000),cache:"no-store"};
 const response=await fetcher(origin+"/publication.json",options);
 if(!response.ok)throw Error("Publication manifest unavailable; do not send a report URL");
 const m=await response.json(),slug=date+"/r"+revision;
 if(m.schema_version!=="1.0"||m.commit!==expectedCommit||m.preview!==false||!m.reports.includes(slug))throw Error("Publication is stale or missing the edition");
 const url=origin+"/"+slug+"/",page=await fetcher(url,options);
 if(!page.ok||!page.headers.get("content-type")?.includes("text/html"))throw Error("Report URL is not readable");
 if(!(await page.text()).includes('data-report-id="'+slug+'"'))throw Error("Unexpected report page");
 return {publication_status:"verified",commit:expectedCommit,url,checked_at:new Date().toISOString(),delivery_allowed:false,reason:"Slack and WeCom receipts remain separate"};
}
if(import.meta.url===pathToFileURL(process.argv[1]||"").href)console.log(JSON.stringify(await verifyPublication(process.argv[2],process.argv[3],Number(process.argv[4]))));
