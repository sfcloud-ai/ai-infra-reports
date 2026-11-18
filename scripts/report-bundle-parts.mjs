import {digest} from './archive.mjs';
import {MAX_BUNDLE,requireThat} from './report-handoff.mjs';

// This transport threshold is below the logical report/admission limit.
export const REPORT_PART_SCHEMA='CREATE TABLE research_control_report_parts(permit_id TEXT NOT NULL,part INTEGER NOT NULL,source_ts TEXT UNIQUE NOT NULL,file_id TEXT NOT NULL,sha256 TEXT NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(permit_id,part))';
export const REPORT_PART_VERSION=1;
export const REPORT_PART_BYTES=1024*1024;
// Keep a full-size 2 MB poster plus normal metadata on the single-file path.
export const REPORT_SPLIT_THRESHOLD=3*REPORT_PART_BYTES;
export const MAX_REPORT_PARTS=Math.ceil(MAX_BUNDLE/REPORT_PART_BYTES);
export const isReportPart=value=>Number.isSafeInteger(value)&&value>=0&&value<MAX_REPORT_PARTS;
export const reportPartName=index=>`ai-brief-bundle-part-${index}.bin`;
export const partScope=(base,index)=>index>0?`${base}:part:${index}`:base;

export function reportParts(bytes){
 requireThat(Buffer.isBuffer(bytes)&&bytes.length>REPORT_PART_BYTES&&bytes.length<=MAX_BUNDLE,'Bounded multipart report required');
 const parts=[];
 for(let offset=0;offset<bytes.length;offset+=REPORT_PART_BYTES){
  const data=bytes.subarray(offset,offset+REPORT_PART_BYTES);
  parts.push({index:parts.length,data,bytes:data.length,sha256:digest(data)});
 }
 return parts;
}

// Completion is bound to a permit. Its original archive supplies the expected
// ranges, never substitute bytes for a missing transport part.
export async function assembleReportParts(expected,read){
 const manifest=reportParts(expected),parts=[];
 for(const part of manifest){
  const data=await read(part);
  requireThat(Buffer.isBuffer(data)&&data.length===part.bytes&&digest(data)===part.sha256,'Original report part bytes differ');
  parts.push(data);
 }
 const joined=Buffer.concat(parts);
 requireThat(joined.length===expected.length&&digest(joined)===digest(expected),'Reassembled report differs from original permit bytes');
 return joined;
}

// The same logical pending set serves daily discovery, request status and health.
// A verified part remains visible after its single-file intake event finishes.
export function pendingSubmissionClause(db){
 return db.prepare("SELECT 1 FROM sqlite_master WHERE name='research_control_report_parts'").get()
  ? "(phase IN ('pending','receiving') OR (phase='done' AND source_ts IN (SELECT source_ts FROM research_control_report_parts)))"
  : "phase='pending'";
}
export const pendingSubmissionPhase="CASE phase WHEN 'done' THEN 'receiving' ELSE phase END AS phase";
