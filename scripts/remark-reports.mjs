import path from "node:path";
import {BASE,publicURL} from "./archive.mjs";
// Image resolution happens on the AST, so code examples remain literal.
export default function reportMarkdown(options={}) {
 const assets=new Set(options.assets||[]),articleDirs=options.articleDirs||{};
 return (tree,file={})=>{
  const definitions=new Map();
  function collect(node){if(node.type==="definition")definitions.set(node.identifier,node.url);node.children?.forEach(collect);}
  collect(tree);
  function visit(node){
   if(node.type==="html"){node.type="text";delete node.children;}
   if(node.type==="imageReference"){
    const url=definitions.get(node.identifier);if(!url)throw Error("Missing image definition");node.type="image";node.url=url;
   }
   if(node.type==="image"){
    let u=node.url;
    if(/^assets\/[a-z0-9-]+\.(png|jpg)$/.test(u)){
     const dir=articleDirs[path.resolve(String(file.path||""))];
     if(!dir)throw Error("Unknown article image context");
     u=BASE+"/"+dir+u;
    }
    if(!assets.has(u))throw Error("Image must reference a declared archive asset");
    node.url=u;
   } else if(["link","definition"].includes(node.type)){
    const u=node.url;
    // A definition used only by an image is checked on that image node.
    if(node.type==="definition"&&(/^assets\/[a-z0-9-]+\.(png|jpg)$/.test(u)||assets.has(u)))return;
    if(u.startsWith("#")){const fragment=decodeURIComponent(u.slice(1));if(Buffer.byteLength(fragment)>512||/[\x00-\x1f\x7f<>\\]/.test(fragment))throw Error("Invalid section fragment");return;}
    if(!(u.startsWith(BASE+"/")&&!u.includes("..")&&!/[\\\s]/.test(u)))publicURL(u);
   }
   node.children?.forEach(visit);
  }
  visit(tree);
 };
}
