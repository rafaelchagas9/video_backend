import { describe, expect, it } from "bun:test";
import { HttpRecordingFaceVisibilityAdapter, RECORDING_FACE_VISIBILITY_MODEL_SHA256, type RecordingFaceVisibilityPolicy } from "@/modules/recordings/recordings.face-visibility";
const policy = { model_sha256: RECORDING_FACE_VISIBILITY_MODEL_SHA256, input_size: [640,640], confidence: .5, nms: .4, providers: ["CPUExecutionProvider"], identity_embeddings: false, service: "shared-vision" } satisfies RecordingFaceVisibilityPolicy;
const input = { generationIdentity: "a".repeat(64), items: [{ index: 42, timestampSeconds: 210, image: new Blob(["cached tile"], {type:"image/webp"}) }] };
function transport(metadata: unknown, error = false) {
 return (async (url: string | URL | Request, init?: RequestInit) => {
  expect(String(url)).toBe("http://vision/v1/face-visibility");
  const body = init!.body as FormData;
  expect(JSON.parse(body.get("manifest") as string).items).toEqual([{id:"42",timestamp_seconds:210,file_field:"image_0"}]);
  return Response.json({version:"1",items:[{id:"42",timestamp_seconds:210,width:160,height:90,outcomes:[error ? {capability:"face_visibility",status:"error",error:{code:"VISIBILITY_UNAVAILABLE",message:""}} : {capability:"face_visibility",status:"ok",findings:[{capability:"face_visibility",label:"visibility",score:0,box:{space:"normalized",x1:0,y1:0,x2:0,y2:0},metadata}]}]}]});
 }) as unknown as typeof fetch;
}
describe("shared numeric face visibility", () => {
 it("binds actual global index/timestamp and retains observed absence without identity data", async () => {
  const adapter = new HttpRecordingFaceVisibilityAdapter({baseUrl:"http://vision",fetch:transport({...policy,detected:false,max_confidence:0})});
  const result = await adapter.observe(input,new AbortController().signal);
  expect(result.frames).toEqual([{index:42,timestamp:210,detected:false,max_confidence:0,policy}]);
  expect(JSON.stringify(result)).not.toContain('"embedding":');
 });
 it("keeps detector errors unknown rather than face-zero", async () => {
  const adapter = new HttpRecordingFaceVisibilityAdapter({baseUrl:"http://vision",fetch:transport(null,true)});
  const result = await adapter.observe(input,new AbortController().signal);
  expect(result.frames[0]!.detected).toBeNull();expect(result.policy).toBeNull();
 });
 it("records the CPU detector as the provider; a second face GPU session froze the host", async () => {
  const adapter = new HttpRecordingFaceVisibilityAdapter({baseUrl:"http://vision",fetch:transport({...policy,detected:false,max_confidence:0})});
  const result = await adapter.observe(input,new AbortController().signal);
  expect(result.policy?.providers).toEqual(["CPUExecutionProvider"]);
 });
 it("rejects missing providers and wrong model receipts", async () => {
  for(const patch of [{providers:[]},{model_sha256:"b".repeat(64)}]) {
   const adapter = new HttpRecordingFaceVisibilityAdapter({baseUrl:"http://vision",fetch:transport({...policy,...patch,detected:false,max_confidence:0})});
   await expect(adapter.observe(input,new AbortController().signal)).rejects.toThrow();
  }
 });
 it("cancels before sending private tile bytes", async () => {
  const controller=new AbortController();controller.abort();let calls=0;
  const adapter=new HttpRecordingFaceVisibilityAdapter({baseUrl:"http://vision",fetch:(async()=>{calls++;return Response.json({});}) as unknown as typeof fetch});
  await expect(adapter.observe(input,controller.signal)).rejects.toThrow();expect(calls).toBe(0);
 });
});
