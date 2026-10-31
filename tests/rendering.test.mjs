import path from "node:path";
const awaitPath=path.resolve("article.md");
import test from "node:test";
import assert from "node:assert/strict";
import reportMarkdown from "../scripts/remark-reports.mjs";
const render=children=>{const tree={type:"root",children};reportMarkdown({assets:["/ai-infra-reports/reports/2026-10-31/r1/assets/poster.png"]})(tree);return tree;};
test("raw HTML becomes text and cannot execute",()=>{const result=render([{type:"html",value:"<script>alert(1)</script>"}]);assert.equal(result.children[0].type,"text");});
test("direct and reference images cannot load remote trackers",()=>{
 assert.throws(()=>render([{type:"image",url:"https://example.com/tracker.png"}]));
 assert.throws(()=>render([{type:"definition",identifier:"p",url:"https://example.com/tracker.png"},{type:"imageReference",identifier:"p"}]));
 assert.doesNotThrow(()=>render([{type:"image",url:"/ai-infra-reports/reports/2026-10-31/r1/assets/poster.png"}]));
});
test("executable URL schemes are rejected, HTTPS evidence is retained",()=>{
 for(const url of ["javascript:alert(1)","data:text/html,x","file:///x"])assert.throws(()=>render([{type:"link",url}]));
 assert.doesNotThrow(()=>render([{type:"link",url:"https://example.com/evidence"}]));
});
test("image syntax in code remains literal and does not require an asset",()=>{
 const tree={type:"root",children:[{type:"code",value:"![sample](assets/sample.png)"},{type:"inlineCode",value:"![sample](assets/sample.png)"}]};
 reportMarkdown()(tree);assert.equal(tree.children[0].value,"![sample](assets/sample.png)");
});
test("all real images must belong to the declared asset set",()=>{
 const asset="/ai-infra-reports/reports/2026-10-31/r1/assets/poster.png";
 const plugin=reportMarkdown({assets:[asset],articleDirs:{[(awaitPath)]:"reports/2026-10-31/r1/"}});
 const tree={type:"root",children:[{type:"image",url:"assets/poster.png"}]};plugin(tree,{path:(awaitPath)});assert.equal(tree.children[0].url,asset);
 assert.throws(()=>plugin({type:"root",children:[{type:"image",url:"/ai-infra-reports/reports/2099-01-01/r1/assets/missing.png"}]}));
});

import {createMarkdownProcessor} from "@astrojs/markdown-remark";
import {pathToFileURL} from "node:url";
test("Astro's real Markdown pipeline preserves examples, resolves images and escapes HTML",async()=>{
 const asset="/ai-infra-reports/reports/2026-10-31/r1/assets/poster.png";
 const processor=await createMarkdownProcessor({syntaxHighlight:false,remarkPlugins:[[reportMarkdown,{assets:[asset],articleDirs:{[awaitPath]:"reports/2026-10-31/r1/"}}]]});
 const tick=String.fromCharCode(96);
 const source="![Actual](assets/poster.png)\n\n![Reference][p]\n\n[p]: assets/poster.png\n\n"+tick+"![Example](assets/missing.png)"+tick+"\n\n<script>alert(1)</script>";
 const rendered=await processor.render(source,{fileURL:pathToFileURL(awaitPath)});
 assert.equal((rendered.code.match(/<img /g)||[]).length,2);
 assert(rendered.code.includes('src="'+asset+'"'));
 assert(rendered.code.includes("![Example](assets/missing.png)"));
 assert(!rendered.code.includes("<script>"));assert(rendered.code.includes("alert(1)"));
});

test("Chinese fragments copied from a browser remain valid links",()=>{
 const url="#%E5%AE%9E%E9%AA%8C";
 assert.doesNotThrow(()=>render([{type:"link",url}]));
 for(const bad of ["#%ZZ","#%00"])assert.throws(()=>render([{type:"link",url:bad}]));
});

import {dailyBody,articleBody,articleEvidence} from "../scripts/content-text.mjs";
test("metadata stays literal while evidence remains outside arbitrary Markdown",async()=>{
 const title="Topic](https://unexpected.example/) [More";
 const r={date:"2026-10-31",revision:1,path:"reports/2026-10-31/r1/",articles:[{id:"topic",title,summary:"**literal** & title"}],images:[],poster:null,entries:[{article_id:"topic",title:"Evidence [label]",source_urls:["https://example.com/paper?x=1&utm_source=demo"]}]};
 const processor=await createMarkdownProcessor({syntaxHighlight:false,remarkPlugins:[reportMarkdown]});
 const index=await processor.render(dailyBody(r));
 assert(!index.code.includes('href="https://unexpected.example/'));
 assert(index.code.includes('href="/ai-infra-reports/2026-10-31/r1/topic/"'));
 assert(index.code.includes("**literal**"));assert(!index.code.includes("<strong>literal"));
 const source=articleBody(r,r.articles[0],"正文。\n"+String.fromCharCode(96).repeat(3)+"text\nunterminated");
 assert(!source.includes("来源与证据"));
 assert.deepEqual(articleEvidence(r,r.articles[0]),[{title:"Evidence [label]",urls:["https://example.com/paper?x=1"]}]);
});

import reportHeadings from "../scripts/rehype-headings.mjs";
import {evidenceAssets} from "../scripts/evidence-assets.mjs";
test("GFM footnote image bytes participate in event identity",async()=>{
 const source="Evidence[^plot]\n\n[^plot]: ![plot](assets/plot.png)\n";
 const dir="reports/2026-10-31/r1/",files=new Map([[dir+"assets/plot.png",Buffer.from("one")]]);
 const before=evidenceAssets(source,dir,files);assert.equal(before.length,1);
 files.set(dir+"assets/plot.png",Buffer.from("two"));assert.notDeepEqual(evidenceAssets(source,dir,files),before);
 const processor=await createMarkdownProcessor({syntaxHighlight:false,remarkPlugins:[[reportMarkdown,{assets:["/ai-infra-reports/"+dir+"assets/plot.png"],articleDirs:{[awaitPath]:dir}}]]});
 assert((await processor.render(source,{fileURL:pathToFileURL(awaitPath)})).code.includes("<img"));
});
test("heading IDs cannot collide with shell controls and local links stay usable",async()=>{
 const processor=await createMarkdownProcessor({syntaxHighlight:false,remarkPlugins:[reportMarkdown],rehypePlugins:[reportHeadings]});
 const result=await processor.render("## Search dialog\n\n[Jump](#search-dialog)\n\n## Search input\n\n## Content\n\n## Search dialog");
 assert(!result.code.includes('id="search-dialog"'));
 assert(result.code.includes('id="article-search-dialog"'));
 assert(result.code.includes('href="#article-search-dialog"'));
 assert.deepEqual(result.metadata.headings.map(h=>h.slug),["article-search-dialog","article-search-input","article-content","article-search-dialog-1"]);
});

test("footnote accessible labels remain valid beside similarly named article headings",async()=>{
 const processor=await createMarkdownProcessor({syntaxHighlight:false,remarkPlugins:[reportMarkdown],rehypePlugins:[reportHeadings]});
 const result=await processor.render("## Footnote label\n\nA note[^x].\n\n[^x]: Explanation.");
 assert(result.code.includes('aria-describedby="footnote-label"'));
 assert.equal((result.code.match(/id="footnote-label"/g)||[]).length,1);
 assert(result.code.includes('id="article-footnote-label"'));
});
