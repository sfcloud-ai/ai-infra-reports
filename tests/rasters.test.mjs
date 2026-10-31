import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {validateRasters} from "../scripts/rasters.mjs";
test("complete PNG and JPEG decode; header-only and truncated files fail",async()=>{
 for(const format of ["png","jpeg"]){
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:"#ffffff"}}).toFormat(format).toBuffer();
  const name="reports/2026-10-31/r1/assets/test."+(format==="png"?"png":"jpg");
  await validateRasters(new Map([[name,bytes]]));
  await assert.rejects(()=>validateRasters(new Map([[name,bytes.subarray(0,25)]])));
 }
 const fake=Buffer.alloc(25);Buffer.from([137,80,78,71,13,10,26,10]).copy(fake);fake.write("IHDR",12);fake.writeUInt32BE(1,16);fake.writeUInt32BE(1,20);
 await assert.rejects(()=>validateRasters(new Map([["reports/2026-10-31/r1/assets/header.png",fake]])));
});
