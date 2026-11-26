// A successful supplemental GET can be settled by its original receipt before
// the separately tracked PDF has been copied to the archive.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fromMarkdown} from 'mdast-util-from-markdown';
import {gfm} from 'micromark-extension-gfm';
import {gfmFromMarkdown} from 'mdast-util-gfm';

export const PDF_PART_BYTES=8*1024*1024;
export const pdfPartName=index=>`part-${String(index).padStart(6,'0')}.bin`;
export const followupPath = id => `archive_followups/${id}.json`;

export function pdfFollowup(receipt, resultBytes) {
  const body = receipt?.artifacts?.['response.body.bin'];
  if (!body || !Number.isSafeInteger(body.bytes) || body.bytes < 1 ||
      !/^[a-f0-9]{64}$/.test(body.sha256) || body.sha256 !== receipt.content_sha256 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(receipt.operation_id) ||
      receipt.status !== 'ok' || receipt.error !== '' || receipt.curl_exit_code !== 0 ||
      receipt.http_status !== 200 || receipt.response_complete !== true ||
      receipt.dispatch_started !== true || receipt.attempts_in_this_operation !== 1 ||
      receipt.coverage_status !== 'not_assessed' || typeof receipt.transfer?.content_type !== 'string' ||
      receipt.transfer.content_type.split(';')[0].trim().toLowerCase() !== 'application/pdf')
    return null;
  return {operation_id:receipt.operation_id, result_sha256:createHash('sha256').update(resultBytes).digest('hex'),
    body_sha256:body.sha256, bytes:body.bytes};
}

export function archivedFollowup(files, receipt, resultBytes, op) {
  const marker = files.find(file => file.path === followupPath(op.operation_id));
  if (!marker) return undefined;
  const expected = pdfFollowup(receipt, resultBytes);
  let saved;
  try { saved = JSON.parse(marker.data); } catch { return null; }
  if (!expected || !isDeepStrictEqual(saved, expected) ||
      receipt.operation_id !== op.operation_id || receipt.request_id !== op.request_id ||
      receipt.url !== JSON.parse(op.input).url || receipt.input_sha256 !== op.input_hash ||
      receipt.elapsed_seconds !== op.elapsed_seconds || receipt.reserved_seconds !== op.reserved_seconds)
    return null;
  return {descriptor:expected, source_id:receipt.source_id, url:receipt.url};
}

// The frozen verifier consumes the original UTF-8 text. Locate already retained
// bytes in the same run; a part boundary may split a UTF-8 code point.
export function frozenPdfEvidenceAvailable(db,requestId,pdf,readArchive){
  // The original verifier reads at most 20,000,000 bytes per evidence file.
  if(pdf.bytes>20_000_000)return false;
  const query=`SELECT a.hash AS archive, json_extract(f.value,'$.sha256') AS sha
    FROM research_archives a, json_each(a.manifest) f WHERE a.request_id=?
    AND (? IS NULL OR json_extract(f.value,'$.path')=?)
    AND (? IS NULL OR json_extract(f.value,'$.sha256')=?)`;
  const lookup=db.prepare(query),partLookup=db.prepare(query);
  const find=(path,sha)=>lookup.iterate(requestId,path,path,sha,sha);
  function validText(chunks){
    const hash=createHash('sha256'),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
    let size=0,nonblank=false;
    try{
      for(const chunk of chunks){
        if(!chunk||size+chunk.length>pdf.bytes)return false;
        size+=chunk.length;hash.update(chunk);
        const text=decoder.decode(chunk,{stream:true});
        nonblank ||= /[^\p{White_Space}\u001c-\u001f]/u.test(text);
      }
      decoder.decode();
    }catch(error){if(error.code==='ERR_ENCODING_INVALID_ENCODED_DATA')return false;throw error;}
    return nonblank&&size===pdf.bytes&&hash.digest('hex')===pdf.body_sha256;
  }
  for(const row of find(null,pdf.body_sha256)){
    if(validText([readArchive(row.archive).byHash.get(row.sha)?.data]))return true;
  }
  const prefix=`archive_followups/${pdf.operation_id}/`;
  function* parts(manifest){
    for(const [i,part] of manifest.parts.entries()){
      const name=pdfPartName(i),size=Math.min(PDF_PART_BYTES,pdf.bytes-i*PDF_PART_BYTES);
      if(part?.name!==name||part.bytes!==size||typeof part.sha256!=='string'||!/^[a-f0-9]{64}$/.test(part.sha256)){yield null;return;}
      const row=partLookup.get(requestId,prefix+name,prefix+name,part.sha256,part.sha256);
      const bytes=row&&readArchive(row.archive).byHash.get(row.sha)?.data;
      yield bytes?.length===size?bytes:null;
    }
  }
  for(const row of find(prefix+'manifest.json',null)){
    let manifest;
    const bytes=readArchive(row.archive).byHash.get(row.sha)?.data;
    if(!bytes)continue;
    try{manifest=JSON.parse(bytes);}catch{continue;}
    if(manifest?.request_id!==requestId||manifest.part_bytes!==PDF_PART_BYTES||!Array.isArray(manifest.parts)||
      manifest.parts.length!==Math.ceil(pdf.bytes/PDF_PART_BYTES))continue;
    const {request_id,part_bytes,parts:listed,...binding}=manifest;
    if(isDeepStrictEqual(binding,pdf)&&validText(parts(manifest)))return true;
  }
  return false;
}

function sameUrl(candidate, expected) {
  function normalized(value) {
    const url = new URL(value);
    url.hash = '';
    url.searchParams.sort();
    return url.href;
  }
  try { return normalized(candidate) === normalized(expected); } catch { return false; }
}

function mentions(value, id, url) {
  if (typeof value === 'string') {
    if (value === id || sameUrl(value,url)) return true;
    const links = value.match(/https?:\/\/[^\s<>"'\[\]()]+/gi) ?? [];
    return links.some(link => sameUrl(link.replace(/[.,;!?。，；]+$/u,''),url));
  }
  return value !== null && typeof value === 'object' && Object.values(value).some(item => mentions(item, id, url));
}

export function publicationFollowupsMatch(metadata, bundle, queued, attested) {
  const declared = Array.isArray(metadata?.sources) ? metadata.sources.filter(source => source?.archive_followup !== undefined) : [];
  if (queued.length !== declared.length) return false;
  if (!declared.length) return attested === undefined;
  if (!isDeepStrictEqual(attested, declared.map(s => ({source_id:s.id, ...s.archive_followup})))) return false;
  const ids = new Set();
  for (const source of declared) {
    const entry = queued.find(item => item.source_id === source.id && item.url === source.url &&
      isDeepStrictEqual(item.descriptor, source.archive_followup));
    if (!entry || ids.has(entry.descriptor.operation_id) || source.status !== 'ok' ||
        source.attempts !== 1 || source.content_sha256 !== entry.descriptor.body_sha256 ||
        metadata.sources.some(other => other !== source && (other?.id === source.id || other?.url === source.url)))
      return false;
    ids.add(entry.descriptor.operation_id);
    if ([metadata.checks, metadata.discovery, metadata.decisions, metadata.status_entries, metadata.page_scope]
        .some(value => mentions(value, source.id, source.url))) return false;
    for (const file of bundle.files) {
      if (!/\.(md|json)$/.test(file.path)) continue;
      const text = Buffer.from(file.base64,'base64').toString('utf8');
      if (file.path.endsWith('.json')) {
        if (mentions(JSON.parse(text),source.id,source.url)) return false;
      } else {
        const tree = fromMarkdown(text,{extensions:[gfm()],mdastExtensions:[gfmFromMarkdown()]});
        const cites = node => (typeof node.url === 'string' && sameUrl(node.url,source.url)) ||
          (node.type === 'html' && mentions(node.value,source.id,source.url)) || node.children?.some(cites);
        if (cites(tree)) return false;
      }
    }
  }
  return true;
}
