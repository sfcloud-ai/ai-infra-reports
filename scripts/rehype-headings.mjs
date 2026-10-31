import {rehypeHeadingIds} from "@astrojs/markdown-remark";
// Prefix all content headings; shell IDs and fragment navigation stay independent.
export default function reportHeadings(){
 return (tree,file)=>{
  rehypeHeadingIds()(tree,file);
  const ids=new Map();
  function headings(n,parent){
   if(parent?.properties?.dataFootnotes && n.properties?.id==="footnote-label") return;
   if(n.type==="element"&&/^h[1-6]$/.test(n.tagName)&&typeof n.properties?.id==="string"){
    const old=n.properties.id,next="article-"+old;ids.set(old,next);n.properties.id=next;
   }
   n.children?.forEach(child=>headings(child,n));
  }headings(tree);
  function links(n){
   if(n.type==="element"&&n.tagName==="a"&&typeof n.properties?.href==="string"&&n.properties.href.startsWith("#")){
    const old=decodeURIComponent(n.properties.href.slice(1));
    if(ids.has(old))n.properties.href="#"+ids.get(old);
   }
   n.children?.forEach(links);
  }links(tree);
 };
}
