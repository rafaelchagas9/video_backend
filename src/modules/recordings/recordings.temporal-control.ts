/** Pure generic old-C control selection and its fixed outcome-free face sampling. */
import { parseOfferedPreferenceHead, scoreOfferedPreference, type OfferedPreferenceHead, type OfferedVersionInput } from "./recordings.offered-preference";
import type { TemporalRange } from "./recordings.temporal-preference";

export type TemporalControlInput = Omit<OfferedVersionInput, "offeredRange">;
export interface TemporalControl { range: [number, number]; score: number }
const finite = (value: number) => Number.isFinite(value);
function roundToEven(value: number): number {
  const low = Math.floor(value), fraction = value - low;
  return fraction < .5 ? low : fraction > .5 ? low + 1 : low % 2 === 0 ? low : low + 1;
}
/** Reference-free counterpart of Python generic_grid; no duration cap or second-best selection. */
function grid(original: TemporalRange): Array<[number, number]> {
  const [a, b] = original, span = b - a;
  if (![a, b, span].every(finite) || a < 0 || span < 180) throw new Error("Temporal control needs a finite original of at least 180 seconds");
  const ranges = new Map<string, [number, number]>();
  const add = (start: number, length: number) => {
    start = Math.max(a, Math.min(start, b - length));
    const range: [number, number] = [start, start + length];
    ranges.set(JSON.stringify(range), range);
  };
  for (const length of new Set([180, 300, 600, 900, span])) {
    if (length > span) continue;
    for (let j = 0; j < 16; j++) add(a + 5 * roundToEven(((span - length) * j / 16) / 5), length);
    add(b - length, length); // The last endpoint is exact, not snapped.
  }
  ranges.set(JSON.stringify(original), [a, b]);
  if (ranges.size > 128) throw new Error("Temporal control candidate grid exceeds bound");
  return Array.from(ranges.values()).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}
/** Caller owns head/source pin verification. This function does not load, fit or activate models. */
export function selectTemporalControl(rawHead: OfferedPreferenceHead | unknown, input: TemporalControlInput): TemporalControl {
  const head = parseOfferedPreferenceHead(rawHead);
  const originals = input.proposals.filter(row => row.id === input.originalProposalId);
  if (originals.length !== 1) throw new Error("Exact unique original proposal required for temporal control");
  const original = originals[0]!, candidates = grid([original.start_seconds, original.end_seconds]);
  let best: TemporalControl | null = null;
  for (const range of candidates) {
    const score = scoreOfferedPreference(head, { ...input, offeredRange: range });
    if (!best || score > best.score || (score === best.score && (range[1] - range[0] < best.range[1] - best.range[0] || (range[1] - range[0] === best.range[1] - best.range[0] && range[0] < best.range[0])))) best = { range, score };
  }
  if (!best) throw new Error("Temporal control has no supported candidate");
  return best;
}

/** Inclusive uniform points with NumPy linspace(...).astype(int) truncation, not rounding. */
export function temporalFaceSampleIndices(timestamps: readonly number[] | Float32Array | Float64Array, original: TemporalRange, control: TemporalRange): number[] {
  if (!timestamps.length || timestamps.length > 8000 || Array.from(timestamps).some((time, i) => !finite(time) || time < 0 || (i > 0 && time <= timestamps[i - 1]!))) throw new Error("Bounded ordered finite temporal timeline required");
  if (original.length !== 2 || control.length !== 2 || ![...original, ...control].every(finite) || !(0 <= original[0] && original[0] <= control[0] && control[0] < control[1] && control[1] <= original[1])) throw new Error("Legal inclusive original and control ranges required");
  const sample = (bounds: TemporalRange, count: number) => {
    const ids: number[] = [];
    for (let i = 0; i < timestamps.length; i++) if (bounds[0] <= timestamps[i]! && timestamps[i]! <= bounds[1]) ids.push(i);
    if (!ids.length) throw new Error("Temporal sample range has no observed indexed points");
    const size = Math.min(count, ids.length);
    if (size === 1) return [ids[0]!];
    const step = (ids.length - 1) / (size - 1), selected: number[] = [];
    for (let j = 0; j < size; j++) selected.push(ids[j === size - 1 ? ids.length - 1 : Math.trunc(j * step)]!);
    return selected;
  };
  return Array.from(new Set([...sample(original, 72), ...sample(control, 24)])).sort((a, b) => a - b);
}
