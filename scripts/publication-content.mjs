import {createHash} from "node:crypto";

export const contentHash=bytes=>createHash("sha256").update(bytes).digest("hex");
// GitHub's source tree identifies exact immutable bytes, including metadata.
export const gitBlobHash=bytes=>createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
export function editionSources(files,slug){
 const prefix=`reports/${slug}/`;
 return Object.fromEntries([...files].filter(([p])=>p.startsWith(prefix)).map(([p,b])=>[p.slice(prefix.length),gitBlobHash(b)]).sort(([a],[b])=>a.localeCompare(b)));
}
