import {validatePageProgressReport} from './page-delivery.mjs';
import {evidenceAssets,evidenceAssetReferences} from "./evidence-assets.mjs";
import {validateReportFields} from './revision-notice.mjs';
// Report-only, data-only contract shared by the publisher, CI and trusted merge gate.
import {createHash} from "node:crypto";
import {readdir, readFile, lstat} from "node:fs/promises";
import path from "node:path";
export const REPOSITORY = "sfcloud-ai/ai-infra-reports";
export const BASE = "/ai-infra-reports";
export const digest = value => createHash("sha256").update(value).digest("hex");
export const json = value => JSON.stringify(value, null, 2) + "\n";
const fail = message => { throw new Error(message); };
const assert = (condition, message) => { if (!condition) fail(message); };
const object = (v, keys, name) => assert(v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === [...keys].sort().join(), name + ": unexpected fields");
const str = (s, max=1000) => typeof s === "string" && s.length > 0 && Buffer.byteLength(s) <= max && !/[\x00-\x1f\x7f<>]/.test(s);
const id = s => typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(s);
const sha = s => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
export function publicURL(value) {
  assert(str(value,2048), "invalid URL");
  const u = new URL(value);
  assert(u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port==="443"), "URL must be public HTTPS");
  const h=u.hostname.toLowerCase();
  assert(h.includes(".") && !h.endsWith(".") && !/^[\d.]+$/.test(h) && !h.includes(":") && !/\.(local|internal|test|localhost|invalid)$/.test(h), "non-public URL host");
  for (const k of [...u.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(k)) u.searchParams.delete(k);
  u.searchParams.sort(); u.hash="";
  return u.href;
}
function image(bytes, filename) {
  assert(bytes.length <= 2*1024*1024 && bytes.length > 24, "image size");
  let w,h;
  if (filename.endsWith(".png")) {
    assert(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString("ascii",12,16)==="IHDR", "PNG signature");
    w=bytes.readUInt32BE(16); h=bytes.readUInt32BE(20);
  } else {
    assert(bytes[0]===255 && bytes[1]===216 && bytes.at(-2)===255 && bytes.at(-1)===217, "JPEG signature");
    for(let p=2;p+4<bytes.length;) {
      assert(bytes[p]===255,"JPEG marker"); const marker=bytes[p+1]; p+=2;
      if(marker===0xda || marker===0xd9) break;
      const size=bytes.readUInt16BE(p); assert(size>=2 && p+size<=bytes.length,"JPEG segment");
      if([0xc0,0xc1,0xc2].includes(marker)) {h=bytes.readUInt16BE(p+3);w=bytes.readUInt16BE(p+5);break;}
      p+=size;
    }
  }
  assert(w>0 && h>0 && w<=8192 && h<=8192 && w*h<=16000000,"image dimensions");
}
export async function readReports(root) {
  const files=new Map();
  async function walk(dir, relative) {
    const stats=await lstat(dir); assert(stats.isDirectory() && !stats.isSymbolicLink(),"report directory");
    for(const name of (await readdir(dir)).sort()) {
      const rel=relative+"/"+name; const full=path.join(dir,name); const st=await lstat(full);
      assert(!st.isSymbolicLink(),"symlinks are forbidden");
      if(st.isDirectory()) await walk(full,rel);
      else {assert(st.isFile() && st.size<=32*1024*1024,"invalid report file");files.set(rel,await readFile(full));}
    }
  }
  await walk(path.join(root,"reports"),"reports"); return files;
}
export function validateArchive(files, {checkIndex=true}={}) {
  assert(files instanceof Map && files.size<=100000,"archive file limit");
  let total=0; for(const [p,b] of files) {
    assert(/^reports\/(?:(?:index|history)\.json|\d{4}-\d\d-\d\d\/(?:r[1-9]\d*\/)?(?:report\.json|articles\/[a-z0-9][a-z0-9-]{0,79}\.md|assets\/[a-z0-9][a-z0-9-]{0,79}\.(?:png|jpg)))$/.test(p),"unexpected path: "+p);
    assert(Buffer.isBuffer(b),"expected bytes"); total+=b.length;
  }
  assert(total<=256*1024*1024,"archive size limit");
  const records=[...files.keys()].filter(p=>p.endsWith("/report.json")).sort((a,b)=>{
    const aa=a.split("/"),bb=b.split("/");return aa[1].localeCompare(bb[1]) || Number(aa[2].slice(1))-Number(bb[2].slice(1));
  });
  const used=new Set(["reports/index.json"]), reports=[], entries=[], byId=new Map(), byEvent=new Map(), fingerprints=new Map(), revisions=new Map();
  const current=files.has("reports/history.json");
  assert(records.every(p=>current ? /^reports\/[^/]+\/report.json$/.test(p) : /\/r[1-9]\d*\/report.json$/.test(p)),"mixed archive layouts");
  if(current) {
    used.add("reports/history.json");
    for(const row of historyRows(files)) {
      assert(!byId.has(row.id) && !fingerprints.has(row.fingerprint),"duplicate history identity/evidence");
      byId.set(row.id,{...row,contentHash:row.content_sha256}); fingerprints.set(row.fingerprint,row.id);byEvent.set(row.event_key,row.id);
    }
  }
  for(const metaPath of records) {
    const bytes=files.get(metaPath); assert(bytes.length<128*1024,"metadata too large");
    const r=JSON.parse(bytes.toString("utf8")); const dir=metaPath.slice(0,-11);
    validateReportFields(r);
    assert(!r.page_delivery||current,"Page delivery requires current report layout");
    assert(/^\d{4}-\d\d-\d\d$/.test(r.date) && new Date(r.date+"T00:00:00Z").toISOString().slice(0,10)===r.date,"report date");
    assert(Number.isSafeInteger(r.revision) && (current ? r.revision>=1 && !revisions.has(r.date) : r.revision===(revisions.get(r.date)||0)+1),"revisions must be consecutive");
    assert(dir==="reports/"+r.date+(current ? "/" : "/r"+r.revision+"/"),"report path mismatch");
    revisions.set(r.date,r.revision); used.add(metaPath);
    assert(str(r.title,300) && str(r.subtitle,180),"report title/subtitle");
    assert(Array.isArray(r.articles) && r.articles.length<=30 && Array.isArray(r.entries) && r.entries.length<=100 && Array.isArray(r.images) && r.images.length<=20,"report collections");
    const articles=new Map(),assets=new Map(),articleImages=new Map();
    for(const a of r.articles) {
      object(a,["id","title","summary","sha256"],"article");
      assert(id(a.id) && a.id!=="index" && !articles.has(a.id) && str(a.title,300) && str(a.summary,1200) && sha(a.sha256),"article metadata");
      assert(!current||!/^r[1-9]\d*$/.test(a.id),'Revision-shaped article IDs are reserved for legacy redirects');
      const p=dir+"articles/"+a.id+".md", body=files.get(p);
      assert(body && body.length>0 && body.length<=256*1024 && digest(body)===a.sha256,"article hash/size: "+p);
      const text=new TextDecoder("utf-8",{fatal:true}).decode(body);
      assert(!text.startsWith("---") && !/\x00/.test(text),"article frontmatter/control");
      articles.set(a.id,a);articleImages.set(a.id,evidenceAssets(text,dir,files));used.add(p);
    }
    for(const a of r.images) {
      object(a,["path","sha256","alt"],"image");
      assert(/^assets\/[a-z0-9][a-z0-9-]{0,79}\.(png|jpg)$/.test(a.path) && !assets.has(a.path) && sha(a.sha256) && str(a.alt,1000),"image metadata");
      const p=dir+a.path,b=files.get(p);assert(b && digest(b)===a.sha256,"image hash");image(b,p);assets.set(a.path,a);used.add(p);
    }
    assert(r.poster===null || (typeof r.poster==="string" && assets.has(r.poster)),"poster must reference a declared image");
    const localIds=new Set();
    for(const e of r.entries) {
      object(e,["id","event_key","title","summary","source_urls","update_of","article_id"],"entry");
      assert(id(e.id) && !localIds.has(e.id) && id(e.event_key) && str(e.title,300) && str(e.summary,1600) && articles.has(e.article_id),"entry identity/article");
      assert(Array.isArray(e.source_urls) && e.source_urls.length>0 && e.source_urls.length<=20,"entry evidence");
      const urls=[...new Set(e.source_urls.map(publicURL))].sort();
      const normalized={id:e.id,event_key:e.event_key,title:e.title,summary:e.summary,source_urls:urls,update_of:e.update_of,article_id:e.article_id};
      const fingerprint=digest(json({title:e.title,summary:e.summary,source_urls:urls,article_sha256:articles.get(e.article_id).sha256,image_sha256:articleImages.get(e.article_id)}));
      assert(e.update_of===null || (id(e.update_of) && e.update_of!==e.id),"update reference");
      const old=byId.get(e.id);
      if(old) assert(old.date===r.date && (current ? r.revision>=old.revision : r.revision>1) && (old.contentHash ? old.contentHash===digest(json(normalized)) : old.content===json(normalized)) && old.fingerprint===fingerprint,"existing ID changed or reused outside a same-day correction");
      else {
        assert(!fingerprints.has(fingerprint),"historical evidence replay");
        if(byEvent.has(e.event_key)) {
          const prior=byId.get(e.update_of);
          assert(e.update_of && prior?.event_key===e.event_key && (!current || prior.date<r.date || prior.date===r.date && prior.revision<=r.revision),"material update needs related prior ID");
        }
        else assert(e.update_of===null,"unknown update reference");
        const row={...normalized,fingerprint,date:r.date,revision:r.revision};
        entries.push(row);byId.set(e.id,{date:r.date,revision:r.revision,content:json(normalized),fingerprint,event_key:e.event_key});fingerprints.set(fingerprint,e.id);
        byEvent.set(e.event_key,e.id);
      }
      if(current && old) entries.push({...normalized,fingerprint,date:r.date,revision:r.revision});
      localIds.add(e.id);
    }
    assert(r.articles.every(a=>r.entries.some(e=>e.article_id===a.id)),"each article needs source-backed entries");
    reports.push({...r,path:dir,articles:r.articles.map(a=>({...a,path:dir+"articles/"+a.id+".md"}))});
  }
  assert([...files.keys()].every(p=>used.has(p)),"undeclared archive file");
  const index={schema_version:"1.0",reports:reports.map(({entries,images,...r})=>r),entries};
  const encoded=json(index);assert(Buffer.byteLength(encoded)<=32*1024*1024,"index size limit");
  if(checkIndex) assert(files.get("reports/index.json")?.toString("utf8")===encoded,"index must match reports in the same commit");
  return {index,reports};
}
export function validateChange(base, head) {
  if(base.has("reports/history.json") || head.has("reports/history.json")) return validateCurrentChange(base,head);

  validateArchive(base); const result=validateArchive(head);
  for(const [p,b] of base) if(p!=="reports/index.json") assert(head.get(p)?.equals(b),"published reports are immutable");
  const added=[...head.keys()].filter(p=>!base.has(p) && p!=="reports/index.json");
  assert(added.length>0,"no new report");
  const dirs=new Set(added.map(p=>p.split("/").slice(0,3).join("/")));
  assert(dirs.size===1 && added.some(p=>p.endsWith("/report.json")),"one report revision per PR");
  const next=result.reports.find(r=>r.path===[...dirs][0]+'/');
  assert(next.revision===1||['1.1','1.2'].includes(next.schema_version),'New revisions require an explicit notification policy');
  return result;
}

// Minimal provenance only. No retired titles, summaries, source URLs or article text.
export function historyRows(files) {
  if(!files.has("reports/history.json")) return [];
  const h=JSON.parse(files.get("reports/history.json"));
  object(h,["schema_version","entries"],"history");
  assert(h.schema_version==="1.0" && Array.isArray(h.entries) && h.entries.length<=100000,"history schema");
  for(const r of h.entries) {
    object(r,["id","event_key","date","revision","fingerprint","content_sha256"],"history entry");
    assert(id(r.id)&&id(r.event_key)&&/^\d{4}-\d\d-\d\d$/.test(r.date)&&new Date(r.date+"T00:00:00Z").toISOString().slice(0,10)===r.date&&Number.isSafeInteger(r.revision)&&r.revision>=1&&sha(r.fingerprint)&&sha(r.content_sha256),"history entry values");
  }
  return h.entries;
}
export function exportedHistory(files) {
  const result=validateArchive(files), rows=new Map(historyRows(files).map(r=>[r.id,r]));
  for(const e of result.index.entries) if(!rows.has(e.id)) {
    const {id,event_key,title,summary,source_urls,update_of,article_id,date,revision,fingerprint}=e;
    rows.set(id,{id,event_key,date,revision,fingerprint,content_sha256:digest(json({id,event_key,title,summary,source_urls,update_of,article_id}))});
  }
  return Buffer.from(json({schema_version:"1.0",entries:[...rows.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.revision-b.revision||a.id.localeCompare(b.id))}));
}
export function reindexArchive(files) {
  files.set("reports/index.json",Buffer.from(json(validateArchive(files,{checkIndex:false}).index)));return files;
}
export function migrateArchive(base) {
  const result=validateArchive(base);
  if(base.has("reports/history.json")) return new Map(base);
  const latest=new Map();for(const r of result.reports)latest.set(r.date,r);
  // One-time migration preserves each latest edition's exact source contract.
  // Audit every date before constructing output; dependency repair is a normal
  // reviewed revision, never an unversioned report.json or image rewrite.
  for(const r of latest.values()){
    for(const a of r.articles)for(const source of evidenceAssetReferences(base.get(a.path).toString('utf8'),r.path,base).values()){
      if(source.startsWith(r.path))continue;
      const asset='assets/'+source.split('/').at(-1),local=base.get(r.path+asset);
      assert(source.startsWith('reports/'+r.date+'/')&&r.images.some(i=>i.path===asset)&&local?.equals(base.get(source)),
        `Migration requires a self-contained latest edition: ${r.date}/${a.id} references ${source}; publish a reviewed revision with declared same-byte assets before migrating`);
    }
  }
  const head=new Map([["reports/history.json",exportedHistory(base)]]);
  for(const r of latest.values())for(const [p,b]of base)if(p.startsWith(r.path))head.set('reports/'+r.date+'/'+p.slice(r.path.length),b);
  return reindexArchive(head);
}
const sameFiles=(a,b)=>a.size===b.size&&[...a].every(([p,bytes])=>b.get(p)?.equals(bytes));
export function validateMigration(base,head) {
  assert(!base.has("reports/history.json"),"already migrated");
  assert(sameFiles(migrateArchive(base),head),"migration must exactly preserve latest snapshots and exported history");
  return validateArchive(head);
}
export function replaceCurrentReport(base,bundle) {
  const head=new Map(base), incoming=[...bundle].filter(([p])=>p!=="reports/index.json");
  const metas=incoming.filter(([p])=>p.endsWith("/report.json"));assert(metas.length===1,"one report revision per PR");
  const [meta,bytes]=metas[0],r=JSON.parse(bytes),prefix=meta.slice(0,-11),dir="reports/"+r.date+"/";
  assert(prefix===dir||prefix===dir+"r"+r.revision+"/","report path mismatch");
  assert(incoming.every(([p])=>p.startsWith(prefix)),"one report revision per PR");
  for(const p of head.keys())if(p.startsWith(dir))head.delete(p);
  for(const [p,b]of incoming)head.set(dir+p.slice(prefix.length),b);
  head.set("reports/history.json",exportedHistory(base));
  reindexArchive(head);validateChange(base,head);return head;
}
function validateCurrentChange(base,head) {
  assert(base.has("reports/history.json")&&head.has("reports/history.json"),"layout migration requires explicit migration validation");
  const previous=validateArchive(base), result=validateArchive(head);
  assert(head.get("reports/history.json").equals(exportedHistory(base)),"history must exactly extend validated base");
  const changed=new Set([...new Set([...base.keys(),...head.keys()])].filter(p=>!/^reports\/(index|history)\.json$/.test(p)&&(!base.has(p)||!head.has(p)||!base.get(p).equals(head.get(p)))).map(p=>p.split("/")[1]));
  assert(changed.size===1,"one report revision per PR");
  const date=[...changed][0],old=previous.reports.find(r=>r.date===date),next=result.reports.find(r=>r.date===date);
  assert(next&&next.revision===(old?.revision||0)+1,"revisions must be consecutive");
  if(next.page_delivery&&next.revision>1||old?.page_delivery?.pending.length)validatePageProgressReport(old,next);
  assert(next.revision===1||['1.1','1.2'].includes(next.schema_version),'New revisions require an explicit notification policy');
  return result;
}
