import sharp from "sharp";
import {digest} from "./archive.mjs";
const decoded=new Set();
// Shared by the required CI, publisher, merge gate and site preparer.
export async function validateRasters(files) {
 for(const [name,bytes]of files){
  if(!/^reports\/.*\/assets\/.*\.(png|jpg)$/.test(name))continue;
  if(bytes.length>2*1024*1024)throw Error("Raster byte limit");
  const key=name.split(".").at(-1)+":"+digest(bytes);if(decoded.has(key))continue;
  const decoder=sharp(bytes,{limitInputPixels:16000000,failOn:"warning",sequentialRead:true});
  const meta=await decoder.metadata();
  if(meta.format!==(name.endsWith(".png")?"png":"jpeg")||(meta.pages||1)!==1||!meta.width||!meta.height||meta.width>8192||meta.height>8192)throw Error("Raster format/dimensions");
  await decoder.timeout({seconds:10}).ensureAlpha().raw({depth:"uchar"}).toBuffer();
  decoded.add(key);
 }
}
