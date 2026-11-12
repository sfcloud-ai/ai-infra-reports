import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {producerCurlEnvironment,curlUploadPlan,uploadProducerBytes,uploadResearchArchiveBytes} from '../scripts/producer-upload-adapters.mjs';
import {readFile} from 'node:fs/promises';
import {stageFile} from '../scripts/slack-stage-cli.mjs';
import {digest} from '../scripts/archive.mjs';
import {PRODUCER_TOOLS} from '../scripts/producer-upload.mjs';
import {producerTicket} from '../scripts/producer-upload.mjs';
const authority={permit_id:null,before:async()=>null,after:async()=>{},validateArchive:async()=>{}};
const proxy='http://managed.invalid:3128',url='https://files.slack.com/upload/v1/SYNTHETIC-token';
test('managed transport restricts environment and fails closed',()=>{
 assert.deepEqual(producerCurlEnvironment('managed_proxy',{PATH:'/bin',https_proxy:proxy,NO_PROXY:'*',SECRET:'hidden'}),{PATH:'/bin',LANG:'C',https_proxy:proxy,HTTPS_PROXY:proxy,no_proxy:'',NO_PROXY:''});
 assert.deepEqual(producerCurlEnvironment('direct',{PATH:'/bin',https_proxy:proxy}),{PATH:'/bin',LANG:'C'});
 for(const e of [{},{https_proxy:proxy,HTTPS_PROXY:'http://other.invalid'},{https_proxy:'socks5://bad.invalid'},{https_proxy:'http://bad.invalid/?secret=x'},{https_proxy:'http://bad.invalid\n'},{https_proxy:proxy,SSL_CERT_FILE:'relative'}])assert.throws(()=>producerCurlEnvironment('managed_proxy',e));
});
test('managed plan preserves transport safety and stdin-only URL',()=>{
 for(const transport of ['direct','managed_proxy']){
  const p=curlUploadPlan({url,input:'/tmp/in',output:'/tmp/out',size:1,transport});
  assert.equal(p.args.includes('--noproxy'),transport==='direct');assert(!p.args.join(' ').includes(url));assert.equal(p.stdin,`url = "${url}"\n`);
  assert.equal(p.args[p.args.indexOf('--retry')+1],'0');assert.equal(p.args[p.args.indexOf('--max-redirs')+1],'0');assert(!p.args.includes('-k'));assert(!p.args.includes('--location'));
 }
});
test('proxy failure retains distinct provenance and no secret result',async()=>{
 let observed;
 const spawnCurl=(exe,args,options)=>{
  observed={exe,args,options};const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.kill=()=>{};
  c.stdin.on('finish',()=>{c.stdout.write('0\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0');c.emit('close',6);});return c;
 };
 const r=await uploadProducerBytes({bytes:Buffer.from('x'),ticket:producerTicket({file_id:'FSYNTHETIC',upload_url:url})},{spawnCurl,transport:'managed_proxy',environment:{PATH:'/bin',https_proxy:proxy}});
 assert.equal(r.adapter,'producer_curl_managed_proxy_v1');assert.equal(r.metrics.curl_exit,6);assert.equal(observed.options.env.https_proxy,proxy);assert.equal(observed.options.stdio[2],'ignore');assert(!JSON.stringify(r).includes(url));assert(!JSON.stringify(r).includes(proxy));
});
test('missing proxy never falls back to direct',async()=>{
 let called=false;await assert.rejects(uploadProducerBytes({bytes:Buffer.from('x'),ticket:producerTicket({file_id:'FSYNTHETIC',upload_url:url})},{spawnCurl:()=>{called=true;},transport:'managed_proxy',environment:{}}),/proxy unavailable/);assert.equal(called,false);
});
test('research archives above report cap traverse the actual adapter while reports retain their original cap',async()=>{
 const data=Buffer.alloc(7*1024*1024,120),bytes=Buffer.from(JSON.stringify({schema_version:'research_archive_v1',command_id:'11111111-1111-4111-8111-111111111111',request_id:'morning-20261101-r1',report_date:'2026-11-01',previous_sha256:null,files:[{path:'source.txt',sha256:digest(data),content_base64:data.toString('base64')}]}));
 const ticket=producerTicket({file_id:'FSYNTHETIC',upload_url:url});let posts=0,writes=0;
 const spawnCurl=(_exe,args)=>{
  posts++;const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{};
  child.stdin.on('finish',async()=>{try{
   const input=args[args.indexOf('--data-binary')+1].slice(1);assert.deepEqual(await readFile(input),bytes);
   child.stdout.write(`200\t1\t0\t${bytes.length}\t0\t0\t0\t0\t0\t0\t0`);child.emit('close',0);
  }catch(e){child.emit('error',e);}});return child;
 };
 await stageFile(bytes,'C123',async(tool)=>{writes++;return tool===PRODUCER_TOOLS.ticket?{file_id:ticket.file_id,upload_url:ticket.upload_url}:{};},{authority,research:true,upload:request=>uploadResearchArchiveBytes(request,{spawnCurl,transport:'managed_proxy',environment:{PATH:'/bin',https_proxy:proxy}})});
 assert.equal(posts,1);assert.equal(writes,2);
 await assert.rejects(uploadProducerBytes({bytes,ticket},{spawnCurl}),/Bounded/);assert.equal(posts,1);
 await assert.rejects(stageFile(Buffer.alloc(16*1024*1024+1),'C123',()=>assert.fail('oversize fails before ticket'),{authority,research:true}),/Bounded/);
});
