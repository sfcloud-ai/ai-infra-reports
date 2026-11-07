import {requireThat} from './report-handoff.mjs';

export const INTAKE_SCHEMA=Object.freeze({
 "publisher_intake_scan": "CREATE TABLE publisher_intake_scan (\n   id INTEGER PRIMARY KEY CHECK(id=1), scope TEXT NOT NULL, watermark TEXT NOT NULL,\n   upper_bound TEXT, page_cursor TEXT)",
 "publisher_inbox": "CREATE TABLE publisher_inbox (\n   source_ts TEXT PRIMARY KEY, request_id TEXT NOT NULL, file_id TEXT NOT NULL,\n   hash TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,\n   next_at INTEGER NOT NULL DEFAULT 0, last_attempt INTEGER NOT NULL DEFAULT 0, diagnostic TEXT)",
 "publisher_inbox_request": "CREATE INDEX publisher_inbox_request ON publisher_inbox(request_id)"
});
export function installIntakeTables(db){
 for(const sql of Object.values(INTAKE_SCHEMA))db.exec(sql.replace('CREATE TABLE ','CREATE TABLE IF NOT EXISTS ').replace('CREATE INDEX ','CREATE INDEX IF NOT EXISTS '));
}
export function intakeSchemaObjects(db){
 const objects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name IN ('publisher_intake_scan','publisher_inbox') OR name IN ('publisher_intake_scan','publisher_inbox','publisher_inbox_request') ORDER BY name").all();
 if(!objects.length)return objects;
 const expected=[...Object.entries(INTAKE_SCHEMA).map(([name,sql])=>({type:name==='publisher_inbox_request'?'index':'table',name,sql})),{type:'index',name:'sqlite_autoindex_publisher_inbox_1',sql:null}].sort((a,b)=>a.name.localeCompare(b.name));
 requireThat(JSON.stringify(objects)===JSON.stringify(expected),'Unexpected durable intake schema');
 const scans=db.prepare('SELECT * FROM publisher_intake_scan').all();
 requireThat(scans.length===1&&scans[0].id===1&&/^[a-f0-9]{64}$/.test(scans[0].scope),'Incomplete durable intake scope');
 return objects;
}
