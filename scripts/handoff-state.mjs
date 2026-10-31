import {DatabaseSync} from "node:sqlite";
import {digest} from "./archive.mjs";
import {requireThat} from "./report-handoff.mjs";
// The production adapter checks the owner-only directory before opening this database.
export class HandoffState{
 constructor(filename,scope){
  this.db=new DatabaseSync(filename);
  try{
  this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS scope (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, hash TEXT NOT NULL, source_ts TEXT UNIQUE NOT NULL, bytes BLOB NOT NULL, phase TEXT NOT NULL, detail TEXT NOT NULL);");
  const canonical=Object.fromEntries(Object.keys(scope).sort().map(key=>[key,scope[key]]));
  const value=digest(JSON.stringify(canonical));this.db.prepare("INSERT OR IGNORE INTO scope VALUES (1, ?)").run(value);
  requireThat(this.db.prepare("SELECT value FROM scope WHERE id=1").get().value===value,"State identity changed; reconcile first");
  }catch(error){this.db.close();throw error;}
 }
 get(id){const row=this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);return row?{...row,bytes:Buffer.from(row.bytes),detail:JSON.parse(row.detail)}:null;}
 admit(event,bytes){
  requireThat(digest(bytes)===event.hash,"Transport digest mismatch");
  const prior=this.get(event.request_id);
  if(prior){requireThat(prior.hash===event.hash&&prior.source_ts===event.source_ts,"Request ID reused; reconcile first");return prior;}
  requireThat(this.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n<1000,"State capacity reached; archive with operator approval");
  this.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, 'received', '{}')").run(event.request_id,event.hash,event.source_ts,bytes);
  return this.get(event.request_id);
 }
 move(id,from,to,detail){return this.db.prepare("UPDATE jobs SET phase=?, detail=? WHERE id=? AND phase=?").run(to,JSON.stringify(detail),id,from).changes===1;}
 pending(){return this.db.prepare("SELECT id FROM jobs WHERE phase != 'receipt_sent' ORDER BY source_ts").all().map(r=>r.id);}
 close(){this.db.close();}
}
