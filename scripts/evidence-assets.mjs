import {gfm} from "micromark-extension-gfm";
import {gfmFromMarkdown} from "mdast-util-gfm";
import {fromMarkdown} from "mdast-util-from-markdown";
import {createHash} from "node:crypto";
export function evidenceAssets(text,dir,files){
 const tree=fromMarkdown(text,{extensions:[gfm()],mdastExtensions:[gfmFromMarkdown()]}),definitions=new Map(),hashes=new Set();
 function collect(n){if(n.type==="definition")definitions.set(n.identifier,n.url);n.children?.forEach(collect);}collect(tree);
 function visit(n){
  if(n.type==="image"||n.type==="imageReference"){
   const u=n.type==="image"?n.url:definitions.get(n.identifier);
   const p=u?.startsWith("assets/")?dir+u:u?.startsWith("/ai-infra-reports/reports/")?u.slice("/ai-infra-reports/".length):null;
   const bytes=p&&files.get(p);
   if(!p||!/^reports\/\d{4}-\d\d-\d\d\/r[1-9]\d*\/assets\/[a-z0-9][a-z0-9-]{0,79}\.(png|jpg)$/.test(p)||!bytes)throw Error("Evidence image must be an existing archive asset");
   hashes.add(createHash("sha256").update(bytes).digest("hex"));
  }
  n.children?.forEach(visit);
 }visit(tree);return [...hashes].sort();
}
