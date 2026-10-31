import {PREFIX} from "./github.mjs";
export const CODEOWNERS="* @shipiyouniao\n/reports/\n";
export async function verifyCodeowners(api,sha){
 if(!/^[a-f0-9]{40}$/.test(sha))throw Error("Exact CODEOWNERS revision required");
 const f=await api.request("GET",PREFIX+"/contents/.github/CODEOWNERS?ref="+sha);
 if(f?.type!=="file"||f.encoding!=="base64"||Buffer.from(f.content,"base64").toString("utf8")!==CODEOWNERS)throw Error("Code/config must retain human ownership for App code-review enforcement");
 const errors=await api.request("GET",PREFIX+"/codeowners/errors?ref="+sha);
 if(!Array.isArray(errors?.errors)||errors.errors.length)throw Error("CODEOWNERS is not valid for this repository");
}
