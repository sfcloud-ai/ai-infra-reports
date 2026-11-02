import {evidenceAssets} from './evidence-assets.mjs';
// Archive revisions remain source history; only one edition per date is public.
export function publicReports(reports) {
 const latest=new Map();
 for(const report of reports) {
  const prior=latest.get(report.date);
  if(!prior||report.revision>prior.revision)latest.set(report.date,report);
 }
 return [...latest.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
export function publicAssets(published,archive,files) {
 const paths=new Set(),requiredHashes=new Set();
 for(const report of published) {
  for(const image of report.images)paths.add(report.path+image.path);
  for(const article of report.articles)
   for(const hash of evidenceAssets(files.get(article.path).toString('utf8'),report.path,files))requiredHashes.add(hash);
 }
 for(const report of archive)
  for(const image of report.images)
   if(requiredHashes.has(image.sha256))paths.add(report.path+image.path);
 return [...paths].sort();
}
