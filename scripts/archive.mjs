import {evidenceAssets} from "./evidence-assets.mjs";
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
    assert(/^reports\/(?:index\.json|\d{4}-\d\d-\d\d\/r[1-9]\d*\/(?:report\.json|articles\/[a-z0-9][a-z0-9-]{0,79}\.md|assets\/[a-z0-9][a-z0-9-]{0,79}\.(?:png|jpg)))$/.test(p),"unexpected path: "+p);
    assert(Buffer.isBuffer(b),"expected bytes"); total+=b.length;
  }
  assert(total<=256*1024*1024,"archive size limit");
  const records=[...files.keys()].filter(p=>p.endsWith("/report.json")).sort((a,b)=>{
    const aa=a.split("/"),bb=b.split("/");return aa[1].localeCompare(bb[1]) || Number(aa[2].slice(1))-Number(bb[2].slice(1));
  });
  const used=new Set(["reports/index.json"]), reports=[], entries=[], byId=new Map(), byEvent=new Map(), fingerprints=new Map(), revisions=new Map();
  for(const metaPath of records) {
    const bytes=files.get(metaPath); assert(bytes.length<128*1024,"metadata too large");
    const r=JSON.parse(bytes.toString("utf8")); const dir=metaPath.slice(0,-11);
    object(r,["schema_version","date","revision","title","subtitle","articles","entries","images","poster"],"report");
    assert(r.schema_version==="1.0" && /^\d{4}-\d\d-\d\d$/.test(r.date) && new Date(r.date+"T00:00:00Z").toISOString().slice(0,10)===r.date,"report date");
    assert(Number.isSafeInteger(r.revision) && r.revision===(revisions.get(r.date)||0)+1,"revisions must be consecutive");
    assert(dir==="reports/"+r.date+"/r"+r.revision+"/","report path mismatch");
    revisions.set(r.date,r.revision); used.add(metaPath);
    assert(str(r.title,300) && str(r.subtitle,180),"report title/subtitle");
    assert(Array.isArray(r.articles) && r.articles.length<=30 && Array.isArray(r.entries) && r.entries.length<=100 && Array.isArray(r.images) && r.images.length<=20,"report collections");
    const articles=new Map(),assets=new Map(),articleImages=new Map();
    for(const a of r.articles) {
      object(a,["id","title","summary","sha256"],"article");
      assert(id(a.id) && a.id!=="index" && !articles.has(a.id) && str(a.title,300) && str(a.summary,1200) && sha(a.sha256),"article metadata");
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
      if(old) assert(old.date===r.date && r.revision>1 && old.content===json(normalized) && old.fingerprint===fingerprint,"existing ID changed or reused outside a same-day correction");
      else {
        assert(!fingerprints.has(fingerprint),"historical evidence replay");
        if(byEvent.has(e.event_key)) assert(e.update_of && byId.get(e.update_of)?.event_key===e.event_key,"material update needs related prior ID");
        else assert(e.update_of===null,"unknown update reference");
        const row={...normalized,fingerprint,date:r.date,revision:r.revision};
        entries.push(row);byId.set(e.id,{date:r.date,content:json(normalized),fingerprint,event_key:e.event_key});fingerprints.set(fingerprint,e.id);
        byEvent.set(e.event_key,e.id);
      }
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
  validateArchive(base); const result=validateArchive(head);
  for(const [p,b] of base) if(p!=="reports/index.json") assert(head.get(p)?.equals(b),"published reports are immutable");
  const added=[...head.keys()].filter(p=>!base.has(p) && p!=="reports/index.json");
  assert(added.length>0,"no new report");
  const dirs=new Set(added.map(p=>p.split("/").slice(0,3).join("/")));
  assert(dirs.size===1 && added.some(p=>p.endsWith("/report.json")),"one report revision per PR");
  return result;
}
