import {contentHash,editionSources} from "../../scripts/publication-content.mjs";
export const ORIGIN="https://sfcloud-ai.github.io/ai-infra-reports";
export const API="https://api.github.com/repos/sfcloud-ai/ai-infra-reports";
// Offline site and GitHub source evidence, independently mutable for failures.
export function publicationSite({files,slug,sourceCommit,deploymentCommit=sourceCommit}){
 const sources=editionSources(files,slug),treeSha="e".repeat(40);
 const pages=new Map([slug,...Object.keys(sources).filter(p=>p.startsWith("articles/")).map(p=>slug+"/"+p.slice(9,-3))].map(p=>[p,`<main data-report-id="${p}"><p>Original rendered body</p><section data-report-sources></section></main>`]));
 const root={schema_version:"1.0",commit:deploymentCommit,preview:false,reports:[slug]};
 const proof={schema_version:"1.0",deployment_commit:deploymentCommit,edition:slug,sources:structuredClone(sources),pages:Object.fromEntries([...pages].map(([p,html])=>[p,contentHash(html)]))};
 const commit={sha:sourceCommit,tree:{sha:treeSha}};
 const tree={sha:treeSha,truncated:false,tree:Object.entries(sources).map(([path,sha])=>({path:`reports/${slug}/`+path,sha,type:"blob",mode:"100644"}))};
 const comparison={status:"ahead",base_commit:{sha:sourceCommit},merge_base_commit:{sha:sourceCommit},ahead_by:1,behind_by:0};
 const calls=[];
 const fetcher=async(url,options)=>{
  calls.push({url,options});
  if(url===ORIGIN+"/publication.json")return Response.json(root);
  if(url===`${ORIGIN}/reports/${slug}/publication-proof.json`)return Response.json(proof);
  if(url===`${API}/git/commits/${sourceCommit}`)return Response.json(commit);
  if(url===`${API}/git/trees/${treeSha}?recursive=1`)return Response.json(tree);
  if(url===`${API}/compare/${sourceCommit}...${deploymentCommit}?per_page=1`)return Response.json(comparison);
  for(const [path,html]of pages)if(url===`${ORIGIN}/${path}/`)return new Response(html,{headers:{"content-type":"text/html"}});
  for(const [path,bytes]of files)if(url===`${ORIGIN}/${path}`&&/\.(png|jpg)$/.test(path))return new Response(bytes,{headers:{"content-type":path.endsWith(".png")?"image/png":"image/jpeg"}});
  return new Response("not found",{status:404});
 };
 return {root,proof,pages,commit,tree,comparison,calls,fetcher};
}
