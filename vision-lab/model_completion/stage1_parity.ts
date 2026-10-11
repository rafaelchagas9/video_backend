import { readFile } from 'node:fs/promises';
import { detectWithProbe, isLikelySkip } from '../../src/modules/recordings/recordings.highlights';
import { loadHighlightProbe, probeThreshold, type ProbeState } from '../../src/modules/recordings/recordings.probe';
const fixture=JSON.parse(await readFile(process.argv[2]!, 'utf8'));
const probe=await loadHighlightProbe(fixture.candidate);
if(!probe)throw new Error('candidate schema failed production loader');
const outputs=[];
for(const sample of fixture.samples){
 const bytes=await readFile(sample.vectors);const flat=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);
 const vectors=Array.from({length:sample.timestamps.length},(_,i)=>flat.slice(i*probe.dimension,(i+1)*probe.dimension));
 for(const duration of sample.durations){
  const result=detectWithProbe({timestamps:sample.timestamps,vectors,durationSeconds:duration,probe,states:fixture.states as ProbeState[],threshold:probeThreshold(fixture.sensitivity)});
  outputs.push({sample:sample.sample,duration,clips:result.clips.map(clip=>({...clip,keep:!isLikelySkip(clip)})),curve:result.curve});
 }
}
process.stdout.write(JSON.stringify({production_schema_validated:true,threshold:probeThreshold(fixture.sensitivity),outputs}));
