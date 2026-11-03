import {requireThat} from './report-handoff.mjs';

export const SCHEDULED_SCHEMA=Object.freeze({
 scheduled_handoffs:'CREATE TABLE scheduled_handoffs (request_id TEXT PRIMARY KEY, binding TEXT NOT NULL, phase TEXT NOT NULL, result TEXT, poll_order INTEGER NOT NULL DEFAULT 0)',
 scheduled_bridge_scope:'CREATE TABLE scheduled_bridge_scope (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)',
 scheduled_status_replies:'CREATE TABLE scheduled_status_replies (source_ts TEXT PRIMARY KEY, hash TEXT NOT NULL, phase TEXT NOT NULL, text TEXT NOT NULL, reply_ts TEXT, poll_order INTEGER NOT NULL DEFAULT 0)'
});
export function installScheduledTables(db,names){
 for(const name of names)db.exec(SCHEDULED_SCHEMA[name].replace('CREATE TABLE ','CREATE TABLE IF NOT EXISTS '));
}
export function scheduledSchemaObjects(db){
 const objects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name IN ('scheduled_handoffs','scheduled_bridge_scope','scheduled_status_replies') ORDER BY name").all();
 requireThat(objects.every(o=>o.type==='table'&&SCHEDULED_SCHEMA[o.name]===o.sql),'Unexpected scheduled delivery schema');
 const names=new Set(objects.map(o=>o.name));
 requireThat(names.has('scheduled_handoffs')===names.has('scheduled_bridge_scope'),'Incomplete scheduled delivery schema');
 return objects;
}
