import {describe,it,expect,mock} from "bun:test";
import sharp from "sharp";
const download = mock(async () => { throw new Error("Inline image must not use network"); });
mock.module("@/utils/remote-image-download", () => ({ downloadRemoteImage: download, probeRemoteImageSize: async () => null }));
const {decodeStashImage,loadEnrichmentImage,probeEnrichmentImage}=await import("@/modules/enrichment/enrichment.images");
describe("Stash scraper inline images",()=>{
 it("loads and measures an actual PNG in memory without HTTP",async()=>{
  const png=await sharp({create:{width:11,height:7,channels:3,background:'#123456'}}).png().toBuffer();
  const value=`data:image/png;base64,${png.toString('base64')}`;
  expect(decodeStashImage(value)).toEqual(png);
  expect(await loadEnrichmentImage(value)).toEqual(png);
  expect(await probeEnrichmentImage(value)).toEqual({width:11,height:7});
  expect(download).not.toHaveBeenCalled();
 });
 it("rejects malformed/unsupported/oversized inline values",async()=>{
  for(const value of ['data:image/png;base64,@@','data:text/html;base64,YQ==','data:image/svg+xml;base64,YQ==','data:image/png;base64,'+'A'.repeat(28*1024*1024)]) expect(()=>decodeStashImage(value)).toThrow();
  await expect(loadEnrichmentImage('data:image/png;base64,YQ==')).rejects.toThrow('Unable to decode');
  expect(await probeEnrichmentImage('data:image/png;base64,YQ==')).toBeNull();
 });
});
