import {BASE,digest} from './archive.mjs';
import {evidenceAssetReferences} from './evidence-assets.mjs';
export const REPORT_ORIGIN='https://sfcloud-ai.github.io';
export const stableSlug=report=>report.date;
export const editionSlug=report=>`${report.date}/r${report.revision}`;
export function stableReportLink(value){
 return value.replace(/^(https:\/\/sfcloud-ai\.github\.io)?(\/ai-infra-reports\/\d{4}-\d\d-\d\d)\/r[1-9]\d*(?=\/|$|[?#])/,'$1$2');
}
export function stableAssetPath(source){
 if(!/^reports\/\d{4}-\d\d-\d\d\/(?:r[1-9]\d*\/)?assets\/[a-z0-9][a-z0-9-]{0,79}\.(png|jpg)$/.test(source))throw Error('Invalid public asset source');
 return source.replace(/^(reports\/\d{4}-\d\d-\d\d\/)r[1-9]\d*\//,'$1');
}
// Aliases affect rendering only. The original source bytes and evidence hashes
// remain unchanged; collisions never replace a different referenced image.
export function publicAssetPlan(paths,files,reports=[]){
 const outputs=new Map(),aliases={};
 for(const source of paths){
  const bytes=files.get(source);if(!bytes)throw Error('Missing public asset');
  let target=stableAssetPath(source);
  if(outputs.has(target)&&!files.get(outputs.get(target)).equals(bytes))target=target.replace(/\.(png|jpg)$/,`-${digest(bytes).slice(0,16)}.$1`);
  if(outputs.has(target)&&!files.get(outputs.get(target)).equals(bytes))throw Error('Public asset collision');
  outputs.set(target,source);aliases[BASE+'/'+source]=BASE+'/'+target;
 }
 for(const r of reports){
  for(const image of r.images||[]){
   const source=r.path+image.path,target=aliases[BASE+'/'+source];
   if(target)aliases[`${BASE}/reports/${r.date}/r${r.revision}/${image.path}`]=target;
  }
  for(const article of r.articles||[]){
   const text=files.get(article.path).toString('utf8');
   for(const [url,source]of evidenceAssetReferences(text,r.path,files)){
    const target=aliases[BASE+'/'+source];
    if(url.startsWith(BASE+'/')&&target)aliases[url]=target;
   }
  }
 }
 return {outputs,aliases};
}
export function legacyRedirects(reports,historicalRoutes=[]){
 const redirects=[];
 for(const r of reports){
  // Bound generated shells; the 404 compatibility route covers any other
  // positive legacy revision without retaining historical article content.
  for(let revision=1;revision<=Math.min(r.revision,100);revision++){
   const from=`${r.date}/r${revision}`;
   redirects.push({from,to:r.date});
   for(const a of r.articles)redirects.push({from:from+'/'+a.id,to:r.date+'/'+a.id});
  }
  if(r.revision>100){const from=editionSlug(r);redirects.push({from,to:r.date});for(const a of r.articles)redirects.push({from:from+'/'+a.id,to:r.date+'/'+a.id});}
 }
 const known=new Map(reports.map(r=>[r.date,new Set(r.articles.map(a=>a.id))])),seen=new Set(redirects.map(r=>r.from));
 for(const from of historicalRoutes){
  const match=/^(\d{4}-\d\d-\d\d)\/r[1-9]\d*\/([a-z0-9][a-z0-9-]{0,79})$/.exec(from);
  if(!match)throw Error('Invalid historical article route');
  if(!known.has(match[1])||seen.has(from))continue;
  redirects.push({from,to:match[1]+(known.get(match[1]).has(match[2])?'/'+match[2]:'')});seen.add(from);
 }
 return redirects;
}
export function legacyDestination(pathname,days){
 const match=/^\/ai-infra-reports\/(\d{4}-\d\d-\d\d)\/r[1-9]\d*(?:\/([a-z0-9][a-z0-9-]{0,79}))?\/?$/.exec(pathname);
 if(!match||!Object.hasOwn(days,match[1]))return null;
 const article=match[2]&&days[match[1]].includes(match[2])?match[2]+'/':'';
 return BASE+'/'+match[1]+'/'+article;
}
