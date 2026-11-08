// Startup preflight must not let SQLite repair, create or checkpoint the original
// journal. Read a stable private snapshot (including WAL), validate it read-only,
// then discard it. The snapshot can never be used for dispatch or recovery.
import {DatabaseSync} from 'node:sqlite';
import {constants,createWriteStream} from 'node:fs';
import {lstat,stat,realpath,open,mkdtemp,rm} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pipeline} from 'node:stream/promises';
import {PRODUCER_SCHEMA,RECOVERY_SCHEMA,RESTART_SCHEMA,RESTART_RECOVERY_POLICY,producerScopeHash} from './producer-upload.mjs';
import {INSPECT_SCHEMA,producerInspectScopeHash} from './producer-native-inspect.mjs';
import {requireThat} from './report-handoff.mjs';
function check(v,code){if(!v){const e=new Error(code);e.code=code;throw e;}}
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const privateFile=s=>s.isFile()&&!s.isSymbolicLink()&&s.uid===BigInt(process.getuid())&&(s.mode&0o077n)===0n&&s.nlink===1n;
const maybe=async path=>{try{return await lstat(path,{bigint:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}};
export async function journalPath(filename,inputs=[]){
 const parent=dirname(filename),dir=await lstat(parent);
 requireThat(dir.isDirectory()&&!dir.isSymbolicLink()&&(dir.mode&0o077)===0&&dir.uid===process.getuid()&&await realpath(parent)===parent,'Owner-only original journal directory required');
 const s=await maybe(filename);
 if(s){
  requireThat(privateFile(s),'Private single-link original journal required');
  for(const path of inputs){let other;try{other=await stat(path,{bigint:true});}catch(e){if(e.code!=='ENOENT')throw e;}requireThat(!other||s.dev!==other.dev||s.ino!==other.ino,'Dedicated journal must not alias an original input');}
 }
 if(!s)for(const suffix of ['-wal','-shm','-journal'])requireThat(await maybe(filename+suffix)===null,'Missing original journal with leftover sidecars; never rebuild');
 return s;
}
export async function verifyProducerJournal(filename,scope,nativeConfig){
 // Validate config before making even a temporary snapshot.
 const scopeHash=producerScopeHash(scope),inspectHash=nativeConfig?producerInspectScopeHash(nativeConfig):null;
 const expected={...PRODUCER_SCHEMA,...(nativeConfig?INSPECT_SCHEMA:{})},paths=[filename,filename+'-wal',filename+'-shm',filename+'-journal'];
 const original=await Promise.all(paths.map(maybe));
 requireThat(original[0]&&original[0].size>0n&&original[3]===null,'Initialized original journal required; no empty file or rollback recovery');
 original.forEach(s=>requireThat(!s||privateFile(s),'Private single-link journal sidecars required'));
 const assertUnchanged=async()=>{const current=await Promise.all(paths.map(maybe));requireThat(current.every((s,i)=>s===null?original[i]===null:original[i]!==null&&privateFile(s)&&same(s,original[i])),'Original journal changed during preflight');};
 const directory=await mkdtemp(join(tmpdir(),'producer-readonly-check-')),snapshot=join(directory,'state.sqlite');
 let db;
 try{
  for(const i of [0,1])if(original[i]){
   const file=await open(paths[i],constants.O_RDONLY|constants.O_NOFOLLOW);
   try{
    requireThat(same(await file.stat({bigint:true}),original[i]),'Original journal inode changed');
    await pipeline(file.createReadStream({autoClose:false}),createWriteStream(snapshot+(i===1?'-wal':''),{flags:'wx',mode:0o600}));
    requireThat(same(await file.stat({bigint:true}),original[i]),'Original journal changed while reading');
   }finally{await file.close();}
  }
  await assertUnchanged();
  db=new DatabaseSync(snapshot,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
  const rows=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE substr(name,1,7)!='sqlite_' ORDER BY name").all();
  const recovery=rows.some(r=>r.name==='producer_recovery_audit');
  const restart=rows.some(r=>r.name==='producer_restart_policy');
  const schema={...expected,...(recovery?RECOVERY_SCHEMA:{}),...(restart?RESTART_SCHEMA:{})};
  check(rows.length===Object.keys(schema).length&&rows.every(r=>r.sql===schema[r.name]),'producer_journal_schema_incompatible');
  requireThat(db.prepare('PRAGMA integrity_check').all().every(r=>r.integrity_check==='ok'),'Original journal integrity required');
  for(const [table,hash] of [['producer_scope',scopeHash],...(nativeConfig?[['producer_inspect_scope',inspectHash]]:[])]){
   const bound=db.prepare(`SELECT id,hash FROM ${table}`).all();check(bound.length===1&&bound[0].id===1&&bound[0].hash===hash,'producer_journal_scope_mismatch');
  }
  if(nativeConfig){
   const rows=db.prepare('SELECT operation_id,query_id FROM producer_inspect_queries').all();
   check(rows.every(r=>r.query_id===r.operation_id&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.query_id)),'producer_journal_schema_incompatible');
  }
  if(restart){
   const policies=db.prepare('SELECT * FROM producer_restart_policy').all();
   check(!!nativeConfig&&policies.length===1&&policies[0].id===1&&policies[0].policy===RESTART_RECOVERY_POLICY&&policies[0].scope_hash===scopeHash,'producer_journal_scope_mismatch');
   assertUnchanged.restartPolicy={...policies[0]};
  }
  await assertUnchanged();
  return assertUnchanged;
 }finally{db?.close();await rm(directory,{recursive:true,force:true});}
}
