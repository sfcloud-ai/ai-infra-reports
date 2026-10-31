import {BASE,publicURL} from "./archive.mjs";
// Escape every ASCII punctuation mark, so metadata remains text in all Markdown contexts.
export const markdownText=value=>value.replace(/[!-/:-@[-`{-~]/g,c=>"\\"+c);
export function dailyBody(r,preview=false){
 const slug=r.date+"/r"+r.revision;
 let body=preview?"> 预览样例：以下内容为合成数据，用于验证阅读与检索，不是正式晨报。\n\n":"";
 body+="## 本期文章\n\n";
 for(const a of r.articles)body+="### ["+markdownText(a.title)+"]("+BASE+"/"+slug+"/"+a.id+"/)\n\n"+markdownText(a.summary)+"\n\n";
 if(!r.articles.length)body+="本期没有达到发布标准的条目。\n";
 if(r.poster)body+="\n## 本期海报\n\n!["+markdownText(r.images.find(i=>i.path===r.poster).alt)+"]("+BASE+"/"+r.path+r.poster+")\n";
 return body;
}
export function articleBody(r,a,text,preview=false){
 return (preview?"> 合成预览样例，不是正式报告。\n\n":"")+text;
}
export function articleEvidence(r,a){
 return r.entries.filter(e=>e.article_id===a.id).map(e=>({title:e.title,urls:[...new Set(e.source_urls.map(publicURL))]}));
}
