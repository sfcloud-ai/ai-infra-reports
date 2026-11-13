// Fixed local verifier for the relay-owned scheduler. No network writes, tokens,
// arbitrary URL, destination or executable can be selected by the request.
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';
import {decodeBundle,verifyReportPublication,requireThat} from './report-handoff.mjs';
import {createNoticeManifest} from './notice-manifest.mjs';
import {createPublicationSourceCache,verifyImmutableSource} from './verify-publication.mjs';
async function decodeInput(input){
 requireThat(input&&Object.keys(input).sort().join()==='bundle_base64,report_commit','Exact scheduled verification input required');
 requireThat(typeof input.bundle_base64==='string'&&input.bundle_base64.length<=12*1024*1024,'Bounded bundle required');
 const bytes=Buffer.from(input.bundle_base64,'base64');
 requireThat(bytes.toString('base64')===input.bundle_base64,'Canonical base64 required');
 return decodeBundle(bytes);
}
function deliveryPlan(bundle,commit,stableUrls=bundle.report.path===`reports/${bundle.report.date}/`){
 const manifest=createNoticeManifest(bundle.files.get(bundle.report.path+'report.json'),commit,{stableUrls});
 const poster=bundle.files.get(bundle.report.path+bundle.report.poster);
 return {report_request_id:bundle.data.request_id,report_date:bundle.report.date,report_commit:commit,bundle_sha256:bundle.hash,
  notice_key:manifest.index_url,text:manifest.text,
  ...(bundle.report.page_delivery?{page_state:{...bundle.report.page_delivery,articles:bundle.report.articles.map(({id,title,sha256})=>({id,title,sha256}))}}:{}),poster_base64:poster.toString('base64'),
  poster_sha256:manifest.poster.sha256,mime:bundle.report.poster.endsWith('.png')?'image/png':'image/jpeg',
  ...(bundle.report.revision_notice?{revision_notice:{revision:bundle.report.revision,...bundle.report.revision_notice}}:{})};
}
export async function verifyScheduledDelivery(input,fetcher=fetch,cache){
 const bundle=await decodeInput(input);
 const proof=await verifyReportPublication(input.report_commit,bundle,fetcher,cache);
 requireThat(!bundle.report.revision_notice||proof.url===`https://sfcloud-ai.github.io/ai-infra-reports/${bundle.report.date}/`,'Revision notices require verified stable public links');
 return deliveryPlan(bundle,input.report_commit,proof.url===`https://sfcloud-ai.github.io/ai-infra-reports/${bundle.report.date}/`);
}
export async function verifyHistoricalDelivery(input,fetcher=fetch){
 const bundle=await decodeInput(input);
 await verifyImmutableSource(input.report_commit,bundle.report.date,bundle.report.revision,bundle.files,fetcher);
 return {purpose:'historical_daily_claims_only',delivery_allowed:false,plan:deliveryPlan(bundle,input.report_commit)};
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href&&process.argv[2]==='--serve'){
 // One trusted local pipe, one request at a time. The opaque source cache stays
 // in this verifier process; no caller can inject or deserialize cached proof.
 const cache=createPublicationSourceCache();
 for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
  try{
   requireThat(Buffer.byteLength(line)<=12*1024*1024,'Bounded request required');
   const result=await verifyScheduledDelivery(JSON.parse(line),fetch,cache);
   process.stdout.write(JSON.stringify({ok:true,result})+'\n');
  }catch{process.stdout.write(JSON.stringify({ok:false,error:'publication_not_verified'})+'\n');}
 }
}else if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 try{
  let size=0;const chunks=[];
  for await(const chunk of process.stdin){size+=chunk.length;requireThat(size<=12*1024*1024,'Bounded request required');chunks.push(chunk);}
  const input=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));
  requireThat(process.argv.length===2||(process.argv.length===3&&process.argv[2]==='--history'),'Fixed verification mode required');
  console.log(JSON.stringify(process.argv[2]==='--history'?await verifyHistoricalDelivery(input):await verifyScheduledDelivery(input,fetch,createPublicationSourceCache())));
 }catch{console.error('Scheduled publication verification failed');process.exitCode=1;}
}
