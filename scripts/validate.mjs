import {validateCIReportChange} from './historical-backfill.mjs';
import {validateRasters} from "./rasters.mjs";
import {execFileSync} from "node:child_process";
import {readReports,validateArchive,json} from "./archive.mjs";
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
 if(old.size!==files.size || [...files].some(([p,b])=>!old.get(p)?.equals(b)))validateCIReportChange(old,files);
}
console.log("Validated "+result.reports.length+" validated report snapshots and their dedup index");
