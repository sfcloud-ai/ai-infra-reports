import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {producerCurlEnvironment,curlUploadPlan,uploadProducerBytes} from '../scripts/producer-upload-adapters.mjs';
import {producerTicket} from '../scripts/producer-upload.mjs';
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
