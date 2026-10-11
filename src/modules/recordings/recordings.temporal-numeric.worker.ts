/** Finite numeric worker: low-memory heap, no media, network or database access. */
import { createHash } from "node:crypto";
import { classifyFrames, type HighlightProbe } from "./recordings.probe";
import { selectTemporalControl } from "./recordings.temporal-control";
import type { ModelProposal, ModelFrames } from "./recordings.model";
import type { OfferedPreferenceHead } from "./recordings.offered-preference";
declare const self: {onmessage:(event:MessageEvent)=>void;postMessage:(data:unknown)=>void};
self.onmessage = (event: MessageEvent<{head:OfferedPreferenceHead;probe:HighlightProbe;frames:ModelFrames;proposals:ModelProposal[];duration:number}>) => {
  try {
    const {head,probe,frames,proposals,duration}=event.data;
    if (frames.vectors.length > 8000) throw new Error("Unsupported numeric frame count");
    const h=createHash("sha256").update("temporal_raw_f32_frames_f64_timestamps_v1\n");
    h.update(Buffer.from(Float64Array.from(frames.timestamps).buffer));
    for (const v of frames.vectors) { const norm=Math.sqrt(v.reduce((sum,x)=>sum+x*x,0)); if (Math.abs(norm-1)>.02) throw new Error("Nonunit fixed state embeddings"); h.update(Buffer.from(v.buffer,v.byteOffset,v.byteLength)); }
    const probabilities=classifyFrames(probe,frames.vectors), controls=proposals.filter(p=>p.end_seconds-p.start_seconds>=180).map(p=>({p,...selectTemporalControl(head,{originalProposalId:p.id,proposals,recordingDuration:duration,frames})}));
    self.postMessage({controls,probabilities,frameHash:h.digest("hex")});
  } catch (error) { self.postMessage({error:error instanceof Error?error.message:"Numeric cut inference failed"}); }
};
