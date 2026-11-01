import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createNoticeManifest, latestNoticeEdition, noticeManifestForBuild, NoticeBudgetError, NOTICE_ORIGIN} from "../scripts/notice-manifest.mjs";

const COMMIT = "a".repeat(40), HASH = "b".repeat(64);
const bytes = r => Buffer.from(JSON.stringify(r) + "\n");
function report(count=2) {
 return {schema_version:"1.0", date:"2026-11-01", revision:1,
  title:"AI Infra 晨报 · 2026-11-01", subtitle:"An edition-wide theme must not replace article titles",
  articles:Array.from({length:count}, (_, i) => ({id:`article-${i+1}`, title:`Topic ${i+1}`,
   summary:`Summary ${i+1} must not appear`, sha256:HASH})), entries:[],
  images:[{path:"assets/poster.png", sha256:HASH, alt:"An original diagram"}], poster:"assets/poster.png"};
}
test("all article titles and URLs, but no summaries or edition theme", () => {
 const r=report(), m=createNoticeManifest(bytes(r), COMMIT);
 const root=NOTICE_ORIGIN+"/2026-11-01/r1/";
 assert.equal(m.text, "AI Infra 晨报 · 2026-11-01\n\nTopic 1\n"+root+"article-1/\n\nTopic 2\n"+root+"article-2/");
 assert.deepEqual(m.articles, r.articles.map(a => ({id:a.id,title:a.title,url:root+a.id+"/"})));
 assert.equal(m.index_url,root);
 assert.deepEqual(m.poster,{url:NOTICE_ORIGIN+"/reports/2026-11-01/r1/assets/poster.png",sha256:HASH});
 assert.ok(!m.text.includes("Summary") && !m.text.includes(r.subtitle));
 assert.deepEqual(Object.keys(m),["schema_version","commit","date","revision","index_url","articles","text","poster","report_sha256"]);
});
test("manifest is deterministic and binds the exact raw report bytes", () => {
 const raw=bytes(report()), a=createNoticeManifest(raw,COMMIT), b=createNoticeManifest(raw,COMMIT);
 assert.deepEqual(a,b);
 assert.equal(a.report_sha256,createHash("sha256").update(raw).digest("hex"));
 const spaced=Buffer.concat([raw,Buffer.from("\n")]), c=createNoticeManifest(spaced,COMMIT);
 assert.equal(a.text,c.text);assert.notEqual(a.report_sha256,c.report_sha256);
});
test("changed unused summary affects provenance, not the requested text format", () => {
 const a=report(), b=structuredClone(a);b.articles[0].summary="Revised source summary";
 const ma=createNoticeManifest(bytes(a),COMMIT),mb=createNoticeManifest(bytes(b),COMMIT);
 assert.equal(ma.text,mb.text);assert.notEqual(ma.report_sha256,mb.report_sha256);
});
test("date, revision, article IDs and unique canonical paths are strict", () => {
 const mutations=[r=>r.date="2026-02-30",r=>r.date="2026-1-01",r=>r.revision=0,r=>r.revision=1.2,
  r=>r.articles[0].id="../other",r=>r.articles[0].id="index",r=>r.articles[0].id="article\n",r=>r.articles[1].id=r.articles[0].id,
  r=>r.articles[0].url="https://evil.example/"];
 for(const mutate of mutations){const r=report();mutate(r);assert.throws(()=>createNoticeManifest(bytes(r),COMMIT));}
});
test("titles stay single-line text within source metadata limits", () => {
 for(const value of ["", " leading", "trailing ", "two\nlines", "x\r", "<@UOTHER>","a\u2028b","a\u2029b", "x\u0000", "a\u0085b", "a\uFEFFb", "\ud800", "字".repeat(101)]){
  const r=report();r.articles[0].title=value;assert.throws(()=>createNoticeManifest(bytes(r),COMMIT));
 }
 const r=report();r.articles[0].title="模型资源池 🧠";
 assert.ok(createNoticeManifest(bytes(r),COMMIT).text.includes(r.articles[0].title));
});
test("1900 UTF-8 byte budget includes every title and complete URL", () => {
 const r=report(6);for(const a of r.articles)a.title="x";
 let left=1900-Buffer.byteLength(createNoticeManifest(bytes(r),COMMIT).text);
 for(const a of r.articles){const add=Math.min(299,left);a.title+="x".repeat(add);left-=add;}
 assert.equal(left,0);assert.equal(Buffer.byteLength(createNoticeManifest(bytes(r),COMMIT).text),1900);
 r.articles.at(-1).title+="x";
 assert.throws(()=>createNoticeManifest(bytes(r),COMMIT),NoticeBudgetError);
});
test("only the declared PNG or JPEG poster is eligible", () => {
 const mutations=[r=>r.poster=null,r=>r.poster="assets/missing.png",r=>r.poster="../poster.png",
  r=>r.images[0].sha256="not-a-hash",r=>r.images[0].sha256=HASH+"\n",r=>r.images.push({...r.images[0]}),r=>r.poster="assets/poster.svg",
  r=>{r.poster="assets/poster.png\n";r.images[0].path=r.poster;}];
 for(const mutate of mutations){const r=report();mutate(r);assert.throws(()=>createNoticeManifest(bytes(r),COMMIT));}
 const r=report();r.poster="assets/poster.jpg";r.images[0].path=r.poster;
 assert.ok(createNoticeManifest(bytes(r),COMMIT).poster.url.endsWith(".jpg"));
});
test("no-news cannot silently become a normal article notification", () => {
 assert.throws(()=>createNoticeManifest(bytes(report(0)),COMMIT),/nonempty articles/);
});
test("commit identity is explicit, including an unmistakable local preview marker", () => {
 assert.equal(createNoticeManifest(bytes(report()),"local-preview").commit,"local-preview");
 for(const commit of [null,"", "main", "A".repeat(40), "a".repeat(39), COMMIT+"\n"])
  assert.throws(()=>createNoticeManifest(bytes(report()),commit),/build commit/);
});
test("malformed, oversized or extra-field source metadata is rejected", () => {
 assert.throws(()=>createNoticeManifest(Buffer.from([0xff]),COMMIT));
 assert.throws(()=>createNoticeManifest(Buffer.alloc(128*1024),COMMIT));
 assert.throws(()=>createNoticeManifest("{}",COMMIT));
 const r=report();r.extra="untrusted";assert.throws(()=>createNoticeManifest(bytes(r),COMMIT));
});
test("historical over-budget reports are skipped, but latest and malformed data fail closed", () => {
 const r=report(10);for(const a of r.articles)a.title="x".repeat(300);
 assert.equal(noticeManifestForBuild(bytes(r),COMMIT,{historical:true}),null);
 assert.throws(()=>noticeManifestForBuild(bytes(r),COMMIT),NoticeBudgetError);
 r.articles[0].id="../wrong";
 assert.throws(()=>noticeManifestForBuild(bytes(r),COMMIT,{historical:true}));
});
test("latest edition is repository-defined and uses numeric revisions, independent of input order", () => {
 const editions=[{date:"2026-10-31",revision:999},{date:"2026-11-01",revision:2},{date:"2026-11-01",revision:10}];
 assert.equal(latestNoticeEdition(editions),"2026-11-01/r10");
 assert.equal(latestNoticeEdition([...editions].reverse()),"2026-11-01/r10");
 assert.equal(latestNoticeEdition([]),null);
});
test("archive-valid legacy title formatting skips historical notices only", () => {
 for(const title of [" Topic", "Topic ", "Topic\u0085", "Topic\u2028", "Topic\ufeff", "Topic\ud800"]){
  const r=report();r.articles[0].title=title;
  assert.equal(noticeManifestForBuild(bytes(r),COMMIT,{historical:true}),null);
  assert.throws(()=>noticeManifestForBuild(bytes(r),COMMIT),/single-line/);
  r.articles[1].id="../bad";
  assert.throws(()=>noticeManifestForBuild(bytes(r),COMMIT,{historical:true}),/identity/);
 }
 for(const title of ["", "Topic\n", "<Topic>", "x".repeat(301)]){
  const r=report();r.articles[0].title=title;
  assert.throws(()=>noticeManifestForBuild(bytes(r),COMMIT,{historical:true}),/identity/);
 }
});
test("archive-valid historical title whitespace keeps pages valid without a notification manifest", async () => {
 const {readReports,validateArchive,json}=await import("../scripts/archive.mjs");
 const files=await readReports(".");
 const filename="reports/2026-11-01/r1/report.json", original=JSON.parse(files.get(filename));
 for(const title of [" "+original.articles[0].title+" ",original.articles[0].title+"\u0085",original.articles[0].title+"\u2028"]){
  const r=structuredClone(original);r.articles[0].title=title;files.set(filename,bytes(r));
  files.set("reports/index.json",Buffer.from(json(validateArchive(files,{checkIndex:false}).index)));
  assert.doesNotThrow(()=>validateArchive(files));
  assert.equal(noticeManifestForBuild(files.get(filename),COMMIT,{historical:true}),null);
  assert.throws(()=>noticeManifestForBuild(files.get(filename),COMMIT),/single-line/);
 }
});
