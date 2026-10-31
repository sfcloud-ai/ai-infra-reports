// Run only in the trusted producer, after its App and repository controls are configured.
import {readFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {readReports} from "./archive.mjs";
import {GitHub} from "./github.mjs";
import {propose} from "./propose.mjs";
import {withProducerToken} from "./producer-token.mjs";

export async function proposeWithApp(bundle,expectedBase,identity,{ready=false,fetcher=fetch,now=Date.now,createAPI=token=>new GitHub(token)}={}) {
 if(!/^[a-f0-9]{40}$/.test(expectedBase)||!(bundle instanceof Map)||bundle.size===0||typeof ready!=="boolean")throw Error("Report bundle, exact main SHA and explicit readiness required");
 return withProducerToken(identity,async token=>{
  const api=createAPI(token);
  try {return await propose(api,bundle,expectedBase,{ready});}
  finally {await api.close();}
 },{fetcher,now});
}

if(import.meta.url===pathToFileURL(process.argv[1]||"").href){
 try {
  const [bundleRoot,base,...flags]=process.argv.slice(2);
  if(!bundleRoot||!base||flags.some(f=>f!=="--ready")||flags.length>1)throw Error("Usage: node scripts/propose-with-app.mjs BUNDLE_ROOT EXPECTED_MAIN_SHA [--ready]");
  const keyFile=process.env.REPORT_PRODUCER_PRIVATE_KEY_FILE;
  if(!keyFile)throw Error("REPORT_PRODUCER_PRIVATE_KEY_FILE is required from the trusted secret store");
  const bundle=await readReports(bundleRoot);
  const identity={appId:Number(process.env.REPORT_PRODUCER_APP_ID),mergerAppId:Number(process.env.REPORT_MERGER_APP_ID),privateKey:await readFile(keyFile)};
  console.log(JSON.stringify(await proposeWithApp(bundle,base,identity,{ready:flags.includes("--ready")})));
 } catch(error){console.error(error.message);process.exitCode=1;}
}
