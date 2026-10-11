/** Synthetic numeric parity against the actual Bun production classifier; no DB/media. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { classifyFrames, loadHighlightProbe } from '../../src/modules/recordings/recordings.probe';
const fixture = JSON.parse(readFileSync(0,'utf8')) as { synthetic_only: boolean; probe_path: string; probe_sha256: string; vectors: number[][] };
if (!fixture.synthetic_only || fixture.vectors.length !== 15 || fixture.vectors.some(v=>v.length!==1152 || v.some(x=>!Number.isFinite(x)))) throw new Error('Exactly fifteen synthetic numeric frames required');
if (createHash('sha256').update(readFileSync(fixture.probe_path)).digest('hex') !== fixture.probe_sha256) throw new Error('Probe pin differs');
const probe = await loadHighlightProbe(fixture.probe_path);
if (!probe) throw new Error('Actual production probe loader rejected fixed artifact');
console.log(JSON.stringify({ classes: probe.classes, probabilities: classifyFrames(probe,fixture.vectors.map(v=>Float32Array.from(v))).map(v=>Array.from(v)) }));
