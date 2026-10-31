import test from "node:test";
import assert from "node:assert/strict";
import {verifyCodeowners,CODEOWNERS} from "../scripts/codeowners.mjs";
test("default-branch CODEOWNERS must protect all non-report paths and pass GitHub validation",async()=>{
 const sha="a".repeat(40);
 for(const [content,errors,pass] of [[CODEOWNERS,[],true],["/scripts/ @shipiyouniao\n",[],false],[CODEOWNERS,[{kind:"Invalid owner"}],false]]){
  const api={request:async(_,route)=>{assert(route.endsWith(sha));return route.includes("/contents/")?{type:"file",encoding:"base64",content:Buffer.from(content).toString("base64")}:{errors};}};
  if(pass)await verifyCodeowners(api,sha);else await assert.rejects(()=>verifyCodeowners(api,sha));
 }
});
