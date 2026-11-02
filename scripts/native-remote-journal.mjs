// Command/receipt adapter only. The existing native Slack transport carries these
// bytes; it must never repeat an ambiguous upload/share. No disk or credentials.
import {randomUUID} from 'node:crypto';
import {digest} from './archive.mjs';
import {requireThat} from './report-handoff.mjs';
import {freshNativeCommand,readNativeReceipt} from './native-notice.mjs';
import {JOURNAL_FIELDS} from './remote-native-journal.mjs';
export class NativeRemoteJournal{
 #executor=randomUUID();#pending=new Map();
 constructor(config,{report_request_id,bundle_sha256,attempt_id,file_id}){
  this.config=Object.freeze({...config});this.binding=Object.freeze({report_request_id,bundle_sha256,attempt_id,file_id});
 }
 command(action,fields={}){
  requireThat(Object.hasOwn(JOURNAL_FIELDS,action),'Unsupported remote journal command');
  requireThat(!Object.keys(fields).some(k=>Object.hasOwn(this.binding,k)||['action','command_id','executor_id','schema_version'].includes(k)),'Journal identity cannot be overridden');
  const bytes=freshNativeCommand(action,{...this.binding,...fields,...(['journal_intent','journal_settle'].includes(action)?{executor_id:this.#executor}:{})});
  if(action==='journal_intent')this.#pending.set(digest(bytes),JSON.parse(bytes));
  return bytes;
 }
 read(invocation,{bytes,sourceTs}){
  const c=JSON.parse(bytes),r=readNativeReceipt(invocation,{bytes,sourceTs,config:this.config});
  requireThat(Object.hasOwn(JOURNAL_FIELDS,c.action)&&Object.entries(this.binding).every(([k,v])=>c[k]===v)&&r.send_authorized===false&&typeof r.new_intent==='boolean','Journal receipt cannot grant delivery');
  if(r.journal){
   const j=r.journal,b=j.binding;
   requireThat(j.report_id===c.report_request_id&&b.report_id===c.report_request_id&&b.bundle_sha256===c.bundle_sha256&&b.attempt_id===c.attempt_id&&b.file_id===c.file_id&&b.destination===this.config.notification_destination&&j.binding_sha256===digest(Buffer.from(JSON.stringify(b)))&&Number.isSafeInteger(j.revision)&&j.revision>0&&Array.isArray(j.operations)&&j.operations.length<=3,'Remote journal binding differs');
  }
  return r;
 }
 async executeOnce(invocation,options,write){
  const hash=digest(options.bytes),c=this.#pending.get(hash),r=this.read(invocation,options);
  requireThat(c&&c.executor_id===this.#executor&&r.reason==='journal_new_intent'&&r.new_intent===true,'A restart or existing intent is reconciliation-only');
  const op=r.journal?.operations.find(o=>o.operation===c.operation);
  requireThat(op?.phase==='intent'&&op.intent_command_id===c.command_id&&op.executor_id===this.#executor&&op.input_sha256===c.input_sha256,'Receipt does not acknowledge this live operation intent');
  // Consume before invoking, including when write throws or the reply is lost.
  this.#pending.delete(hash);
  return await write();
 }
}
