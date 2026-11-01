import {pathToFileURL} from "node:url";
import {contentHash,editionSources} from "./publication-content.mjs";
const origin="https://sfcloud-ai.github.io/ai-infra-reports";
const api="https://api.github.com/repos/sfcloud-ai/ai-infra-reports";
const SHA=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/;
const sha=v=>typeof v==="string"&&SHA.test(v);
const sourcePath=/^(report\.json|articles\/[a-z0-9][a-z0-9-]{0,79}\.md|assets\/[a-z0-9][a-z0-9-]{0,79}\.(png|jpg))$/;
const requireThat=(ok,message)=>{if(!ok)throw Error(message);};
const object=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const same=(a,b)=>JSON.stringify(Object.entries(a).sort())===JSON.stringify(Object.entries(b).sort());
const exact=(v,keys)=>object(v)&&Object.keys(v).sort().join()===keys.sort().join();
async function bytesAt(url,limit,fetcher,type){
 const response=await fetcher(url,{redirect:"error",signal:AbortSignal.timeout(15000),cache:"no-store"});
 requireThat(response.ok,"Publication resource unavailable");
 if(type)requireThat(response.headers.get("content-type")?.split(";")[0]===type,"Unexpected publication content type");
 const length=response.headers.get("content-length");
 requireThat(length===null||(/^\d+$/.test(length)&&Number(length)<=limit),"Publication byte limit");
 requireThat(response.body,"Empty publication body");
 let size=0;const chunks=[];
 for await(const chunk of response.body){size+=chunk.length;requireThat(size<=limit,"Publication byte limit");chunks.push(chunk);}
 return Buffer.concat(chunks);
}
async function documentAt(url,limit,fetcher){
 const bytes=await bytesAt(url,limit,fetcher,"application/json");
 return {value:JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)),hash:contentHash(bytes)};
}
async function manifest(fetcher){
 const result=await documentAt(origin+"/publication.json",1024*1024,fetcher),m=result.value;
 requireThat(exact(m,["schema_version","commit","preview","reports"])&&m.schema_version==="1.0"&&sha(m.commit)&&m.preview===false&&Array.isArray(m.reports),"Publication is stale or preview-only");
 return result;
}
async function editionProof(slug,commit,fetcher){
 const result=await documentAt(`${origin}/reports/${slug}/publication-proof.json`,256*1024,fetcher),p=result.value;
 requireThat(exact(p,["schema_version","deployment_commit","edition","sources","pages"])&&p.schema_version==="1.0"&&p.deployment_commit===commit&&p.edition===slug&&object(p.sources)&&object(p.pages),"Edition content proof missing or bound to another deployment");
 return result;
}
async function sourceAt(commit,slug,fetcher){
 const {value:source}=await documentAt(`${api}/git/commits/${commit}`,1024*1024,fetcher);
 requireThat(source.sha===commit&&sha(source.tree?.sha),"Source commit identity mismatch");
 const {value:tree}=await documentAt(`${api}/git/trees/${source.tree.sha}?recursive=1`,16*1024*1024,fetcher);
 requireThat(tree.sha===source.tree.sha&&tree.truncated===false&&Array.isArray(tree.tree)&&tree.tree.length<=100000,"Incomplete source tree");
 const prefix=`reports/${slug}/`,entries=[];
 for(const entry of tree.tree){
  if(typeof entry.path!=="string"||!entry.path.startsWith(prefix)||entry.type==="tree")continue;
  const path=entry.path.slice(prefix.length);
  requireThat(sourcePath.test(path)&&path!=="articles/index.md"&&entry.type==="blob"&&entry.mode==="100644"&&sha(entry.sha),"Unexpected edition source entry");
  entries.push([path,entry.sha]);
 }
 const sources=Object.fromEntries(entries);
 requireThat(entries.length===Object.keys(sources).length&&sha(sources["report.json"]),"Missing or ambiguous source edition");
 return sources;
}
export async function verifyPublicationUnchanged(proof,fetcher=fetch){
 const before=await manifest(fetcher);
 requireThat(before.hash===proof.publication_sha256&&before.value.commit===proof.deployment_commit,"Deployment changed during publication verification");
 const edition=await editionProof(proof.edition,proof.deployment_commit,fetcher);
 requireThat(edition.hash===proof.edition_proof_sha256,"Edition content proof changed during verification");
 const after=await manifest(fetcher);
 requireThat(after.hash===before.hash,"Deployment changed during publication verification");
}
export async function verifyPublication(expectedCommit,date,revision,fetcher=fetch,expectedFiles){
 requireThat(sha(expectedCommit)&&typeof date==="string"&&/^\d{4}-\d\d-\d\d$/.test(date)&&Number.isSafeInteger(revision)&&revision>0,"Exact publication identity required");
 const slug=`${date}/r${revision}`,published=await manifest(fetcher),m=published.value;
 requireThat(m.reports.includes(slug),"Publication is stale or missing the edition");
 const artifact=await editionProof(slug,m.commit,fetcher),edition=artifact.value;
 if(m.commit!==expectedCommit){
  const {value:c}=await documentAt(`${api}/compare/${expectedCommit}...${m.commit}?per_page=1`,16*1024*1024,fetcher);
  requireThat(c.status==="ahead"&&c.base_commit?.sha===expectedCommit&&c.merge_base_commit?.sha===expectedCommit&&c.behind_by===0&&Number.isSafeInteger(c.ahead_by)&&c.ahead_by>0,"Deployment is not a descendant of the report source commit");
 }
 const sources=await sourceAt(expectedCommit,slug,fetcher);
 requireThat(same(sources,edition.sources),"Published edition source differs from the report source commit");
 if(expectedFiles)requireThat(same(sources,editionSources(expectedFiles,slug)),"Report bundle differs from the source commit");
 const paths=[slug,...Object.keys(sources).filter(p=>p.startsWith("articles/")).map(p=>slug+"/"+p.slice(9,-3))].sort();
 requireThat(paths.join()===Object.keys(edition.pages).sort().join()&&Object.values(edition.pages).every(h=>typeof h==="string"&&HASH.test(h)),"Incomplete rendered edition proof");
 for(const path of paths){
  const bytes=await bytesAt(`${origin}/${path}/`,2*1024*1024,fetcher,"text/html"),html=bytes.toString("utf8");
  requireThat(contentHash(bytes)===edition.pages[path],"Published page hash mismatch");
  requireThat(html.includes(`data-report-id="${path}"`)&&(path===slug||html.includes("data-report-sources")),"Unexpected report page identity/evidence");
 }
 const proof={publication_status:"verified",commit:expectedCommit,deployment_commit:m.commit,edition:slug,publication_sha256:published.hash,edition_proof_sha256:artifact.hash,url:`${origin}/${slug}/`,checked_at:new Date().toISOString(),delivery_allowed:false,reason:"Slack and WeCom receipts remain separate"};
 await verifyPublicationUnchanged(proof,fetcher);return proof;
}
if(import.meta.url===pathToFileURL(process.argv[1]||"").href)console.log(JSON.stringify(await verifyPublication(process.argv[2],process.argv[3],Number(process.argv[4]))));
