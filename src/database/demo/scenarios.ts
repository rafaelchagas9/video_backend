export type DemoContentAnalysisScenario =
  | "empty"
  | "singleton"
  | "typical"
  | "dense"
  | "stress";

const CONTENT_ANALYSIS_SCENARIOS: ReadonlyArray<{
  scenario: DemoContentAnalysisScenario;
  label: string;
}> = [
  { scenario: "empty", label: "Empty analysis" },
  { scenario: "singleton", label: "Single analysis moment" },
  { scenario: "typical", label: "Typical analysis moments" },
  { scenario: "dense", label: "Dense analysis moments" },
  { scenario: "stress", label: "Stress-test analysis moments" },
];

export function demoContentAnalysisScenarioForSource(
  sourceVideoId: number | null
): DemoContentAnalysisScenario {
  if (!sourceVideoId || sourceVideoId < 1) return "typical";
  return CONTENT_ANALYSIS_SCENARIOS[sourceVideoId - 1]?.scenario ?? "typical";
}

export function demoContentAnalysisScenarioLabel(
  sourceVideoId: number | null
): string | null {
  if (!sourceVideoId || sourceVideoId < 1) return null;
  return CONTENT_ANALYSIS_SCENARIOS[sourceVideoId - 1]?.label ?? null;
}
