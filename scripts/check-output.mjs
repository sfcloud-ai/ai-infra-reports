import {readFile} from "node:fs/promises";
import {strict as assert} from "node:assert";
const out=process.argv[2];
if(!["dist","dist-preview"].includes(out))throw Error("Expected known build directory");
const {pages}=JSON.parse(await readFile("generated/manifest.json","utf8"));
const escape=v=>v.replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;").replaceAll(">","&gt;");
for(const p of pages.filter(p=>p.kind==="article")){
 const html=await readFile(out+"/"+p.slug+"/index.html","utf8");
 const section=html.match(/<section\b[^>]*data-report-sources[^>]*>[\s\S]*?<\/section>/)?.[0];
 assert(section,"Article evidence section missing: "+p.slug);
 const before=html.slice(0,html.indexOf(section));
 assert(before.lastIndexOf("<pre")<=before.lastIndexOf("</pre>"),"Evidence trapped in a code fence");
 for(const e of p.evidence)for(const u of e.urls)assert(section.includes('href="'+escape(u)+'"'),"Declared evidence link missing");
}
console.log("Verified independently rendered evidence for "+pages.filter(p=>p.kind==="article").length+" articles");
