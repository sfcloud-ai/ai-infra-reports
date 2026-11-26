import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {processPdf} from '../scripts/archive-reserve-pdf.mjs';
import {publicationFollowupsMatch} from '../scripts/research-pdf-followup.mjs';

test('private PDF custody is separate from GET settlement and verifies every returned byte', async t => {
  const root=await mkdtemp(join(tmpdir(),'pdf-followup-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const data=Buffer.alloc(18_384_956,0x80);
  data.write('%PDF-1.7\n');
  const body=createHash('sha256').update(data).digest('hex'), id=randomUUID();
  const receipt={operation_id:id,request_id:'morning-20261126-r1',url:'https://arxiv.org/pdf/1234.12345v1',
    status:'ok',error:'',curl_exit_code:0,http_status:200,response_complete:true,coverage_status:'not_assessed',
    dispatch_started:true,attempts_in_this_operation:1,transfer:{content_type:'application/pdf'},
    artifacts:{'response.body.bin':{bytes:data.length,sha256:body}},content_sha256:body};
  const raw=Buffer.from(JSON.stringify(receipt)), original=join(root,'original.pdf'), record=join(root,'result.json');
  await writeFile(original,data);await writeFile(record,raw);
  const prepared=join(root,'receipt'), parts=join(root,'parts');
  const desc=await processPdf('prepare',record,original,prepared);
  assert.deepEqual(await readFile(join(prepared,'result.json')),raw);
  assert.deepEqual(JSON.parse(await readFile(join(prepared,'archive_followups',id+'.json'))),desc);
  assert.equal(desc.bytes,data.length);
  await assert.rejects(processPdf('prepare',record,original,prepared));
  await processPdf('split',record,original,parts);
  const dir=join(parts,'archive_followups',id);
  for(const [index,size] of [8388608,8388608,data.length-2*8388608].entries()){
    assert.equal((await stat(join(dir,'part-'+String(index).padStart(6,'0')+'.bin'))).size,size);
  }
  assert.deepEqual(await processPdf('verify',record,parts),desc);
  await writeFile(join(dir,'part-000002.bin'),Buffer.alloc(data.length-2*8388608));
  await assert.rejects(processPdf('verify',record,parts),/differs/);
  data[10]^=1;await writeFile(original,data);
  await assert.rejects(processPdf('prepare',record,original,join(root,'invalid')),/digest/);
  const source={id:'backup',url:receipt.url,status:'ok',attempts:1,content_sha256:body,archive_followup:desc};
  const metadata={sources:[source]}, queued=[{source_id:source.id,url:source.url,descriptor:desc}];
  for (const [url, allowed] of [[receipt.url,false],[receipt.url+'#page=8',false],[receipt.url+'0',true]]) {
    const bundle={files:[{path:'reports/day/article.md',base64:Buffer.from('[PDF]('+url+')').toString('base64')}]};
    assert.equal(publicationFollowupsMatch(metadata,bundle,queued,[{source_id:source.id,...desc}]),allowed);
  }
});
