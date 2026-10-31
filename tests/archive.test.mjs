import test from "node:test";
import assert from "node:assert/strict";
import {readReports,validateArchive,validateChange,digest,json,publicURL} from "../scripts/archive.mjs";
const original=await readReports("tests/fixtures/archive");
const copy=()=>new Map([...original].map(([p,b])=>[p,Buffer.from(b)]));
const empty=new Map([["reports/index.json",Buffer.from(json({schema_version:"1.0",reports:[],entries:[]}))]]);
function edit(files,fn){const p="reports/2026-10-31/r1/report.json",r=JSON.parse(files.get(p));fn(r);files.set(p,Buffer.from(json(r)));return files;}
function reindex(files){files.set("reports/index.json",Buffer.from(json(validateArchive(files,{checkIndex:false}).index)));return files;}
test("daily index and separate articles validate, empty production archive is valid",()=>{assert.equal(validateArchive(original).reports.length,2);assert.equal(validateArchive(empty).reports.length,0);});
test("index must be atomic with content",()=>{const f=copy();f.set("reports/index.json",empty.get("reports/index.json"));assert.throws(()=>validateArchive(f),/same commit/);});
test("changed article bytes invalidate hash",()=>{const f=copy();f.set("reports/2026-10-31/r1/articles/kv-cache.md",Buffer.from("altered"));assert.throws(()=>validateArchive(f),/hash/);});
test("unknown paths and symlink-shaped filenames fail closed",()=>{for(const p of ["reports/../x","reports/2026-10-31/r1/run.mjs","reports/2026-10-31/r1/assets/x.svg"]){const f=copy();f.set(p,Buffer.from("x"));assert.throws(()=>validateArchive(f),/unexpected path/);}});
test("undeclared content and unused articles rejected",()=>{const f=copy();f.set("reports/2026-10-31/r1/articles/hidden.md",Buffer.from("x"));assert.throws(()=>validateArchive(f),/undeclared/);assert.throws(()=>validateArchive(edit(copy(),r=>r.entries=[])),/source-backed/);});
test("private/numeric hosts, credentials and malformed URL rejected",()=>{for(const u of ["http://docs.vllm.ai/","https://localhost/","https://2130706433/","https://example.local/","https://user:pass@example.com/","https://example.com./"]){assert.throws(()=>publicURL(u));}});
test("canonical evidence ignores tracking and parameter order",()=>{assert.equal(publicURL("https://example.com/a?b=2&utm_source=x&a=1#h"),"https://example.com/a?a=1&b=2");});
test("bad date and discontinuous revisions rejected",()=>{assert.throws(()=>validateArchive(edit(copy(),r=>r.date="2026-02-31")));assert.throws(()=>validateArchive(edit(copy(),r=>r.revision=9)),/consecutive/);});
test("MDX/frontmatter cannot become executable content",()=>{const f=copy(),p="reports/2026-10-31/r1/articles/kv-cache.md",b=Buffer.from("---\ncode: true\n---\n");f.set(p,b);edit(f,r=>r.articles[0].sha256=digest(b));assert.throws(()=>validateArchive(f),/frontmatter/);});
function revision(files,{newId=false,changed=false,update=null}={}){
 const oldDir="reports/2026-10-31/r1/",dir="reports/2026-10-31/r2/";
 for(const [p,b]of [...files])if(p.startsWith(oldDir))files.set(p.replace(oldDir,dir),Buffer.from(b));
 const meta=dir+"report.json",r=JSON.parse(files.get(meta));r.revision=2;
 if(changed){const p=dir+"articles/kv-cache.md",b=Buffer.concat([files.get(p),Buffer.from("\n更新的实验条件。\n")]);files.set(p,b);r.articles[0].sha256=digest(b);r.entries[0].summary+=" 新证据。";}
 if(newId)r.entries[0].id+="-update";
 r.entries[0].update_of=update;files.set(meta,Buffer.from(json(r)));return files;
}
test("unchanged IDs can appear in an immutable correction revision",()=>{const f=reindex(revision(copy()));assert.equal(validateChange(original,f).reports.length,3);});
test("existing ID may not change its content or ancestry",()=>{assert.throws(()=>reindex(revision(copy(),{changed:true})),/existing ID/);assert.throws(()=>reindex(revision(copy(),{update:"2026-10-30-communication"})),/existing ID/);});
test("material event updates require a related previous ID",()=>{assert.throws(()=>reindex(revision(copy(),{newId:true,changed:true})),/prior ID/);const f=reindex(revision(copy(),{newId:true,changed:true,update:"2026-10-31-kv-cache"}));assert.equal(validateArchive(f).index.entries.length,4);});
test("new IDs cannot replay historical evidence",()=>{assert.throws(()=>reindex(revision(copy(),{newId:true,update:"2026-10-31-kv-cache"})),/replay/);});
test("merge gate prohibits history rewrite and multiple editions",()=>{assert.throws(()=>validateChange(empty,original),/one report/);const f=copy();f.delete("reports/2026-10-30/r1/report.json");assert.throws(()=>validateChange(original,f));});
test("poster must reference validated raster bytes",()=>{assert.throws(()=>validateArchive(edit(copy(),r=>r.poster="assets/no.png")),/poster/);const f=copy();edit(f,r=>{const b=Buffer.from("this is not an image but has enough bytes");r.images=[{path:"assets/bad.png",sha256:digest(b),alt:"bad"}];f.set("reports/2026-10-31/r1/assets/bad.png",b);});assert.throws(()=>validateArchive(f),/PNG/);});

test("changing event identity cannot replay the same evidence",()=>{
 const f=revision(copy(),{newId:true});const p="reports/2026-10-31/r2/report.json",r=JSON.parse(f.get(p));r.entries[0].event_key="renamed-event";f.set(p,Buffer.from(json(r)));
 assert.throws(()=>reindex(f),/replay/);
});
test("JSON key order is not a content change",()=>{
 const f=revision(copy()),p="reports/2026-10-31/r2/report.json",r=JSON.parse(f.get(p));r.entries=r.entries.map(e=>Object.fromEntries(Object.entries(e).reverse()));f.set(p,Buffer.from(json(r)));
 assert.doesNotThrow(()=>reindex(f));
});
test("index article ID cannot overwrite a generated day index",()=>{
 const f=copy(),p="reports/2026-10-31/r1/articles/kv-cache.md";f.set(p.replace("kv-cache.md","index.md"),f.get(p));f.delete(p);
 edit(f,r=>{r.articles[0].id="index";r.entries[0].article_id="index";});
 assert.throws(()=>validateArchive(f),/article metadata/);
});

test("unchanged evidence cannot be copied into a later daily edition",()=>{
 const f=copy(),from="reports/2026-10-31/r1/",to="reports/2026-11-01/r1/";
 for(const [p,b]of [...f])if(p.startsWith(from))f.set(p.replace(from,to),Buffer.from(b));
 const p=to+"report.json",r=JSON.parse(f.get(p));r.date="2026-11-01";f.set(p,Buffer.from(json(r)));
 assert.throws(()=>reindex(f),/same-day/);
});

import sharp from "sharp";
test("image-only evidence updates need a new event ID and valid ancestry",async()=>{
 const base=copy(),dir="reports/2026-10-31/r1/",body=Buffer.concat([base.get(dir+"articles/kv-cache.md"),Buffer.from("\n![Results](assets/plot.png)\n")]);
 const image=await sharp({create:{width:2,height:2,channels:3,background:"#123456"}}).png().toBuffer();
 base.set(dir+"articles/kv-cache.md",body);base.set(dir+"assets/plot.png",image);
 edit(base,r=>{r.articles[0].sha256=digest(body);r.images=[{path:"assets/plot.png",sha256:digest(image),alt:"Results"}];});reindex(base);
 const f=revision(new Map(base)),meta="reports/2026-10-31/r2/report.json",r=JSON.parse(f.get(meta));
 const changed=await sharp({create:{width:2,height:2,channels:3,background:"#987654"}}).png().toBuffer();
 f.set("reports/2026-10-31/r2/assets/plot.png",changed);r.images[0].sha256=digest(changed);f.set(meta,Buffer.from(json(r)));
 assert.throws(()=>reindex(f),/existing ID/);
 r.entries[0].id+="-chart-update";r.entries[0].update_of="2026-10-31-kv-cache";f.set(meta,Buffer.from(json(r)));
 assert.equal(validateChange(base,reindex(f)).reports.length,3);
});
