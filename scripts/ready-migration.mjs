// Stage a copy only. Never change the active config, source DB, service or keys.
import {DatabaseSync,backup} from "node:sqlite";
import {createHash} from "node:crypto";
import {mkdir,open,lstat,realpath} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {scopeDigest,handoffScope} from "./handoff-state.mjs";
import {requireThat} from "./report-handoff.mjs";
import {validateConfig,privateFile,privateDirectory} from "./run-handoff.mjs";
const known=new Set(["scope","jobs","notice_scope","notices","notice_commands","ready_migrations"]);
function inspect(db){
 requireThat(db.prepare("PRAGMA integrity_check").get().integrity_check==="ok","State integrity failed");
 const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
 requireThat(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type IN ('trigger','view')").get().n===0,"Unexpected state triggers/views");
 requireThat(tables.every(t=>known.has(t.name))&&tables.some(t=>t.name==="jobs")&&tables.some(t=>t.name==="scope"),"Unknown state schema");
 requireThat(db.prepare("SELECT count(*) AS n FROM jobs WHERE phase!='receipt_sent'").get().n===0,"Pending report state prevents migration");
 if(tables.some(t=>t.name==="notices"))requireThat(db.prepare("SELECT count(*) AS n FROM notices WHERE phase!='sender_reported'").get().n===0,"Unresolved notification prevents migration");
 if(tables.some(t=>t.name==="notice_commands"))requireThat(db.prepare("SELECT count(*) AS n FROM notice_commands WHERE phase!='response_sent'").get().n===0,"Unresolved control receipt prevents migration");
 const hash=createHash("sha256");
 for(const t of tables.filter(t=>!["scope","ready_migrations"].includes(t.name))){
  hash.update(JSON.stringify([t.name,t.sql])+"\n");
  const columns=db.prepare(`PRAGMA table_info(${t.name})`).all();
  requireThat(columns.every(c=>/^[a-z_]+$/.test(c.name)),"Unexpected state column name");
  const primary=columns.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
  requireThat(primary.length>0,"State tables require a stable primary key");
  for(const row of db.prepare(`SELECT * FROM ${t.name} ORDER BY ${primary.join(",")}`).iterate()){
   hash.update(JSON.stringify(Object.fromEntries(columns.map(c=>[c.name,row[c.name] instanceof Uint8Array?{base64:Buffer.from(row[c.name]).toString("base64")}:row[c.name]])))+"\n");
  }
 }
 const scope=db.prepare("SELECT value FROM scope WHERE id=1").get()?.value;
 requireThat(typeof scope==="string"&&/^[a-f0-9]{64}$/.test(scope),"Missing source scope");
 return {data_sha256:hash.digest("hex"),scope,jobs:db.prepare("SELECT count(*) AS n FROM jobs").get().n};
}
function configurations(before,after){
 validateConfig(before);validateConfig(after);
 const {state_dir:oldDir,ready_for_review:oldReady,...a}=before;
 const {state_dir:newDir,ready_for_review:newReady,...b}=after;
 requireThat(oldDir!==newDir&&path.resolve(oldDir)!==path.resolve(newDir)&&oldReady!==newReady&&scopeDigest(a)===scopeDigest(b),"Only readiness and a new state directory may change");
 return {source:path.join(oldDir,"handoff.sqlite"),target:path.join(newDir,"handoff.sqlite"),oldScope:scopeDigest(handoffScope(before)),newScope:scopeDigest(handoffScope(after))};
}
async function sourceSnapshot(before,after){
 const paths=configurations(before,after),dir=path.dirname(paths.source);
 if(process.platform==="linux"){await privateDirectory(dir);await privateFile(paths.source,10*1024*1024*1024,false);}
 else requireThat(await realpath(dir)===path.resolve(dir)&&!(await lstat(paths.source)).isSymbolicLink(),"Source state path must not be symlinked");
 const db=new DatabaseSync(paths.source,{readOnly:true});
 try{db.exec("BEGIN");const value=inspect(db);requireThat(value.scope===paths.oldScope,"Source config binding differs");return {...paths,...value};}finally{db.close();}
}
export async function planReadyMigration(before,after){return {...await sourceSnapshot(before,after),mode:"plan",source_modified:false,activated:false};}
export async function stageReadyMigration(before,after,expected){
 const plan=await sourceSnapshot(before,after);
 requireThat(expected===plan.data_sha256,"Source data changed since reviewed plan");
 const targetDir=path.dirname(plan.target),parent=path.dirname(targetDir);
 requireThat(await realpath(parent)===path.resolve(parent),"Target parent must not be symlinked");
 // An existing target is never replaced or cleaned up, even after a failed attempt.
 await mkdir(targetDir,{mode:0o700});
 const file=await open(plan.target,"wx",0o600);await file.close();
 const source=new DatabaseSync(plan.source,{readOnly:true});
 try{await backup(source,plan.target);}finally{source.close();}
 const fresh=await sourceSnapshot(before,after);
 requireThat(fresh.data_sha256===plan.data_sha256&&fresh.scope===plan.scope,"Source changed during copy; staged target must not be activated");
 const target=new DatabaseSync(plan.target);
 try{
  target.exec("BEGIN IMMEDIATE");const copied=inspect(target);
  requireThat(copied.data_sha256===plan.data_sha256&&copied.scope===plan.oldScope,"Staged copy differs");
  target.prepare("UPDATE scope SET value=? WHERE id=1 AND value=?").run(plan.newScope,plan.oldScope);
  target.exec("CREATE TABLE IF NOT EXISTS ready_migrations (source_scope TEXT NOT NULL, target_scope TEXT NOT NULL, data_sha256 TEXT NOT NULL, created_at TEXT NOT NULL)");
  target.prepare("INSERT INTO ready_migrations VALUES (?,?,?,?)").run(plan.oldScope,plan.newScope,plan.data_sha256,new Date().toISOString());
  const verified=inspect(target);requireThat(verified.scope===plan.newScope&&verified.data_sha256===plan.data_sha256,"Migration changed stored data");
  target.exec("COMMIT");
 }catch(e){try{target.exec("ROLLBACK");}catch{}throw e;}finally{target.close();}
 return {...plan,mode:"staged",new_scope:plan.newScope,source_modified:false,activated:false};
}
export async function verifyReadyMigration(before,after,expected){
 const source=await sourceSnapshot(before,after);requireThat(source.data_sha256===expected,"Original state moved after staging");
 if(process.platform==="linux"){await privateDirectory(path.dirname(source.target));await privateFile(source.target,10*1024*1024*1024,false);}
 const db=new DatabaseSync(source.target,{readOnly:true});
 try{
  const target=inspect(db);
  requireThat(target.scope===source.newScope&&target.data_sha256===expected,"Staged state identity/data differs");
  const record=db.prepare("SELECT * FROM ready_migrations ORDER BY rowid DESC LIMIT 1").get();
  requireThat(record?.source_scope===source.oldScope&&record.target_scope===source.newScope&&record.data_sha256===expected,"Migration audit missing");
  return {verified:true,data_sha256:expected,jobs:target.jobs,activated:false};
 }finally{db.close();}
}
if(import.meta.url===pathToFileURL(process.argv[1]||"").href){
 try{
  requireThat(process.platform==="linux","Operational migration requires Linux private-file checks");
  const [mode,oldFile,newFile,expected,...extra]=process.argv.slice(2);
  requireThat(["plan","stage","verify"].includes(mode)&&oldFile&&newFile&&!extra.length&&(mode==="plan"?!expected:/^[a-f0-9]{64}$/.test(expected)),"Usage: ready-migration.mjs plan|stage|verify OLD_CONFIG NEW_CONFIG [REVIEWED_DATA_SHA256]");
  const before=JSON.parse(await privateFile(oldFile,16384)),after=JSON.parse(await privateFile(newFile,16384));
  const result=mode==="plan"?await planReadyMigration(before,after):mode==="stage"?await stageReadyMigration(before,after,expected):await verifyReadyMigration(before,after,expected);
  console.log(JSON.stringify(result));
 }catch{console.error("Readiness migration stopped. Keep the original service/config; inspect any staged copy before another attempt.");process.exitCode=1;}
}
