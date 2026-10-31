// Owner-only read-only verification; this credential never enters the merger or producer.
import {GitHub,PREFIX} from "./github.mjs";
import {mergerPolicy} from "./rules.mjs";
import {verifyCodeowners} from "./codeowners.mjs";
const [mainId,otherId,updatesId,actionsAppId,producerAppId,mergerAppId]=process.argv.slice(2).map(Number);
if(![mainId,otherId,updatesId,actionsAppId,producerAppId,mergerAppId].every(n=>Number.isSafeInteger(n)&&n>0))throw Error("Usage: verify-configuration QUALITY_ID NON_MAIN_ID MAIN_UPDATE_ID ACTIONS_APP_ID PRODUCER_APP_ID MERGER_APP_ID");
const api=new GitHub(process.env.REPORT_CONFIGURATION_TOKEN);
try{
 const sha=(await api.request("GET",PREFIX+"/git/ref/heads/main")).object.sha;
 await verifyCodeowners(api,sha);
 const sets=await Promise.all([mainId,otherId,updatesId].map(id=>api.request("GET",PREFIX+"/rulesets/"+id)));
 console.log(JSON.stringify(mergerPolicy(...sets,actionsAppId,producerAppId,mergerAppId),null,2));
}finally{await api.close();}
