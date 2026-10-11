import { describe, expect, it } from "bun:test";
import { validateVersionPreference } from "@/modules/recordings/recordings.version-versus";
const side = (best: [number, number]) => ({video_id: 1, clip: [0, 1800], best, previews: [0.1,0.5,0.9].map((fraction) => {const mid=best[0]+fraction*(best[1]-best[0]);return [mid-7.5,mid+7.5]})});
const context = () => ({blind_version_comparison: true, target_semantics: "preferred_version_if_keep_one", a: side([0,1800]), b: side([300,900])});
const viewed = () => ({a:{preview_started:[0,1],preview_completed:[0],full_opened:false,full_completed:false}});
describe("isolated version preferences", () => {
 it("allows a choice without manufacturing cut or acceptability labels", () => {expect(()=>validateVersionPreference(context(),null)).not.toThrow();expect(()=>validateVersionPreference(context(),{viewing:viewed()})).not.toThrow()});
 it("accepts neutral public metadata without legacy analysis labels", () => {const c=context();const neutral=(s:ReturnType<typeof side>)=>({video_id:s.video_id,original_range:s.clip,best:s.best,preview_windows:s.previews});expect(()=>validateVersionPreference({...c,target_semantics:undefined,target:"preferred_version_if_keep_one",a:neutral(c.a),b:neutral(c.b)},null)).not.toThrow()});
 it("rejects legacy cuts and incorrect task target", () => {expect(()=>validateVersionPreference(context(),{best:{}})).toThrow();expect(()=>validateVersionPreference({...context(),target_semantics:"current_keep_acceptability"},null)).toThrow()});
 it("requires the same recording and original range", () => {const c=context();c.b.video_id=2;expect(()=>validateVersionPreference(c,null)).toThrow();const d=context();d.b.clip=[5,1800];expect(()=>validateVersionPreference(d,null)).toThrow()});
 it("bounds all preview windows inside the exact version and equal budget", () => {const c=context();c.b.previews[0]=[200,220];expect(()=>validateVersionPreference(c,null)).toThrow();const d=context();d.a.previews=d.a.previews.slice(1);expect(()=>validateVersionPreference(d,null)).toThrow()});
 it("rejects nonfinite geometry and preview coverage claims", () => {const c=context();c.b.best=[300,NaN];expect(()=>validateVersionPreference(c,null)).toThrow();const v=viewed();v.a.preview_completed=[2];expect(()=>validateVersionPreference(context(),{viewing:v})).toThrow();v.a.preview_completed=[0];v.a.preview_started=[0,0];expect(()=>validateVersionPreference(context(),{viewing:v})).toThrow()});
 it("matches immutable intake by rejecting extra metadata fields", () => {expect(()=>validateVersionPreference(context(),{other:true})).toThrow();expect(()=>validateVersionPreference(context(),{viewing:{a:{...viewed().a,other:true}}})).toThrow()});
 it("requires full opening before player completion", () => {const v=viewed();v.a.full_completed=true;expect(()=>validateVersionPreference(context(),{viewing:v})).toThrow()});
});
