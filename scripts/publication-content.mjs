import {createHash} from "node:crypto";

export const contentHash=bytes=>createHash("sha256").update(bytes).digest("hex");
// GitHub's source tree identifies exact immutable bytes, including metadata.
export const gitBlobHash=bytes=>createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
export function editionSources(files,slug){
 const legacy=`reports/${slug}/`,date=slug.split('/')[0],current=`reports/${date}/`;
 const hasLegacy=files.has(legacy+'report.json'),hasCurrent=files.has(current+'report.json');
 if(hasLegacy&&hasCurrent)throw Error('Ambiguous edition source layout');
 const prefix=hasCurrent?current:legacy;
 if(hasCurrent){
  const report=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(files.get(current+'report.json')));
  if(`${report.date}/r${report.revision}`!==slug)throw Error('Current source revision mismatch');
 }
 return Object.fromEntries([...files].filter(([p])=>p.startsWith(prefix)).map(([p,b])=>[p.slice(prefix.length),gitBlobHash(b)]).sort(([a],[b])=>a.localeCompare(b)));
}
