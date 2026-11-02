import {dailyBody,articleBody,articleEvidence} from "./content-text.mjs";
import {latestNoticeEdition,noticeManifestForBuild} from "./notice-manifest.mjs";
import {validateRasters} from "./rasters.mjs";
import {editionSources} from "./publication-content.mjs";
import {publicReports,publicAssets} from "./public-reports.mjs";
import {readFile,writeFile,mkdir,rm} from "node:fs/promises";
import path from "node:path";
import {readReports,validateArchive,json,BASE} from "./archive.mjs";
const root=process.cwd();
const preview=process.env.REPORT_PREVIEW==="1";
const source=preview?path.join(root,"tests/fixtures/archive"):root;
const files=await readReports(source);
const {reports}=validateArchive(files);
const publishedReports=publicReports(reports);
await validateRasters(files);
const commit=process.env.REPORT_COMMIT||"local-preview";
const newest=latestNoticeEdition(reports);
const docs=path.join(root,"generated/docs"),assets=path.join(root,"public/reports");
for(const p of [docs,assets]) {if(!p.startsWith(root+path.sep))throw Error("generated path");await rm(p,{recursive:true,force:true});await mkdir(p,{recursive:true});}
const pages=[],assetsManifest=[],articleDirs={},publicationSources={};
for(const r of [...publishedReports].reverse()) {
  const slug=r.date+"/r"+r.revision, source=slug+"/index";
  publicationSources[slug]=editionSources(files,slug);
  const description=r.subtitle;
  const body=dailyBody(r,preview);
  const common={date:r.date,revision:r.revision,group:r.date,commit:"main",origin:r.path+"report.json"};
  pages.push({...common,slug,source,title:r.title,description,kind:"day"});
  const write=async (source,body)=>{const p=path.join(docs,source+".md");await mkdir(path.dirname(p),{recursive:true});await writeFile(p,body);};
  await write(source,body);
  for(const a of r.articles) {
    const articleSlug=slug+"/"+a.id;
    let text=files.get(a.path).toString("utf8");
    articleDirs[path.resolve(docs,articleSlug+".md")]=r.path;
    text=articleBody(r,a,text,preview);
    pages.push({...common,slug:articleSlug,source:articleSlug,title:a.title,description:a.summary,kind:"article",origin:a.path,parent:slug,evidence:articleEvidence(r,a)});
    await write(articleSlug,text);
  }
  // Historical and preview fixtures may not have a notification poster. They
  // remain readable, but never acquire a fabricated normal-delivery manifest.
  if(r.articles.length&&r.poster) {
    const notice=noticeManifestForBuild(files.get(r.path+"report.json"),commit,{historical:slug!==newest});
    if(notice) {
      const filename=path.join(assets,slug,"notice.json");
      await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,json(notice));
    } else console.warn("No notification manifest for historical format-incompatible edition "+slug);
  }
}
for(const asset of publicAssets(publishedReports,reports,files)) {
  assetsManifest.push(BASE+"/"+asset);
  const p=path.join(assets,asset.slice("reports/".length));
  await mkdir(path.dirname(p),{recursive:true});await writeFile(p,files.get(asset));
}
await mkdir(path.join(root,"generated"),{recursive:true});
await writeFile(path.join(root,"generated/manifest.json"),json({preview,pages,assets:assetsManifest,articleDirs,publicationSources}));
console.log("Prepared "+publishedReports.length+" reports, "+pages.length+" pages"+(preview?" (synthetic preview)":""));

await writeFile(path.join(root,"public/publication.json"),json({schema_version:"1.0",commit,preview,reports:publishedReports.map(r=>r.date+"/r"+r.revision)}));
