// Data-only Slack transport. Archive and history validation still run in propose().
import {pathToFileURL} from "node:url";
import {readReports,digest,REPOSITORY} from "./archive.mjs";
import {validateRasters} from "./rasters.mjs";
import {verifyPublication} from "./verify-publication.mjs";
export const MAX_BUNDLE=8*1024*1024;
export const SHA=/^[a-f0-9]{40}$/;
const HASH=/^[a-f0-9]{64}$/;
export const REQUEST=/^[a-z0-9][a-z0-9-]{7,79}$/;
const FILE=/^reports\/(\d{4}-\d\d-\d\d)\/r([1-9]\d*)\/(report\.json|articles\/[a-z0-9][a-z0-9-]{0,79}\.md|assets\/[a-z0-9][a-z0-9-]{0,79}\.(png|jpg))$/;
export function requireThat(ok,message){if(!ok)throw Error(message);}
function exact(value,keys){requireThat(value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).sort().join()===keys.sort().join(),"Unexpected transport fields");}
export async function decodeBundle(bytes){
 requireThat(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=MAX_BUNDLE,"Bundle byte limit");
 const data=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
 exact(data,["schema_version","request_id","repository","expected_base_sha","prompt_commit_sha","files"]);
 requireThat([data.request_id,data.expected_base_sha,data.prompt_commit_sha].every(v=>typeof v==="string"),"Bundle identity types");
 requireThat(data.schema_version==="1.0"&&data.repository===REPOSITORY&&REQUEST.test(data.request_id)&&SHA.test(data.expected_base_sha)&&SHA.test(data.prompt_commit_sha),"Bundle identity");
 requireThat(Array.isArray(data.files)&&data.files.length>0&&data.files.length<=64,"Bundle file count");
 const files=new Map(),dirs=new Set();let total=0;
 for(const f of data.files){
  exact(f,["path","sha256","base64"]);
  requireThat(typeof f.path==="string"&&FILE.test(f.path)&&!files.has(f.path)&&HASH.test(f.sha256)&&typeof f.base64==="string","Bundle file identity");
  const b=Buffer.from(f.base64,"base64");
  requireThat(b.length>0&&b.toString("base64")===f.base64&&digest(b)===f.sha256,"Bundle file hash/encoding");
  total+=b.length;requireThat(total<=6*1024*1024,"Decoded bundle limit");
  files.set(f.path,b);dirs.add(f.path.split("/").slice(0,3).join("/")+"/");
 }
 requireThat(dirs.size===1,"One edition per request");
 const dir=[...dirs][0],meta=files.get(dir+"report.json");
 requireThat(meta&&meta.length<128*1024,"Report metadata missing/large");
 const report=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(meta));
 exact(report,["schema_version","date","revision","title","subtitle","articles","entries","images","poster"]);
 requireThat(report.schema_version==="1.0"&&Number.isSafeInteger(report.revision)&&dir===`reports/${report.date}/r${report.revision}/`,"Edition identity");
 requireThat(Array.isArray(report.articles)&&report.articles.length>0&&report.articles.length<=30&&Array.isArray(report.images)&&report.images.length<=20,"Edition collections");
 const used=new Set([dir+"report.json"]);
 for(const a of report.articles){
  requireThat(typeof a?.id==="string"&&/^[a-z0-9][a-z0-9-]{0,79}$/.test(a.id)&&a.id!=="index","Article identity");
  const p=dir+"articles/"+a.id+".md";
  requireThat(!used.has(p)&&files.has(p)&&digest(files.get(p))===a.sha256&&files.get(p).length<=256*1024,"Article hash/size");used.add(p);
 }
 for(const a of report.images){
  requireThat(typeof a?.path==="string"&&/^assets\/[a-z0-9][a-z0-9-]{0,79}\.(png|jpg)$/.test(a.path),"Image identity");
  const p=dir+a.path;requireThat(!used.has(p)&&files.has(p)&&digest(files.get(p))===a.sha256,"Image hash");used.add(p);
 }
 requireThat(files.size===used.size&&report.images.some(i=>i.path===report.poster),"Declared files and notification poster required");
 requireThat(files.get(dir+report.poster).length<=2000000,"Notification poster byte limit");
 await validateRasters(files);
 return {data,files,report:{...report,path:dir},hash:digest(bytes)};
}
export async function encodeBundle(files,requestId,base,promptCommit){
 const data={schema_version:"1.0",request_id:requestId,repository:REPOSITORY,expected_base_sha:base,prompt_commit_sha:promptCommit,files:[...files].filter(([p])=>p!=="reports/index.json").sort(([a],[b])=>a.localeCompare(b)).map(([path,b])=>({path,sha256:digest(b),base64:b.toString("base64")}))};
 const bytes=Buffer.from(JSON.stringify(data)+"\n");await decodeBundle(bytes);return bytes;
}
// Caller must obtain this message from the authenticated, pinned channel history.
function connectorCommand(message,config){
 const b=message.blocks,footer=config.sender_attribution_text;
 requireThat(typeof footer==="string"&&footer.length>0&&message.text.endsWith(" "+footer),"Connector attribution mismatch");
 const command=message.text.slice(0,-footer.length-1);
 // Match the actual visible command and attribution, not just Slack's fallback.
 requireThat(Array.isArray(b)&&b.length===2&&b[0]?.type==="rich_text"&&b[1]?.type==="context","Connector visible blocks required");
 for(const block of b)requireThat(Object.keys(block).every(k=>["type","block_id","elements"].includes(k)),"Unexpected connector block field");
 const sections=b[0].elements,context=b[1].elements;
 requireThat(Array.isArray(sections)&&sections.length===1&&sections[0]?.type==="rich_text_section"&&Object.keys(sections[0]).sort().join()==="elements,type","Connector command section");
 const content=sections[0].elements;
 requireThat(Array.isArray(content)&&content.length===1&&content[0]?.type==="text"&&Object.keys(content[0]).sort().join()==="text,type"&&content[0].text===command,"Connector visible command mismatch");
 requireThat(Array.isArray(context)&&context.length===1&&context[0]?.type==="mrkdwn"&&context[0].text===footer&&context[0].verbatim===false&&Object.keys(context[0]).sort().join()==="text,type,verbatim","Connector visible attribution mismatch");
 return command;
}
export function acceptMessage(message,config,now=Date.now()){
 if(!message?.text?.startsWith("!ai-report "))return null;
 const appSender=config.sender_bot_id!==undefined||config.sender_app_id!==undefined;
 const userAppSender=config.sender_user_app_id!==undefined;
 const identity=message.user===config.sender_user_id&&(userAppSender
  ?!appSender&&!message.bot_id&&typeof config.sender_user_app_id==="string"&&message.app_id===config.sender_user_app_id
  :appSender
  ?typeof config.sender_bot_id==="string"&&typeof config.sender_app_id==="string"&&message.bot_id===config.sender_bot_id&&message.app_id===config.sender_app_id
  :!message.bot_id&&!message.app_id);
 const nativeShare=message.subtype==="file_share"||(appSender&&message.subtype==="bot_message")||(userAppSender&&message.subtype===undefined);
 requireThat(message.type==="message"&&nativeShare&&!message.edited&&!message.hidden&&(!message.thread_ts||message.thread_ts===message.ts)&&identity&&(message.attachments===undefined||(Array.isArray(message.attachments)&&message.attachments.length===0)),"Untrusted report message");
 requireThat(/^\d{10}\.\d{6}$/.test(message.ts)&&Number(message.ts)*1000<=now+30000&&Number(message.ts)*1000>=now-15*60000,"Report message outside intake window");
 const command=userAppSender?connectorCommand(message,config):message.text;
 const match=/^!ai-report publish ([a-z0-9][a-z0-9-]{7,79}) ([a-f0-9]{64})$/.exec(command);
 requireThat(match&&message.files?.length===1&&/^F[A-Z0-9]+$/.test(message.files[0].id),"Report command/file format");
 return {request_id:match[1],hash:match[2],source_ts:message.ts,file_id:message.files[0].id};
}
export async function boundedBytes(response,limit){
 requireThat(response.ok,"Remote read failed");
 const length=response.headers.get("content-length");requireThat(length===null||(/^\d+$/.test(length)&&Number(length)<=limit),"Remote byte limit");
 const chunks=[];let size=0;
 requireThat(response.body,"Empty remote body");
 for await(const chunk of response.body){size+=chunk.length;requireThat(size<=limit,"Remote byte limit");chunks.push(chunk);}
 return Buffer.concat(chunks);
}
export async function verifyReportPublication(commit,bundle,fetcher=fetch){
 const {report:r}=bundle,proof=await verifyPublication(commit,r.date,r.revision,fetcher);
 const slug=`${r.date}/r${r.revision}`,origin="https://sfcloud-ai.github.io/ai-infra-reports";
 const get=url=>fetcher(url,{redirect:"error",cache:"no-store",signal:AbortSignal.timeout(15000)});
 for(const a of r.articles){
  const response=await get(`${origin}/${slug}/${a.id}/`);
  requireThat(response.headers.get("content-type")?.includes("text/html"),"Article content type");
  const html=(await boundedBytes(response,2*1024*1024)).toString("utf8");
  requireThat(html.includes(`data-report-id="${slug}/${a.id}"`)&&html.includes("data-report-sources"),"Article identity/evidence missing");
 }
 for(const i of r.images){
  const response=await get(origin+"/"+r.path+i.path);
  const type=i.path.endsWith(".png")?"image/png":"image/jpeg";
  requireThat(response.headers.get("content-type")?.split(";")[0]===type,"Image content type");
  requireThat(digest(await boundedBytes(response,2*1024*1024))===i.sha256,"Published image hash mismatch");
 }
 // Check again after all reads: do not accept a deployment changing mid-verification.
 await verifyPublication(commit,r.date,r.revision,fetcher);
 return {...proof,request_id:bundle.data.request_id,bundle_sha256:bundle.hash,edition:slug,poster_sha256:r.images.find(i=>i.path===r.poster).sha256,checked_at:new Date().toISOString()};
}
if(import.meta.url===pathToFileURL(process.argv[1]||"").href){
 const [root,id,base,prompt,...extra]=process.argv.slice(2);requireThat(root&&id&&base&&prompt&&!extra.length,"Usage: node scripts/report-handoff.mjs BUNDLE_ROOT REQUEST_ID MAIN_SHA PROMPT_SHA > ai-brief-bundle.json");
 process.stdout.write(await encodeBundle(await readReports(root),id,base,prompt));
}
