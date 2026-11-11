import {DatabaseSync} from "node:sqlite";
import {digest} from "./archive.mjs";
import {requireThat} from "./report-handoff.mjs";
import path from 'node:path';
import {withHandoffLock} from './handoff-lock.mjs';
// Operational recovery writers must keep close-time WAL checkpointing inside
// the same exclusive lock used by live ticks and read-only snapshots.
export async function withLockedHandoffState(config,run){
 return withHandoffLock(config.state_dir,async()=>{
  const state=new HandoffState(path.join(config.state_dir,'handoff.sqlite'),handoffScope(config));
  try{return await run(state);}finally{state.close();}
 });
}
export function handoffScope(config){
 const {slack_token_file,producer_key_file,state_dir,notification_destination,notification_not_before,notification_checker,scheduled_delivery,durable_intake,producer_fence,slack_submission,research_archive,...scope}=config;
 return scope;
}
export function scopeDigest(scope){
 const canonical=Object.fromEntries(Object.keys(scope).sort().map(key=>[key,scope[key]]));
 return digest(JSON.stringify(canonical));
}
// The production adapter checks the owner-only directory before opening this database.
export class HandoffState{
 constructor(filename,scope){
  this.db=new DatabaseSync(filename);
  try{
  this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS scope (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, hash TEXT NOT NULL, source_ts TEXT UNIQUE NOT NULL, bytes BLOB NOT NULL, phase TEXT NOT NULL, detail TEXT NOT NULL);");
  const value=scopeDigest(scope);this.db.prepare("INSERT OR IGNORE INTO scope VALUES (1, ?)").run(value);
  requireThat(this.db.prepare("SELECT value FROM scope WHERE id=1").get().value===value,"State identity changed; reconcile first");
  }catch(error){this.db.close();throw error;}
 }
 get(id){const row=this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);return row?{...row,bytes:Buffer.from(row.bytes),detail:JSON.parse(row.detail)}:null;}
 metadata(id){const row=this.db.prepare('SELECT id,hash,source_ts,phase,detail FROM jobs WHERE id=?').get(id);return row?{...row,detail:JSON.parse(row.detail)}:null;}
 pendingMetadata(){return this.db.prepare("SELECT id,hash,source_ts,phase,detail FROM jobs WHERE phase != 'receipt_sent' ORDER BY source_ts").all().map(row=>({...row,detail:JSON.parse(row.detail)}));}
 admit(event,bytes){
  requireThat(digest(bytes)===event.hash,"Transport digest mismatch");
  const prior=this.get(event.request_id);
  if(prior){requireThat(prior.hash===event.hash&&prior.source_ts===event.source_ts,"Request ID reused; reconcile first");return prior;}
  requireThat(this.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n<1000,"State capacity reached; archive with operator approval");
  requireThat(event.file_id===undefined||/^F[A-Z0-9]+$/.test(event.file_id),'Original intake file identity invalid');
  this.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, 'received', ?)").run(event.request_id,event.hash,event.source_ts,bytes,JSON.stringify(event.file_id?{intake_file_id:event.file_id}:{}));
  return this.get(event.request_id);
 }
 move(id,from,to,detail){return this.db.prepare("UPDATE jobs SET phase=?, detail=? WHERE id=? AND phase=?").run(to,JSON.stringify(detail),id,from).changes===1;}
 pending(){return this.db.prepare("SELECT id FROM jobs WHERE phase != 'receipt_sent' ORDER BY source_ts").all().map(r=>r.id);}
 // The ledger is pinned to one app/workspace. Retain method cooldown evidence
 // in original job diagnostics and consult all jobs, including completed ones.
 providerDeadline(scope){
  const deadline=this.db.prepare("SELECT MAX(c.value) AS deadline FROM jobs,json_each(jobs.detail,'$.recovery.cooldowns') AS c WHERE c.key=? AND c.type='integer'").get(scope)?.deadline;
  return Number.isSafeInteger(deadline)&&deadline>0&&deadline<=8640000000000000?deadline:0;
 }
 close(){this.db.close();}
}
