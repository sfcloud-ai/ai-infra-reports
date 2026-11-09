import test from 'node:test';
import assert from 'node:assert/strict';
import {ProducerUploadState,producerTicket} from '../scripts/producer-upload.mjs';
import {installProducerAdmissionPolicy,installT4DirectTransportPolicy} from '../scripts/producer-local-admission.mjs';
import {curlUploadPlan,producerCurlEnvironment} from '../scripts/producer-upload-adapters.mjs';
const scope={team_id:'T123',channel_id:'C123',sender_user_id:'U123',sender_user_app_id:'A123',sender_attribution_text:'*Sent by* <@U123>',publisher_scope_sha256:'a'.repeat(64),scheduler_scope_sha256:'b'.repeat(64),scheduler_team_id:'T123',scheduler_channel_id:'D123'};
const config={producer_fence:{generation:'a1111111-1111-4111-8111-111111111111',installation:{journal_device:'1',journal_inode:'2',lock_device:'1',lock_inode:'3'}}};
test('T4 direct TLS requires separate persisted authorization on new admitted installation',()=>{
 const p=new ProducerUploadState(':memory:',scope);try{
  assert.throws(()=>installT4DirectTransportPolicy(p,'approved'),/admission/);
  installProducerAdmissionPolicy(p,'/synthetic/publisher-config.json',config);
  assert.throws(()=>installT4DirectTransportPolicy(p,''),/authorization/);
  installT4DirectTransportPolicy(p,'synthetic-user-approval-t4-direct');
  assert.deepEqual({...p.db.prepare('SELECT * FROM producer_transport_policy').get()},{id:1,transport:'t4_direct_tls_v1',authorization_reference:'synthetic-user-approval-t4-direct'});
  assert.throws(()=>installT4DirectTransportPolicy(p,'again'),/reinstall/);
 }finally{p.close();}
});
test('approved direct upload preserves TLS, original host, no redirects and no curl retries',()=>{
 const url='https://files.slack.com/upload/v1/SYNTHETIC',plan=curlUploadPlan({url,input:'/tmp/input',output:'/tmp/output',size:1,transport:'direct'});
 for(const [flag,value] of [['--proto','=https'],['--proto-redir','=https'],['--max-redirs','0'],['--retry','0'],['--noproxy','*']])assert.equal(plan.args[plan.args.indexOf(flag)+1],value);
 assert(!plan.args.includes('--insecure'));assert(!plan.args.includes('-k'));assert(!plan.args.includes('-L'));assert(!plan.args.some(x=>x.includes('SYNTHETIC')));
 assert.deepEqual(producerCurlEnvironment('direct',{PATH:'/usr/bin',HTTPS_PROXY:'http://secret.invalid',SSL_CERT_FILE:'/bad'}),{PATH:'/usr/bin',LANG:'C'});
 for(const bad of ['http://files.slack.com/upload/v1/a','https://evil.invalid/upload/v1/a','https://files.slack.com:444/upload/v1/a','https://files.slack.com/other/a','https://u:p@files.slack.com/upload/v1/a'])assert.throws(()=>producerTicket({file_id:'F123',upload_url:bad}));
});
