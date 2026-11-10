import {dailyBody,articleBody,articleEvidence} from './content-text.mjs';
import {latestNoticeEdition,noticeManifestForBuild} from './notice-manifest.mjs';
import {validateRasters} from './rasters.mjs';
import {editionSources} from './publication-content.mjs';
import {publicReports,publicAssets,publicSubtitle} from './public-reports.mjs';
import {stableSlug,editionSlug,publicAssetPlan,legacyRedirects} from './public-paths.mjs';
import historicalRoutes from '../src/data/legacy-report-routes.json' with {type:'json'};
import {writeFile,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {readReports,validateArchive,json,BASE} from './archive.mjs';
const root=process.cwd(),preview=process.env.REPORT_PREVIEW==='1';
const files=await readReports(preview?path.join(root,'tests/fixtures/archive'):root);
const {reports}=validateArchive(files),publishedReports=publicReports(reports);
await validateRasters(files);
const commit=process.env.REPORT_COMMIT||'local-preview',newest=latestNoticeEdition(reports);
const docs=path.join(root,'generated/docs'),assets=path.join(root,'public/reports');
for(const p of [docs,assets]){if(!p.startsWith(root+path.sep))throw Error('generated path');await rm(p,{recursive:true,force:true});await mkdir(p,{recursive:true});}
const pages=[],articleDirs={},publicationSources={};
for(const r of [...publishedReports].reverse()){
 const slug=stableSlug(r),edition=editionSlug(r),source=slug+'/index';
 publicationSources[edition]=editionSources(files,edition);
 const common={date:r.date,revision:r.revision,edition,group:r.date,commit:'main',origin:r.path+'report.json'};
 pages.push({...common,slug,source,title:r.title,description:publicSubtitle(r),kind:'day'});
 const write=async(source,body)=>{const p=path.join(docs,source+'.md');await mkdir(path.dirname(p),{recursive:true});await writeFile(p,body);};
 await write(source,dailyBody(r,preview));
 for(const a of r.articles){
  const articleSlug=slug+'/'+a.id;articleDirs[path.resolve(docs,articleSlug+'.md')]=r.path;
  pages.push({...common,slug:articleSlug,source:articleSlug,title:a.title,description:a.summary,kind:'article',origin:a.path,parent:slug,evidence:articleEvidence(r,a)});
  await write(articleSlug,articleBody(r,a,files.get(a.path).toString('utf8'),preview));
 }
 if(r.articles.length&&r.poster){
  const notice=noticeManifestForBuild(files.get(r.path+'report.json'),commit,{historical:edition!==newest,stableUrls:true});
  if(notice){
   for(const key of [slug,edition]){const filename=path.join(assets,key,'notice.json');await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,json(notice));}
  }else console.warn('No notification manifest for historical format-incompatible edition '+edition);
 }
}
const plan=publicAssetPlan(publicAssets(publishedReports,reports,files),files,publishedReports),assetsManifest=[];
for(const [target,source]of plan.outputs){assetsManifest.push(BASE+'/'+target);const p=path.join(root,'public',target);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,files.get(source));}
await mkdir(path.join(root,'generated'),{recursive:true});
const legacyDays=Object.fromEntries(publishedReports.map(r=>[r.date,r.articles.map(a=>a.id)]));
await writeFile(path.join(root,'generated/manifest.json'),json({preview,pages,assets:assetsManifest,assetAliases:plan.aliases,articleDirs,publicationSources,redirects:legacyRedirects(publishedReports,historicalRoutes),legacyDays}));
console.log('Prepared '+publishedReports.length+' current reports, '+pages.length+' stable pages'+(preview?' (synthetic preview)':''));
await writeFile(path.join(root,'public/publication.json'),json({schema_version:'1.0',commit,preview,reports:publishedReports.map(editionSlug)}));
