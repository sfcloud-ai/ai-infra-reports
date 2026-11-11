// Synthetic provider plus real child process / original SQLite host ledger.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {HandoffState,handoffScope} from '../../scripts/handoff-state.mjs';
import {executeResearchControl} from '../../scripts/research-control.mjs';
import {nativeResearchAuthority} from '../../scripts/research-control-client.mjs';
import {stageFile} from '../../scripts/slack-stage-cli.mjs';
import {storeResearchArchive} from '../../scripts/research-archive.mjs';
import {PRODUCER_TOOLS,producerTicket} from '../../scripts/producer-upload.mjs';
import {digest} from '../../scripts/archive.mjs';
const [file,mode]=process.argv.slice(2),f=JSON.parse(await readFile(file,'utf8')),bytes=Buffer.from(f.base64,'base64'),hash=digest(bytes),state=new HandoffState(f.database,handoffScope(f.config));
const authority=nativeResearchAuthority({request_id:f.id,owner_id:f.owner,archive_sha256:hash},async bytes=>executeResearchControl(state.db,f.config,bytes,f.now),()=>f.now);
const after=authority.after;authority.after=async(...args)=>{await after(...args);if(args[0]==='post'&&mode==='exit-after-post')process.exit(77);};
const ticket={file_id:'FORIGINAL',upload_url:'https://files.slack.com/upload/v1/synthetic-test-only'};
try{
 const result=await stageFile(bytes,f.config.channel_id,async(tool,args)=>{
  if(tool===PRODUCER_TOOLS.ticket){assert.equal(mode,'exit-after-post');return ticket;}
  assert.equal(mode,'resume');assert.equal(args.file_id,'FORIGINAL');
  state.db.exec('BEGIN IMMEDIATE');storeResearchArchive(state.db,{request_id:f.id,hash,source_ts:'1793491203.000001',file_id:ticket.file_id},bytes);state.db.exec('COMMIT');return {};
 },{authority,research:true,upload:async()=>{assert.equal(mode,'exit-after-post');return {adapter:'producer_curl_managed_proxy_v1',file_id:ticket.file_id,url_sha256:producerTicket(ticket).url_sha256,bundle_sha256:hash,metrics:{curl_exit:0,http_status:200,upload_bytes:bytes.length,num_redirects:0,ssl_verify_result:0}};}});
 console.log(JSON.stringify(result));
}finally{state.close();}
