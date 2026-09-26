/**
 * Demo scans replay real matches — a scene (`enrichment-scene-sample.json`) or
 * a creator: the pending proposals of one real performer
 * match (`demo_mode/enrichment-sample.json` — 133 proposals: pictures, a long
 * tail of studio model pages, vitals, aliases) so the review UI is judged at
 * the volume real creators produce, offline.
 *
 * The sample's pictures are stripped from the fixture; each picture slot is
 * filled with the scanned creator's own demo art, repeating as needed, so demo
 * mode never shows a real performer's images.
 */

import { readFileSync } from "fs";
import { join } from "path";

export interface DemoScanRow {
  type: string;
  field_key: string | null;
  value: string;
  source: string;
  source_url: string | null;
  raw: Record<string, unknown>;
  dedup: string;
}

interface SampleProposal {
  type: string;
  field_key?: string;
  value?: string;
  source?: string;
  source_url?: string;
  raw?: Record<string, unknown>;
}

const samples = new Map<string, SampleProposal[]>();

function loadSample(file: string): SampleProposal[] {
  let sample = samples.get(file);
  if (!sample) {
    sample = (
      JSON.parse(readFileSync(join(process.cwd(), "demo_mode", file), "utf8")) as {
        proposals: SampleProposal[];
      }
    ).proposals;
    samples.set(file, sample);
  }
  return sample;
}

/** `pictures` are URLs of the creator's own demo art; they repeat to fill every slot. */
export function demoCreatorScan(pictures: string[]): DemoScanRow[] {
  return replay("enrichment-sample.json", "creator", "Lilly Bell", pictures);
}

/** A real scene match (43 tags, cast, studio, details); covers become the video's own art. */
export function demoSceneScan(pictures: string[]): DemoScanRow[] {
  return replay("enrichment-scene-sample.json", "scene", "Kinky Chemistry", pictures);
}

function replay(file: string, entityType: string, name: string, pictures: string[]): DemoScanRow[] {
  const proposals = loadSample(file);
  const externalId = proposals.find((item) => item.type === "external_id")?.value ?? null;
  const match = { name, source: "theporndb", entity_type: entityType, external_id: externalId };
  let picture = 0;

  return proposals.flatMap((item, index): DemoScanRow[] => {
    const value = item.type === "image" ? pictures[picture++ % Math.max(pictures.length, 1)] : item.value;
    if (!value) return [];
    return [
      {
        type: item.type,
        field_key: item.field_key ?? null,
        value,
        source: item.source ?? "theporndb",
        source_url: item.source_url ?? null,
        // Related-entity proposals keep their own source/external_id beside the match.
        raw: { ...item.raw, match },
        dedup: `sample-${index}`,
      },
    ];
  });
}
