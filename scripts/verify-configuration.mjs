// Owner-only read-only verification; this credential never enters the merger or producer.
import {GitHub,PREFIX} from "./github.mjs";
import {mergerPolicy} from "./rules.mjs";
import {verifyCodeowners} from "./codeowners.mjs";
const args=process.argv.slice(2).map(Number);
const [mainId,otherId,updatesId,codeReviewId,reportCreationId,otherCreationId,actionsAppId,producerAppId,mergerAppId]=args;
if(args.length!==9||!args.every(n=>Number.isSafeInteger(n)&&n>0))throw Error("Usage: verify-configuration QUALITY_ID NON_MAIN_ID MAIN_UPDATE_ID CODE_REVIEW_ID REPORT_CREATION_ID OTHER_CREATION_ID ACTIONS_APP_ID PRODUCER_APP_ID MERGER_APP_ID");
const api=new GitHub(process.env.REPORT_CONFIGURATION_TOKEN);
try{
 const sha=(await api.request("GET",PREFIX+"/git/ref/heads/main")).object.sha;
 await verifyCodeowners(api,sha);
 const sets=await Promise.all([mainId,otherId,updatesId,codeReviewId,reportCreationId,otherCreationId].map(id=>api.request("GET",PREFIX+"/rulesets/"+id)));
 console.log(JSON.stringify(mergerPolicy(...sets,actionsAppId,producerAppId,mergerAppId),null,2));
}finally{await api.close();}
