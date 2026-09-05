import type { TaggingRuleCondition } from "./tagging-rules.types";

export interface RuleVideo {
  id: number;
  file_path: string;
  file_name: string;
  duration_seconds: number | null;
  file_size_bytes: number;
  width: number | null;
  height: number | null;
  codec: string | null;
}

function compare(actual: number, operator: string, expected: number): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  switch (operator) {
    case "equals":
      return actual === expected;
    case "gt":
      return actual > expected;
    case "gte":
      return actual >= expected;
    case "lt":
      return actual < expected;
    case "lte":
      return actual <= expected;
    default:
      return false;
  }
}

/** Compile once per rule/batch; both storage adapters share OR semantics and units. */
export function compileConditions(conditions: TaggingRuleCondition[]) {
  const predicates = conditions.map((condition) => {
    const { condition_type: type, operator, value } = condition;
    const label = `${type} ${operator} ${value}`;
    let regex: RegExp | undefined;
    if (operator === "matches" || operator === "regex") {
      try {
        regex = new RegExp(value, "i");
      } catch {
        /* Legacy invalid expressions never match. */
      }
    }
    return (
      video: RuleVideo
    ): { label: string; captures: Record<string, string> } | null => {
      const actual =
        type === "path_pattern"
          ? video.file_path
          : type === "file_pattern"
            ? video.file_name
            : type === "duration_range"
              ? video.duration_seconds
              : type === "file_size"
                ? video.file_size_bytes
                : type === "resolution"
                  ? video.height
                  : video.codec;
      if (actual == null) return null;
      let matched = false;
      let captures: Record<string, string> = {};
      if (typeof actual === "number") {
        const resolution = value.trim().toLowerCase();
        const target =
          type === "resolution"
            ? Number(
                resolution === "4k"
                  ? 2160
                  : resolution === "8k"
                    ? 4320
                    : resolution.replace(/p$/, "")
              )
            : Number(value);
        matched = value.trim().length > 0 && compare(actual, operator, target);
      } else if (operator === "equals") {
        matched = actual.toLowerCase() === value.toLowerCase();
      } else if (operator === "contains") {
        matched = actual.toLowerCase().includes(value.toLowerCase());
      } else if (regex) {
        const result = regex.exec(actual);
        matched = result !== null;
        if (type === "path_pattern" || type === "file_pattern")
          captures = result?.groups ?? {};
      }
      return matched ? { label, captures } : null;
    };
  });
  return (video: RuleVideo) => {
    const matchedConditions: string[] = [];
    const captures: Record<string, string> = {};
    for (const predicate of predicates) {
      const match = predicate(video);
      if (match) {
        matchedConditions.push(match.label);
        Object.assign(captures, match.captures);
      }
    }
    return { matchedConditions, captures };
  };
}
