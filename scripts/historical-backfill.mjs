// Human-maintained archive backfills only. Producer and Merger keep validateChange.
import {json,validateArchive,validateChange,migrateArchive,validateMigration,exportedHistory} from './archive.mjs';

export function currentReportDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0,10);
}

export function validateCIReportChange(base, head, {today = currentReportDate()} = {}) {
  if(!base.has('reports/history.json') && head.has('reports/history.json')) {
    const migrated=migrateArchive(base);
    if(migrated.size===head.size && [...migrated].every(([p,b])=>head.get(p)?.equals(b)))return validateMigration(base,head);
    return validateChange(migrated,head);
  }
  if(base.has('reports/history.json')) {
    const changed=new Set([...new Set([...base.keys(),...head.keys()])].filter(p=>!/^reports\/(index|history)\.json$/.test(p)&&(!base.has(p)||!head.has(p)||!base.get(p).equals(head.get(p)))).map(p=>p.split('/')[1]));
    if(changed.size<=1)return validateChange(base,head);
    if(typeof today!=='string'||!/^\d{4}-\d\d-\d\d$/.test(today)||new Date(today+'T00:00:00Z').toISOString().slice(0,10)!==today)throw Error('invalid backfill cutoff date');
    const previous=validateArchive(base),result=validateArchive(head);
    if(!head.get('reports/history.json')?.equals(exportedHistory(base)))throw Error('history must exactly extend validated base');
    let cumulative=base;
    for(const date of [...changed].sort()) {
      if(date>=today)throw Error('batch backfills must precede the current UTC+8 report date');
      if(previous.reports.some(r=>r.date===date)||result.reports.find(r=>r.date===date)?.revision!==1)throw Error('batch backfills require previously absent dates at revision 1');
      const single=new Map(cumulative);
      for(const [p,b]of head)if(p.startsWith('reports/'+date+'/'))single.set(p,b);
      single.set('reports/history.json',exportedHistory(cumulative));
      single.set('reports/index.json',Buffer.from(json(validateArchive(single,{checkIndex:false}).index)));
      validateChange(cumulative,single);
      cumulative=single;
    }
    if(!cumulative.get('reports/index.json').equals(head.get('reports/index.json')))throw Error('historical batch index differs');
    return result;
  }
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
