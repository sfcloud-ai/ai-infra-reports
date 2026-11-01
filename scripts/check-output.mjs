import {readFile,writeFile,mkdir} from "node:fs/promises";
import {strict as assert} from "node:assert";
import {contentHash} from "./publication-content.mjs";
const out=process.argv[2];
if(!["dist","dist-preview"].includes(out))throw Error("Expected known build directory");
const {pages,publicationSources}=JSON.parse(await readFile("generated/manifest.json","utf8"));
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
// Bind immutable source editions to this build's final rendered bytes in a
// separate artifact. Existing notification readers require the root manifest's
// exact schema, so neither publication.json nor notice.json gains any fields.
const publication=JSON.parse(await readFile(out+"/publication.json","utf8"));
for(const slug of publication.reports){
 const rendered={};
 for(const page of pages.filter(p=>p.slug===slug||p.parent===slug))rendered[page.slug]=contentHash(await readFile(out+"/"+page.slug+"/index.html"));
 assert(Object.hasOwn(rendered,slug)&&publicationSources[slug],"Edition source/page proof missing");
 const proof={schema_version:"1.0",deployment_commit:publication.commit,edition:slug,sources:publicationSources[slug],pages:rendered};
 await mkdir(out+"/reports/"+slug,{recursive:true});
 await writeFile(out+"/reports/"+slug+"/publication-proof.json",JSON.stringify(proof,null,2)+"\n");
}
