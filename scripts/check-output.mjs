import {readFile,writeFile,mkdir} from "node:fs/promises";
import {strict as assert} from "node:assert";
import {contentHash} from "./publication-content.mjs";
const out=process.argv[2];
if(!["dist","dist-preview"].includes(out))throw Error("Expected known build directory");
const {pages,publicationSources,redirects=[]}=JSON.parse(await readFile("generated/manifest.json","utf8"));
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
 for(const page of pages.filter(p=>p.edition===slug||p.slug===slug||p.parent===slug))rendered[page.slug]=contentHash(await readFile(out+"/"+page.slug+"/index.html"));
 assert((Object.hasOwn(rendered,slug)||Object.hasOwn(rendered,slug.split("/")[0]))&&publicationSources[slug],"Edition source/page proof missing");
 const proof={schema_version:"1.0",deployment_commit:publication.commit,edition:slug,sources:publicationSources[slug],pages:rendered};
 await mkdir(out+"/reports/"+slug,{recursive:true});
 await writeFile(out+"/reports/"+slug+"/publication-proof.json",JSON.stringify(proof,null,2)+"\n");
 if(Object.hasOwn(rendered,slug.split('/')[0]))await writeFile(out+"/reports/"+slug.split('/')[0]+"/publication-proof.json",JSON.stringify(proof,null,2)+"\n");
}

// Redirect shells must never retain retired report text or enter search.
for(const redirect of redirects){
 const html=await readFile(out+'/'+redirect.from+'/index.html','utf8');
 const target='/ai-infra-reports/'+redirect.to+'/';
 assert(html.includes('http-equiv="refresh"')&&html.includes('0;url='+target),'Missing legacy redirect');
 assert(html.includes('name="robots" content="noindex"')&&html.includes('rel="canonical"'),'Redirect indexing guard missing');
 assert(!html.includes('data-report-id=')&&!html.includes('data-report-sources')&&!html.includes('data-pagefind-body'),'Retired content in redirect shell');
 assert(html.includes('window.location.replace'),'Legacy redirect must replace browser history');
}
console.log('Verified '+redirects.length+' content-free legacy redirects');
