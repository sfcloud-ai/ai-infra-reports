import {createHash} from "node:crypto";

export const NOTICE_ORIGIN = "https://sfcloud-ai.github.io/ai-infra-reports";
export const NOTICE_TEXT_LIMIT = 1900;
export const NOTICE_MANIFEST_LIMIT = 32768;
const SHA = /^[a-f0-9]{40}$(?![\s\S])/;
const HASH = /^[a-f0-9]{64}$(?![\s\S])/;
const ID = /^[a-z0-9][a-z0-9-]{0,79}$(?![\s\S])/;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const requireThat = (ok, message) => {if (!ok) throw Error(message);};
function exact(value, keys, label) {
 requireThat(value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...keys].sort().join(), label + " fields");
}
function singleLine(value, maxBytes) {
 return typeof value === "string" && value.trim() === value && value.length > 0
  && Buffer.byteLength(value) <= maxBytes && !/[\x00-\x1f\x7f-\x9f<>\u2028\u2029\uFEFF\uD800-\uDFFF]/u.test(value);
}
export class NoticeFormatError extends Error {
 constructor() {super("Historical article title is not compatible with single-line notification format");}
}
export class NoticeBudgetError extends Error {
 constructor() {super("Notification exceeds 1900 UTF-8 bytes; shorten article titles, never omit articles or truncate URLs");}
}
// Archive validation runs first. Select from its immutable editions, not the
// wall clock, input ordering or lexicographic revision strings (r10 vs r2).
export function latestNoticeEdition(reports) {
 const latest=reports.reduce((best, r)=>!best || r.date>best.date
  || (r.date===best.date && r.revision>best.revision) ? r : best, null);
 return latest ? `${latest.date}/r${latest.revision}` : null;
}

// The overview and notification both use the complete articles array. This is
// a data-only artifact: it never sends, changes a destination or grants access.
export function createNoticeManifest(reportBytes, commit) {
 requireThat(Buffer.isBuffer(reportBytes) && reportBytes.length > 0 && reportBytes.length < 128 * 1024,
  "Notification source report size");
 requireThat(typeof commit === "string" && (SHA.test(commit) || commit === "local-preview"),
  "Notification build commit");
 const r = JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(reportBytes));
 exact(r, ["schema_version","date","revision","title","subtitle","articles","entries","images","poster"], "Report");
 requireThat(r.schema_version === "1.0" && typeof r.date === "string" && /^\d{4}-\d\d-\d\d$/.test(r.date)
  && !Number.isNaN(Date.parse(r.date + "T00:00:00Z"))
  && new Date(r.date + "T00:00:00Z").toISOString().slice(0,10) === r.date
  && Number.isSafeInteger(r.revision) && r.revision > 0, "Notification edition");
 requireThat(Array.isArray(r.articles) && r.articles.length > 0 && r.articles.length <= 30,
  "Notification requires nonempty articles");
 requireThat(Array.isArray(r.images) && r.images.length <= 20 && typeof r.poster === "string"
  && /^assets\/[a-z0-9][a-z0-9-]{0,79}\.(png|jpg)$(?![\s\S])/.test(r.poster), "Notification poster");
 const poster = r.images.filter(i => i && i.path === r.poster);
 requireThat(poster.length === 1 && typeof poster[0].sha256 === "string" && HASH.test(poster[0].sha256),
  "Notification poster hash");
 const index_url = `${NOTICE_ORIGIN}/${r.date}/r${r.revision}/`;
 const seen = new Set();
 let incompatibleTitle = false;
 const articles = r.articles.map(a => {
  exact(a, ["id","title","summary","sha256"], "Article");
  requireThat(typeof a.id === "string" && ID.test(a.id) && a.id !== "index" && !seen.has(a.id)
   && typeof a.title === "string" && a.title.length > 0 && Buffer.byteLength(a.title) <= 300
   && !/[\x00-\x1f\x7f<>]/.test(a.title), "Notification article identity/title");
  incompatibleTitle ||= !singleLine(a.title, 300);
  seen.add(a.id);
  return {id:a.id, title:a.title, url:index_url + a.id + "/"};
 });
 if (incompatibleTitle) throw new NoticeFormatError();
 const text = `AI Infra 晨报 · ${r.date}\n\n`
  + articles.map(a => `${a.title}\n${a.url}`).join("\n\n");
 if (Buffer.byteLength(text) > NOTICE_TEXT_LIMIT) throw new NoticeBudgetError();
 const manifest = {schema_version:"1.0", commit, date:r.date, revision:r.revision,
  index_url, articles, text,
  poster:{url:`${NOTICE_ORIGIN}/reports/${r.date}/r${r.revision}/${r.poster}`, sha256:poster[0].sha256},
  report_sha256:sha256(reportBytes)};
 requireThat(Buffer.byteLength(JSON.stringify(manifest)) <= NOTICE_MANIFEST_LIMIT, "Notification manifest size");
 return manifest;
}

// An old archive-validated report may predate this format's byte budget or stricter single-line titles. Do not break
// the whole archive to retrofit it, but never suppress a malformed manifest or
// silently omit the newest report's notification.
export function noticeManifestForBuild(reportBytes, commit, {historical=false}={}) {
 try {return createNoticeManifest(reportBytes, commit);}
 catch (error) {
  if (historical && (error instanceof NoticeBudgetError || error instanceof NoticeFormatError)) return null;
  throw error;
 }
}
