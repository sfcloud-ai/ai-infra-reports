// Human-maintained archive backfills only. Producer and Merger keep validateChange.
import {json,validateArchive,validateChange} from './archive.mjs';

export function currentReportDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0,10);
}

export function validateCIReportChange(base, head, {today = currentReportDate()} = {}) {
  const added = [...head.keys()].filter(p => p !== 'reports/index.json' && !base.has(p));
  const directories = [...new Set(added.map(p => p.split('/').slice(0,3).join('/')))].sort();
  if (directories.length <= 1) return validateChange(base, head);
  const require = (condition, message) => { if (!condition) throw Error(message); };
  require(typeof today === 'string' && /^\d{4}-\d\d-\d\d$/.test(today) && new Date(today+'T00:00:00Z').toISOString().slice(0,10) === today, 'invalid backfill cutoff date');
  const previousArchive = validateArchive(base);
  const result = validateArchive(head);
  for (const [p, bytes] of base) if (p !== 'reports/index.json') require(head.get(p)?.equals(bytes), 'published reports are immutable');
  const existingDates = new Set(previousArchive.reports.map(r => r.date));
  for (const directory of directories) {
    const [,date,revision] = directory.split('/');
    require(date < today, 'batch backfills must precede the current UTC+8 report date');
    require(revision === 'r1' && !existingDates.has(date), 'batch backfills require previously absent dates at revision 1');
  }
  // Preserve ordinary per-revision validation, including deduplication and atomic indexes.
  let previous = base;
  for (const directory of directories) {
    const next = new Map(previous);
    for (const p of added) if (p.startsWith(directory + '/')) next.set(p, head.get(p));
    next.set('reports/index.json', Buffer.from(json(validateArchive(next, {checkIndex:false}).index)));
    validateChange(previous, next);
    previous = next;
  }
  require(previous.get('reports/index.json').equals(head.get('reports/index.json')), 'historical batch index differs');
  return result;
}
