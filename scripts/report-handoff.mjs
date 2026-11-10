// Data-only Slack transport. Archive and history validation still run in propose().
import {pathToFileURL} from "node:url";
import {readReports,digest,REPOSITORY} from "./archive.mjs";
import {validateRasters} from "./rasters.mjs";
import {verifyPublication,verifyPublicationUnchanged} from "./verify-publication.mjs";
export const MAX_BUNDLE=8*1024*1024;
export const SHA=/^[a-f0-9]{40}$/;
const HASH=/^[a-f0-9]{64}$/;
export const REQUEST=/^[a-z0-9][a-z0-9-]{7,79}$/;
const FILE=/^reports\/(\d{4}-\d\d-\d\d)\/(?:r([1-9]\d*)\/)?(report\.json|articles\/[a-z0-9][a-z0-9-]{0,79}\.md|assets\/[a-z0-9][a-z0-9-]{0,79}\.(png|jpg))$/;
export function requireThat(ok,message){if(!ok)throw Error(message);}
export function isEditionPublicURL(url,edition){
 const match=/^(\d{4}-\d\d-\d\d)\/r[1-9]\d*$(?![\s\S])/.exec(edition);
 return !!match&&reportDate(match[1])&&(url===`https://sfcloud-ai.github.io/ai-infra-reports/${edition}/`||url===`https://sfcloud-ai.github.io/ai-infra-reports/${match[1]}/`);
}
function exact(value,keys){requireThat(value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).sort().join()===keys.sort().join(),"Unexpected transport fields");}
export function reportDate(value){
 return typeof value==='string'&&/^\d{4}-\d\d-\d\d$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
}
export function canonicalRequestDate(id){
 const match=/^morning-(\d{4})(\d\d)(\d\d)-r([1-9]\d*)$/.exec(id??'');
 if(!match)return null;
 const date=match.slice(1,4).join('-');requireThat(reportDate(date),'Canonical request date invalid');return date;
}
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
  files.set(f.path,b);dirs.add(f.path.split("/").slice(0,FILE.exec(f.path)[2]?3:2).join("/")+"/");
 }
 requireThat(dirs.size===1,"One edition per request");
 const dir=[...dirs][0],meta=files.get(dir+"report.json");
 requireThat(meta&&meta.length<128*1024,"Report metadata missing/large");
 const report=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(meta));
 exact(report,["schema_version","date","revision","title","subtitle","articles","entries","images","poster"]);
 const requestDate=canonicalRequestDate(data.request_id);
 requireThat(!requestDate||requestDate===report.date&&data.request_id.endsWith('-r'+report.revision),'Canonical request edition differs from bundle');
 requireThat(reportDate(report.date),'Report date invalid');
 requireThat(report.schema_version==="1.0"&&Number.isSafeInteger(report.revision)&&report.revision>0&&(dir===`reports/${report.date}/r${report.revision}/`||dir===`reports/${report.date}/`),"Edition identity");
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
export function acceptControlFile(message,config,now=Date.now(),window){
 const appSender=config.sender_bot_id!==undefined||config.sender_app_id!==undefined;
 const userAppSender=config.sender_user_app_id!==undefined;
 const identity=message.user===config.sender_user_id&&(userAppSender
  ?!appSender&&!message.bot_id&&typeof config.sender_user_app_id==="string"&&message.app_id===config.sender_user_app_id
  :appSender
  ?typeof config.sender_bot_id==="string"&&typeof config.sender_app_id==="string"&&message.bot_id===config.sender_bot_id&&message.app_id===config.sender_app_id
  :!message.bot_id&&!message.app_id);
 const nativeShare=message.subtype==="file_share"||(appSender&&message.subtype==="bot_message")||(userAppSender&&message.subtype===undefined);
 requireThat(message.type==="message"&&nativeShare&&!message.edited&&!message.hidden&&(!message.thread_ts||message.thread_ts===message.ts)&&identity&&(message.attachments===undefined||(Array.isArray(message.attachments)&&message.attachments.length===0)),"Untrusted report message");
 const timestamp=/^\d{10}\.\d{6}$/;
 if(window)requireThat(Object.keys(window).sort().join()==='from,to'&&timestamp.test(window.from)&&timestamp.test(window.to)&&window.from<=window.to&&Number(window.to)*1000<=now+30000,"Trusted intake range required");
 requireThat(timestamp.test(message.ts)&&Number(message.ts)*1000<=now+30000&&(window?message.ts>=window.from&&message.ts<=window.to:Number(message.ts)*1000>=now-15*60000),"Report message outside intake window");
 requireThat(message.files?.length===1&&/^F[A-Z0-9]+$/.test(message.files[0].id),"Exact control file required");
 return {source_ts:message.ts,file_id:message.files[0].id};
}
export function acceptDataCommand(message,config,prefix,pattern,now=Date.now(),window){
 if(!message?.text?.startsWith(prefix))return null;
 const event=acceptControlFile(message,config,now,window);
 const userAppSender=config.sender_user_app_id!==undefined;
 const command=userAppSender?connectorCommand(message,config):message.text;
 const match=pattern.exec(command);
 requireThat(match,"Report command/file format");
 return {request_id:match[1],hash:match[2],...event};
}
export function acceptMessage(message,config,now=Date.now()){
 return acceptDataCommand(message,config,"!ai-report ",/^!ai-report publish ([a-z0-9][a-z0-9-]{7,79}) ([a-f0-9]{64})$/,now);
}
// Only a trusted persistent consumer chooses this range. The message itself
// cannot extend admission to historical reports or bypass sender/file checks.
export function acceptQueuedPublish(message,config,window,now=Date.now()){
 requireThat(window,'Explicit durable intake range required');
 return acceptDataCommand(message,config,"!ai-report publish ",/^!ai-report publish ([a-z0-9][a-z0-9-]{7,79}) ([a-f0-9]{64})$/,now,window);
}
// Same authenticated channel and sender contract, but deliberately no file.
export function acceptReadCommand(message,config,prefix,pattern,now,window){
 if(!message?.text?.startsWith(prefix))return null;
 const appSender=config.sender_bot_id!==undefined||config.sender_app_id!==undefined,userApp=config.sender_user_app_id!==undefined;
 const identity=message.user===config.sender_user_id&&(userApp?!appSender&&!message.bot_id&&message.app_id===config.sender_user_app_id:appSender?message.bot_id===config.sender_bot_id&&message.app_id===config.sender_app_id:!message.bot_id&&!message.app_id);
 requireThat(message.type==="message"&&(message.subtype===undefined||appSender&&message.subtype==="bot_message")&&!message.edited&&!message.hidden&&(!message.thread_ts||message.thread_ts===message.ts)&&identity&&(message.files===undefined||Array.isArray(message.files)&&message.files.length===0)&&(message.attachments===undefined||Array.isArray(message.attachments)&&message.attachments.length===0),"Untrusted report status message");
 const timestamp=/^\d{10}\.\d{6}$/;
 if(window)requireThat(Object.keys(window).sort().join()==='from,to'&&timestamp.test(window.from)&&timestamp.test(window.to)&&window.from<=window.to&&Number(window.to)*1000<=now+30000,'Trusted read-command range required');
 requireThat(timestamp.test(message.ts)&&Number(message.ts)*1000<=now+30000&&(window?message.ts>=window.from&&message.ts<=window.to:Number(message.ts)*1000>=now-15*60000),"Status message outside intake window");
 const command=userApp?connectorCommand(message,config):message.text,match=pattern.exec(command);
 requireThat(match,"Exact status command required");
 return {match,source_ts:message.ts,hash:digest(command)};
}
export function acceptReportStatus(message,config,now=Date.now(),window){
 const event=acceptReadCommand(message,config,'!ai-report status ',/^!ai-report status ([a-z0-9][a-z0-9-]{7,79})$/,now,window);
 return event?{request_id:event.match[1],source_ts:event.source_ts,hash:event.hash}:null;
}
export function acceptProducerInspect(message,config,now=Date.now(),window){
 const event=acceptReadCommand(message,config,'!ai-report inspect ',/^!ai-report inspect ([a-z0-9][a-z0-9-]{7,79}) (\d{4}-\d\d-\d\d) ([a-f0-9]{64}) ([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/,now,window);
 if(!event)return null;
 const [,request_id,report_date,bundle_sha256,query_id]=event.match;
 requireThat(reportDate(report_date),'Inspect date invalid');
 return {kind:'inspect',request_id,report_date,bundle_sha256,query_id,source_ts:event.source_ts,hash:event.hash};
}
export function acceptProducerDay(message,config,now=Date.now(),window){
 const event=acceptReadCommand(message,config,'!ai-report day ',/^!ai-report day (\d{4}-\d\d-\d\d) ([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/,now,window);
 if(!event)return null;
 const [,report_date,query_id]=event.match;requireThat(reportDate(report_date),'Day query date invalid');
 return {kind:'day',request_id:`morning-${report_date.replaceAll('-','')}-r1`,report_date,query_id,source_ts:event.source_ts,hash:event.hash};
}
export async function boundedBytes(response,limit){
 requireThat(response.ok,"Remote read failed");
 const length=response.headers.get("content-length");requireThat(length===null||(/^\d+$/.test(length)&&Number(length)<=limit),"Remote byte limit");
 const chunks=[];let size=0;
 requireThat(response.body,"Empty remote body");
 for await(const chunk of response.body){size+=chunk.length;requireThat(size<=limit,"Remote byte limit");chunks.push(chunk);}
 return Buffer.concat(chunks);
}
export async function verifyReportPublication(commit,bundle,fetcher=fetch,sourceCache){
 const {report:r}=bundle,proof=await verifyPublication(commit,r.date,r.revision,fetcher,bundle.files,sourceCache);
 const slug=`${r.date}/r${r.revision}`,origin="https://sfcloud-ai.github.io/ai-infra-reports";
 const get=url=>fetcher(url,{redirect:"error",cache:"no-store",signal:AbortSignal.timeout(15000)});
 const publicSourcePath=proof.url===`${origin}/${r.date}/`?`reports/${r.date}/`:r.path;
 for(const i of r.images){
  const response=await get(origin+"/"+publicSourcePath+i.path);
  const type=i.path.endsWith(".png")?"image/png":"image/jpeg";
  requireThat(response.headers.get("content-type")?.split(";")[0]===type,"Image content type");
  requireThat(digest(await boundedBytes(response,2*1024*1024))===i.sha256,"Published image hash mismatch");
 }
 // Check again after all reads: do not accept a deployment changing mid-verification.
 await verifyPublicationUnchanged(proof,fetcher);
 return {...proof,request_id:bundle.data.request_id,bundle_sha256:bundle.hash,edition:slug,poster_sha256:r.images.find(i=>i.path===r.poster).sha256,checked_at:new Date().toISOString()};
}
if(import.meta.url===pathToFileURL(process.argv[1]||"").href){
 const [root,id,base,prompt,...extra]=process.argv.slice(2);requireThat(root&&id&&base&&prompt&&!extra.length,"Usage: node scripts/report-handoff.mjs BUNDLE_ROOT REQUEST_ID MAIN_SHA PROMPT_SHA > ai-brief-bundle.json");
 process.stdout.write(await encodeBundle(await readReports(root),id,base,prompt));
}
