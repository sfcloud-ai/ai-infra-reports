import {validateRasters} from "./rasters.mjs";
import {execFileSync} from "node:child_process";
import {readReports,validateArchive,validateChange,json} from "./archive.mjs";
const files=await readReports(process.cwd()),result=validateArchive(files);
const base=process.env.REPORT_BASE_SHA;
await validateRasters(files);
if(base){
 if(!/^[a-f0-9]{40}$/.test(base))throw Error("Invalid PR base");
 const git=process.env.REPORT_GIT_BIN||"git";
 const paths=execFileSync(git,["ls-tree","-r","--name-only",base,"--","reports/"],{encoding:"utf8"}).trim().split("\n").filter(Boolean);
 const old=new Map(paths.map(p=>[p,execFileSync(git,["show",base+":"+p],{maxBuffer:32*1024*1024})]));
 if(!old.size)old.set("reports/index.json",Buffer.from(json({schema_version:"1.0",reports:[],entries:[]})));
 validateArchive(old);
 for(const [p,b]of old)if(p!=="reports/index.json"&&!files.get(p)?.equals(b))throw Error("Published history is immutable: "+p);
 if([...files.keys()].some(p=>!old.has(p)))validateChange(old,files);
}
console.log("Validated "+result.reports.length+" immutable report revisions and their dedup index");
