import {spawnSync} from "node:child_process";
for (const args of [["scripts/prepare-content.mjs"],["node_modules/astro/bin/astro.mjs","sync","--force"],["node_modules/astro/bin/astro.mjs","build"],["node_modules/pagefind/lib/runner/bin.cjs","--site","dist-preview"],["scripts/check-output.mjs","dist-preview"]]) {
 const r=spawnSync(process.execPath,args,{stdio:"inherit",env:{...process.env,REPORT_PREVIEW:"1"}});
 if(r.status!==0)process.exit(r.status||1);
}
