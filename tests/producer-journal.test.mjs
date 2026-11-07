import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,readdir,chmod,link,symlink,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {ProducerUploadState} from '../scripts/producer-upload.mjs';
import {ProducerInspect} from '../scripts/producer-native-inspect.mjs';
import {encodeBundle} from '../scripts/report-handoff.mjs';
import {FILES,BASE,PROMPTS,ID} from './helpers/cloud-sender-fixture.mjs';
const scope={team_id:'T123',channel_id:'C123',sender_user_id:'U123',sender_user_app_id:'A123',sender_attribution_text:'*Sent using* <@U789>',publisher_scope_sha256:'a'.repeat(64),scheduler_scope_sha256:'b'.repeat(64),scheduler_team_id:'T123',scheduler_channel_id:'D123'};
const inspect={publisher_user_id:'U456',publisher_bot_id:'B456',workspace_host:'fixture-workspace.slack.com'};
const bytes=await encodeBundle(FILES,ID,BASE,PROMPTS.commit);
const run=(config,mode='--serve',input='{"type":"close"}\n')=>spawnSync(process.execPath,['scripts/producer-upload-cli.mjs',config,mode],{input,encoding:'utf8'});
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'producer-initialize-')),path=join(dir,'config.json'),config={state_file:join(dir,'state.sqlite'),bundle_file:join(dir,'bundle.json'),scope,native_inspect:inspect};try{await writeFile(path,JSON.stringify(config),{mode:0o600});await fn({dir,path,config});}finally{await rm(dir,{recursive:true,force:true});}}
async function contents(dir){const entries=[];for(const name of (await readdir(dir)).sort()){const file=join(dir,name),s=await lstat(file);entries.push([name,s.mode,s.ino,s.nlink,s.isSymbolicLink()?'symlink':s.isFile()?(await readFile(file)).toString('hex'):'directory']);}return entries;}
async function rejectedUnchanged(dir,path){const before=await contents(dir),r=run(path);assert.equal(r.status,1,r.stdout+r.stderr);assert(!r.stdout.includes('"type":"ready"'));assert(!r.stdout.includes('"type":"write"'));assert.deepEqual(await contents(dir),before);return r;}

test('offline initialize binds both empty schemas without reading the future bundle',()=>fixture(async({dir,path,config})=>{
 const init=run(path,'--initialize');assert.equal(init.status,0,init.stdout+init.stderr);assert.deepEqual(JSON.parse(init.stdout),{type:'initialized',protocol:'producer_upload_v1',write_allowed:false});
 await assert.rejects(lstat(config.bundle_file),e=>e.code==='ENOENT');
 const db=new DatabaseSync(config.state_file,{readOnly:true});try{for(const table of ['producer_runs','producer_ops','producer_inspect_queries'])assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);for(const table of ['producer_scope','producer_inspect_scope'])assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,1);}finally{db.close();}
 assert.equal((await lstat(config.state_file)).mode&0o777,0o600);
 const before=await contents(dir);assert.equal(run(path,'--initialize').status,1);assert.deepEqual(await contents(dir),before);
 await writeFile(config.bundle_file,bytes);const served=run(path);assert.equal(served.status,0,served.stdout+served.stderr);assert.equal(JSON.parse(served.stdout).request_id,ID);assert.equal(JSON.parse(served.stdout).operations.length,0);
}));
test('offline local-mode setup does not open or require the original ledgers or bundle',()=>fixture(async({path,config})=>{
 const {native_inspect,...c}=config;await writeFile(path,JSON.stringify({...c,publisher_database:join(config.state_file+'-missing','publisher.db'),scheduler_database:join(config.state_file+'-missing','scheduler.db')}));assert.equal(run(path,'--initialize').status,0);
}));
test('missing, empty, empty SQLite and non-SQLite journals fail without changes or sidecar creation',async()=>{
 for(const setup of [async()=>{},async c=>writeFile(c.state_file,'',{mode:0o600}),async c=>{const d=new DatabaseSync(c.state_file);d.exec('PRAGMA user_version=1');d.close();await chmod(c.state_file,0o600);},async c=>writeFile(c.state_file,'not a sqlite database',{mode:0o600})])await fixture(async({dir,path,config})=>{await setup(config);await writeFile(config.bundle_file,bytes);await rejectedUnchanged(dir,path);});
});
test('wrong Producer or native scope refuses original bytes before mutable constructors',async()=>{
 for(const edit of [c=>c.scope={...scope,sender_user_id:'UOTHER'},c=>c.native_inspect={...inspect,publisher_user_id:'UOTHER'}])await fixture(async({dir,path,config})=>{assert.equal(run(path,'--initialize').status,0);edit(config);await writeFile(path,JSON.stringify(config));await writeFile(config.bundle_file,bytes);await rejectedUnchanged(dir,path);});
});
test('missing tables, missing scope rows, altered constraints and extra triggers never auto-repair',async()=>{
 for(const sql of ['DROP TABLE producer_ops','DELETE FROM producer_scope','DROP TABLE producer_inspect_queries','DELETE FROM producer_inspect_scope','DROP TABLE producer_ops; CREATE TABLE producer_ops(run_id TEXT,name TEXT,attempt INTEGER,operation_id TEXT,phase TEXT,at INTEGER,result TEXT)','CREATE TRIGGER unexpected AFTER INSERT ON producer_runs BEGIN DELETE FROM producer_ops; END','CREATE TABLE sqliteXforeign(secret TEXT)'])await fixture(async({dir,path,config})=>{assert.equal(run(path,'--initialize').status,0);const d=new DatabaseSync(config.state_file);d.exec(sql);d.close();await writeFile(config.bundle_file,bytes);await rejectedUnchanged(dir,path);});
});
test('pre-nonce journal schema is refused rather than migrated or assigned fake nonces',()=>fixture(async({dir,path,config})=>{
 const state=new ProducerUploadState(config.state_file,scope);new ProducerInspect(state,inspect);state.db.exec('DROP TABLE producer_inspect_queries; CREATE TABLE producer_inspect_queries(run_id TEXT NOT NULL,attempt INTEGER NOT NULL,operation_id TEXT UNIQUE NOT NULL,started_at INTEGER NOT NULL,after_ts TEXT NOT NULL,source_ts TEXT UNIQUE,receipt_ts TEXT,receipt_hash TEXT,phase TEXT NOT NULL,PRIMARY KEY(run_id,attempt))');state.close();await chmod(config.state_file,0o600);await writeFile(config.bundle_file,bytes);assert.equal(JSON.parse((await rejectedUnchanged(dir,path)).stdout).reason,'producer_journal_schema_incompatible');
}));
test('WAL-only schema damage is seen without checkpointing or changing original WAL/SHM bytes',()=>fixture(async({dir,path,config})=>{
 assert.equal(run(path,'--initialize').status,0);await writeFile(config.bundle_file,bytes);const live=new DatabaseSync(config.state_file);try{live.exec('PRAGMA wal_autocheckpoint=0; DROP TABLE producer_ops');await rejectedUnchanged(dir,path);}finally{live.close();}
}));
test('valid original WAL preserves unknown inspect intents across CLI restart',()=>fixture(async({path,config})=>{
 assert.equal(run(path,'--initialize').status,0);await writeFile(config.bundle_file,bytes);const state=new ProducerUploadState(config.state_file,scope);try{await state.prepare(bytes);const i=new ProducerInspect(state,inspect),action=i.next(ID);const r=run(path,'--serve','{"type":"tick"}\n{"type":"close"}\n');assert.equal(r.status,0,r.stdout+r.stderr);const output=r.stdout.trim().split('\n').map(JSON.parse);assert.equal(output[1].type,'read');assert.equal(output[1].operation_id,action.operation_id);assert.equal(i.query(ID).attempt,1);}finally{state.close();}
}));
test('private mode, symlink, hardlink and input alias gates reject without changing journal',async()=>{
 for(const setup of [async c=>chmod(c.state_file,0o644),async c=>{await link(c.state_file,c.state_file+'.alias');},async c=>{await rm(c.bundle_file);await symlink(c.state_file,c.bundle_file);},async c=>{await link(c.state_file,c.state_file+'.original');await rm(c.state_file);await symlink(c.state_file+'.original',c.state_file); }])await fixture(async({dir,path,config})=>{assert.equal(run(path,'--initialize').status,0);await writeFile(config.bundle_file,bytes);await setup(config);await rejectedUnchanged(dir,path);});
});
test('initialization refuses leftover journal sidecars and invalid scope before creation',async()=>{
 for(const setup of [async c=>writeFile(c.state_file+'-wal','unrelated',{mode:0o600}),async(c,path)=>{c.native_inspect={...inspect,publisher_user_id:'wrong'};await writeFile(path,JSON.stringify(c));}])await fixture(async({dir,path,config})=>{await setup(config,path);const before=await contents(dir);assert.equal(run(path,'--initialize').status,1);assert.deepEqual(await contents(dir),before);});
});
