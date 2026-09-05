import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { TaggingRule } from "@/modules/tagging-rules/tagging-rules.types";

const video = {
  id: 1,
  file_path: "/library/Creator/clip.mp4",
  file_name: "clip.mp4",
  duration_seconds: 120,
  file_size_bytes: 2048,
  width: 1920,
  height: 1080,
  codec: "h264",
};
const database = { execute: mock(async () => [video]) };
mock.module("@/config/drizzle", () => ({ db: database }));
mock.module("@/modules/studios/studio-assignment.service", () => ({
  studioAssignmentService: {},
}));
mock.module("@/modules/videos/videos.related.service", () => ({
  videosRelatedService: {},
}));
const { TaggingRulesService } =
  await import("@/modules/tagging-rules/tagging-rules.service");
const { listQuerySchema, applyRulesSchema } =
  await import("@/modules/tagging-rules/tagging-rules.schemas");
const rule: TaggingRule = {
  id: 1,
  name: "Rule",
  description: null,
  rule_type: "metadata_match",
  is_enabled: true,
  priority: 0,
  created_at: "",
  updated_at: "",
  actions: [
    {
      id: 1,
      rule_id: 1,
      action_type: "add_tag",
      target_id: 1,
      target_name: null,
      dynamic_value: null,
    },
  ],
};
let service: InstanceType<typeof TaggingRulesService>;
beforeEach(() => {
  service = new TaggingRulesService();
  database.execute.mockClear();
});

describe("tagging rule preview metadata", () => {
  for (const [condition_type, operator, value] of [
    ["duration_range", "gte", "120"],
    ["file_size", "gt", "1024"],
    ["resolution", "equals", "1080p"],
    ["resolution", "gte", "720p"],
    ["codec", "equals", "H264"],
  ] as const) {
    it(`matches ${condition_type} ${operator} using indexed metadata`, async () => {
      service.findById = async () => ({
        ...rule,
        conditions: [{ id: 1, rule_id: 1, condition_type, operator, value }],
      });
      expect((await service.testRule(1)).matched).toBe(1);
    });
  }
  it("does not interpret unsupported resolution operators as negation", async () => {
    service.findById = async () => ({
      ...rule,
      conditions: [
        {
          id: 1,
          rule_id: 1,
          condition_type: "resolution",
          operator: "contains",
          value: "720p",
        },
      ],
    });
    expect((await service.testRule(1)).matched).toBe(0);
  });
  it("does not expand an explicit empty video selection to the library", async () => {
    service.list = async () => [rule];
    expect(
      (await service.applyRules({ video_ids: [], dry_run: true })).processed
    ).toBe(0);
    expect(database.execute).not.toHaveBeenCalled();
  });
  it("parses the false query value as false", () => {
    expect(
      listQuerySchema.parse({ include_disabled: "false" }).include_disabled
    ).toBe(false);
  });
  it("rejects a string dry_run instead of silently treating it as true", () => {
    expect(applyRulesSchema.safeParse({ dry_run: "false" }).success).toBe(
      false
    );
  });
});
