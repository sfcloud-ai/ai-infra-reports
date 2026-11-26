// Offline custody tooling. T4 stored receipts are issued by the existing
// research archive transport, never by this command.
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, open, rename, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {followupPath, pdfFollowup, PDF_PART_BYTES as PART_BYTES, pdfPartName as partName} from './research-pdf-followup.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const writeJson = (name, value) => writeFile(name, JSON.stringify(value)+'\n', {flag:'wx', mode:0o600});

async function readBounded(name, limit) {
  const file = await open(name,'r');
  try {
    const {size} = await file.stat();
    if (!Number.isSafeInteger(size) || size < 1 || size > limit) throw Error('Invalid archive component size');
    const bytes = Buffer.alloc(size);
    await readExactly(file,bytes);
    if ((await file.read(Buffer.alloc(1))).bytesRead) throw Error('Archive component grew');
    return bytes;
  } finally { await file.close(); }
}

async function readExactly(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const {bytesRead} = await file.read(bytes,offset,bytes.length-offset);
    if (!bytesRead) throw Error('Incomplete original PDF bytes');
    offset += bytesRead;
  }
}

export async function processPdf(mode, receiptPath, input, destination) {
  if (!['prepare','split','verify'].includes(mode) || (mode === 'verify') !== (destination === undefined))
    throw Error('Use prepare|split RECEIPT PDF NEW_DIRECTORY, or verify RECEIPT READBACK_DIRECTORY');
  const raw = await readBounded(receiptPath, 2_000_000);
  const receipt = JSON.parse(raw);
  const descriptor = pdfFollowup(receipt,raw);
  if (!descriptor) throw Error('Original supplemental PDF receipt required');
  const total = createHash('sha256');
  const manifest = {request_id:receipt.request_id, ...descriptor, part_bytes:PART_BYTES, parts:[]};
  const count = Math.ceil(descriptor.bytes/PART_BYTES);
  const relative = join('archive_followups',descriptor.operation_id);
  if (mode === 'verify') {
    for (let index=0; index<count; index++) {
      const name = partName(index);
      const bytes = await readBounded(join(input,relative,name), PART_BYTES);
      if (bytes.length !== Math.min(PART_BYTES, descriptor.bytes-index*PART_BYTES)) throw Error('PDF part length mismatch');
      total.update(bytes);
      manifest.parts.push({name, sha256:sha(bytes), bytes:bytes.length});
    }
    if (total.digest('hex') !== descriptor.body_sha256 ||
        !isDeepStrictEqual(manifest,JSON.parse(await readBounded(join(input,relative,'manifest.json'),PART_BYTES))))
      throw Error('Readback differs from original PDF');
    return descriptor;
  }
  const target = resolve(destination);
  const temp = await mkdtemp(join(dirname(target),'.'+basename(target)+'-'));
  try {
    const folder = mode === 'prepare' ? join(temp,'archive_followups') : join(temp,relative);
    await mkdir(folder,{recursive:true});
    const original = await open(input,'r');
    try {
      if ((await original.stat()).size !== descriptor.bytes) throw Error('PDF size differs from its receipt');
      for (let index=0; index<count; index++) {
        const bytes = Buffer.alloc(Math.min(PART_BYTES,descriptor.bytes-index*PART_BYTES));
        await readExactly(original,bytes);
        if (index === 0 && !bytes.subarray(0,5).equals(Buffer.from('%PDF-'))) throw Error('Original PDF header required');
        total.update(bytes);
        if (mode === 'split') {
          const name = partName(index);
          await writeFile(join(folder,name),bytes,{flag:'wx',mode:0o600});
          manifest.parts.push({name, sha256:sha(bytes), bytes:bytes.length});
        }
      }
      if ((await original.read(Buffer.alloc(1))).bytesRead || total.digest('hex') !== descriptor.body_sha256)
        throw Error('PDF digest differs from its receipt');
    } finally { await original.close(); }
    if (mode === 'prepare') {
      await writeFile(join(temp,'result.json'),raw,{flag:'wx',mode:0o600});
      await writeJson(join(temp,followupPath(descriptor.operation_id)),descriptor);
    } else await writeJson(join(folder,'manifest.json'),manifest);
    await rename(temp,target);
  } finally { await rm(temp,{recursive:true,force:true}); }
  return descriptor;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await processPdf(...process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode=1; }
}
