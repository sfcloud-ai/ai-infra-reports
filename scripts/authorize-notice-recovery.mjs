// One explicit local operator authorization. Not a Slack command, daemon or timer.
// Run only after verifying the fence output came from the ORIGINAL cloud journal
// and its former process has stopped. No journal is transferred to this machine.
import {readFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {HandoffState,handoffScope} from './handoff-state.mjs';
import {NoticeOutbox,notificationScope} from './notice-outbox.mjs';
import {authorizeNoticeRecovery} from './notice-recovery.mjs';
import {validateConfig} from './run-handoff.mjs';
import {decodeBundle,verifyReportPublication,requireThat} from './report-handoff.mjs';
let state,relay;
try{
 const [configFile,fenceFile,reference,confirmation]=process.argv.slice(2);
 requireThat(process.argv.length===6&&process.getuid?.()===0&&confirmation==='--confirm-original-journal-fenced-and-owner-stopped','Explicit local operator confirmation required');
 requireThat(typeof reference==='string'&&reference.length>0&&reference.length<=500,'Authorization reference required');
 const config=validateConfig(JSON.parse(await readFile(configFile,'utf8'))),fence=JSON.parse(await readFile(fenceFile,'utf8'));
 requireThat(fence.type==='fenced','Use the successful fence result from the original sender, never a plan');
 const plan={binding:fence.binding,binding_sha256:fence.binding_sha256};
 const filename=path.join(config.state_dir,'handoff.sqlite'),owner=await lstat(filename);
 requireThat(owner.isFile()&&!owner.isSymbolicLink()&&owner.uid!==0,'Existing dedicated Publisher state required');
 const source=new DatabaseSync(filename,{readOnly:true});let job;
 try{job=source.prepare('SELECT * FROM jobs WHERE id=?').get(plan.binding.report_id);}finally{source.close();}
 requireThat(job,'Original Publisher report missing');job.detail=JSON.parse(job.detail);
 const bundle=await decodeBundle(Buffer.from(job.bytes));
 requireThat(bundle.hash===plan.binding.bundle_sha256&&job.detail.commit===plan.binding.report_commit,'Recovery report binding changed');
 const stage=JSON.parse(await readFile('/etc/ai-brief-stage.json','utf8'));
 requireThat(path.isAbsolute(stage.live.relay_root),'Installed relay path required');
 const relayPath=path.join(stage.live.relay_root,'state/state.sqlite3');
 requireThat(await realpath(relayPath)===relayPath,'Installed relay ledger must not be redirected');
 relay=new DatabaseSync(relayPath,{readOnly:true});relay.exec('PRAGMA query_only=ON');
 const since=Date.parse(bundle.report.date+'T00:00:00+08:00')/1000;
 const count=()=>relay.prepare('SELECT count(*) n FROM requests WHERE created>=?').get(since).n;
 requireThat(count()===0,'A relay request already exists today; recovery needs reconciliation');
 const proof=await verifyReportPublication(job.detail.commit,bundle);
 requireThat(proof.publication_status==='verified'&&count()===0,'Publication or relay state changed');
 relay.close();relay=undefined;
 // Preserve service ownership of SQLite WAL/SHM and any newly created tables.
 process.setgid(owner.gid);process.setuid(owner.uid);
 state=new HandoffState(filename,handoffScope(config));const outbox=new NoticeOutbox(state,notificationScope(config));
 authorizeNoticeRecovery(outbox,plan,{reference,checked_at:Date.now(),relay_requests:0,publisher_verified:true});
 console.log(JSON.stringify({status:'approved',report_id:plan.binding.report_id,recovery_id:plan.binding.recovery_id,fence_sha256:plan.binding_sha256,messages_sent:0}));
}catch(e){console.error('Recovery authorization stopped: '+e.message);process.exitCode=1;}finally{relay?.close();state?.close();}
