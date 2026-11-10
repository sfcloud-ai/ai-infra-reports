// Explicit, recoverable working-tree migration. Never rewrites Git history or notice state.
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {readReports,migrateArchive,replaceCurrentReport} from './archive.mjs';
import {validateCIReportChange} from './historical-backfill.mjs';
import {validateRasters} from './rasters.mjs';
export async function migrateCurrent(root,{bundle,write=false}={}) {
 const base=await readReports(root);
 let head=migrateArchive(base);
 if(bundle)head=replaceCurrentReport(head,bundle);
 validateCIReportChange(base,head);await validateRasters(head);
 if(write) {
  // Add validated current snapshots before removing obsolete tracked paths.
  // Deleted revision sources remain recoverable from the original Git commit.
  for(const [p,b]of head){await mkdir(path.dirname(path.join(root,p)),{recursive:true});await writeFile(path.join(root,p),b);}
  for(const p of base.keys())if(!head.has(p))await unlink(path.join(root,p));
 }
 return head;
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href) {
 const [root,...args]=process.argv.slice(2);
 if(!root||args.some(a=>a!=='--write'))throw Error('Usage: node scripts/migrate-current.mjs ROOT [--write]');
 const result=await migrateCurrent(root,{write:args.includes('--write')});console.log('Validated current snapshot migration: '+result.size+' files'+(args.includes('--write')?' written':' (dry run)'));
}
