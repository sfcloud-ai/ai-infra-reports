import {gfm} from "micromark-extension-gfm";
import {gfmFromMarkdown} from "mdast-util-gfm";
import {fromMarkdown} from "mdast-util-from-markdown";
import {createHash} from "node:crypto";
export function evidenceAssets(text,dir,files){
 return [...new Set([...evidenceAssetReferences(text,dir,files).values()].map(p=>createHash('sha256').update(files.get(p)).digest('hex')))].sort();
}
// Validation and rendering share resolution. Archive fingerprints still bind
// retained entry IDs to the exact article and referenced image bytes.
export function evidenceAssetReferences(text,dir,files){
 const tree=fromMarkdown(text,{extensions:[gfm()],mdastExtensions:[gfmFromMarkdown()]}),definitions=new Map(),references=new Map();
 function collect(n){if(n.type==="definition")definitions.set(n.identifier,n.url);n.children?.forEach(collect);}collect(tree);
 function visit(n){
  if(n.type==="image"||n.type==="imageReference"){
   const u=n.type==="image"?n.url:definitions.get(n.identifier);
   let p=u?.startsWith("assets/")?dir+u:u?.startsWith("/ai-infra-reports/reports/")?u.slice("/ai-infra-reports/".length):null;
   // Retain immutable article bytes when moving a revision into its current snapshot.
   if(p && !files.has(p) && /^reports\/[^/]+\/$/.test(dir)) {
     const match=/^(reports\/[^/]+\/)r([1-9]\d*)\/(assets\/[^/]+)$/.exec(p);
     if(match && match[1]===dir && Number(match[2])<=JSON.parse(files.get(dir+"report.json")).revision) p=dir+match[3];
   }
   const bytes=p&&files.get(p);
   if(!p||!/^reports\/\d{4}-\d\d-\d\d\/(?:r[1-9]\d*\/)?assets\/[a-z0-9][a-z0-9-]{0,79}\.(png|jpg)$/.test(p)||!bytes)throw Error("Evidence image must be an existing archive asset");
   references.set(u,p);
  }
  n.children?.forEach(visit);
 }visit(tree);return references;
}
