import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {verifyPublication,verifyPublicationUnchanged} from "../scripts/verify-publication.mjs";
import {contentHash,gitBlobHash,editionSources} from "../scripts/publication-content.mjs";
import {publicationSite,ORIGIN,API} from "./helpers/publication-site.mjs";
const source="a".repeat(40),later="b".repeat(40),slug="2026-11-01/r1",prefix=`reports/${slug}/`;
const files=new Map([[prefix+"report.json",Buffer.from('{"title":"Immutable edition"}\n')],[prefix+"articles/item.md",Buffer.from("# Original article\n")],[prefix+"assets/poster.png",Buffer.from([0,1,255])]]);
const site=(deploymentCommit=later)=>publicationSite({files,slug,sourceCommit:source,deploymentCommit});
const verify=s=>verifyPublication(source,"2026-11-01",1,s.fetcher,files);

test("original and later deployments preserve original report identity",async()=>{
 for(const commit of [source,later]){
  const s=site(commit),p=await verify(s);
  assert.equal(p.commit,source);assert.equal(p.deployment_commit,commit);assert.equal(p.delivery_allowed,false);
  assert.equal(s.calls.some(c=>c.url.includes("/compare/")),commit!==source);
  assert.ok(s.calls.every(c=>c.options.redirect==="error"&&c.options.cache==="no-store"));
 }
});
test("earlier, divergent and indeterminate deployments cannot downgrade source identity",async()=>{
 for(const patch of [{status:"behind"},{status:"diverged"},{status:"identical"},{base_commit:{sha:later}},{merge_base_commit:{sha:later}},{behind_by:1},{ahead_by:0},{ahead_by:"1"}]){
  const s=site();Object.assign(s.comparison,patch);await assert.rejects(()=>verify(s),/descendant/);
 }
});
test("no marker-only fallback for legacy, missing or invalid proof artifacts",async()=>{
 for(const mutate of [s=>s.proof.schema_version="0.9",s=>s.proof.deployment_commit=source,s=>s.proof.edition="2026-10-31/r1",s=>s.proof.unrecognized=true,s=>s.proof.sources=null]){
  const s=site();mutate(s);await assert.rejects(()=>verify(s),/content proof/);
 }
 const s=site(),fetcher=s.fetcher;s.fetcher=(u,o)=>u.endsWith("publication-proof.json")?new Response("absent",{status:404}):fetcher(u,o);
 await assert.rejects(()=>verify(s),/unavailable/);
});
test("each immutable source byte identity is checked, even when rendered markers survive",async()=>{
 for(const name of ["report.json","articles/item.md","assets/poster.png"]){
  const s=site();s.proof.sources[name]="c".repeat(40);await assert.rejects(()=>verify(s),/source differs/);
 }
 const s=site(),changed=new Map(files);changed.set(prefix+"report.json",Buffer.from("changed"));
 await assert.rejects(()=>verifyPublication(source,"2026-11-01",1,s.fetcher,changed),/bundle differs/);
});
test("page hashes reject tampered bodies with valid markers and incomplete page sets",async()=>{
 for(const name of [slug,slug+"/item"]){
  const s=site();s.pages.set(name,s.pages.get(name).replace("Original rendered body","Other body"));await assert.rejects(()=>verify(s),/page hash/);
 }
 for(const mutate of [s=>delete s.proof.pages[slug+"/item"],s=>s.proof.pages[slug+"/extra"]="c".repeat(64),s=>s.proof.pages[slug]="invalid"]){
  const s=site();mutate(s);await assert.rejects(()=>verify(s),/rendered edition/);
 }
 for(const name of [slug,slug+"/item"]){
  const s=site(),html=s.pages.get(name).replace(name,"other");s.pages.set(name,html);s.proof.pages[name]=contentHash(html);await assert.rejects(()=>verify(s),/identity/);
 }
});
test("source API requires complete immutable commit and ordinary unique blobs",async()=>{
 for(const mutate of [s=>s.commit.sha=later,s=>s.commit.tree.sha="bad",s=>s.tree.sha=source,s=>s.tree.truncated=true,s=>s.tree.tree.push(s.tree.tree[0]),s=>s.tree.tree=s.tree.tree.filter(e=>e.path!==prefix+"report.json"),s=>s.tree.tree[0].mode="120000",s=>s.tree.tree[0].type="commit",s=>s.tree.tree[0].path=prefix+"unexpected.txt",s=>s.tree.tree[0].path=prefix+"articles/index.md"]){
  const s=site();mutate(s);await assert.rejects(()=>verify(s));
 }
});
test("edition and deployment changes during and after page verification fail closed",async()=>{
 for(const mutate of [s=>s.root.commit="c".repeat(40),s=>s.proof.pages[slug]="d".repeat(64)]){
  const s=site(),fetcher=s.fetcher;s.fetcher=async(u,o)=>{const r=await fetcher(u,o);if(u===`${ORIGIN}/${slug}/item/`)mutate(s);return r;};
  await assert.rejects(()=>verify(s),/changed/);
 }
 const s=site(),p=await verify(s);s.root.reports.push("2026-11-02/r1");await assert.rejects(()=>verifyPublicationUnchanged(p,s.fetcher),/changed/);
});
test("network failures, wrong types, excessive lengths and malformed JSON are not proof",async()=>{
 for(const response of [()=>new Response("bad",{status:503}),()=>new Response("{}",{headers:{"content-type":"text/html"}}),()=>new Response("{}",{headers:{"content-type":"application/json","content-length":"999999999"}}),()=>new Response("{",{headers:{"content-type":"application/json"}})]){
  const s=site(),fetcher=s.fetcher;s.fetcher=(u,o)=>u===API+`/git/commits/${source}`?response():fetcher(u,o);await assert.rejects(()=>verify(s));
 }
});
test("Git blob identity matches Git's binary object encoding",()=>{
 for(const bytes of [Buffer.alloc(0),Buffer.from("你好\n"),Buffer.from([0,255,13,10])]){
  const r=spawnSync("git",["hash-object","--stdin"],{input:bytes});assert.equal(r.status,0);assert.equal(gitBlobHash(bytes),r.stdout.toString().trim());
 }
});
test("post-build proof binds final HTML without changing root or notice schemas",async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),"publication-build-"));
 try{
  const s=site(),rootBytes=Buffer.from(JSON.stringify(s.root)),noticeBytes=Buffer.from('{"schema_version":"1.0","commit":"'+later+'"}\n');
  await mkdir(path.join(dir,"generated"));
  await writeFile(path.join(dir,"generated/manifest.json"),JSON.stringify({pages:[{slug,kind:"day"},{slug:slug+"/item",kind:"article",parent:slug,evidence:[{urls:["https://example.com/source"]}]}],publicationSources:{[slug]:editionSources(files,slug)}}));
  for(const [p,html]of s.pages){await mkdir(path.join(dir,"dist",p),{recursive:true});await writeFile(path.join(dir,"dist",p,"index.html"),html.replace("</section>",'<a href="https://example.com/source">Source</a></section>'));}
  await writeFile(path.join(dir,"dist/publication.json"),rootBytes);
  await mkdir(path.join(dir,"dist/reports",slug),{recursive:true});await writeFile(path.join(dir,"dist/reports",slug,"notice.json"),noticeBytes);
  const script=fileURLToPath(new URL("../scripts/check-output.mjs",import.meta.url)),r=spawnSync(process.execPath,[script,"dist"],{cwd:dir,encoding:"utf8"});assert.equal(r.status,0,r.stderr);
  assert.deepEqual(await readFile(path.join(dir,"dist/publication.json")),rootBytes);assert.deepEqual(await readFile(path.join(dir,"dist/reports",slug,"notice.json")),noticeBytes);
  const p=JSON.parse(await readFile(path.join(dir,"dist/reports",slug,"publication-proof.json")));assert.deepEqual(p.sources,editionSources(files,slug));assert.equal(p.deployment_commit,later);
  for(const page of [slug,slug+"/item"])assert.equal(p.pages[page],contentHash(await readFile(path.join(dir,"dist",page,"index.html"))));
 }finally{await rm(dir,{recursive:true,force:true});}
});
