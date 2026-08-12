import { describe, expect, it } from "bun:test";
import type { FastifyRequest } from "fastify";
import { shouldTrackRequestMetrics } from "@/utils/telemetry";

function request(url: string): FastifyRequest {
  return { method: "GET", url } as FastifyRequest;
}

describe("telemetry request filtering", () => {
  it("ignores multiplayer pending-request polling", () => {
    expect(
      shouldTrackRequestMetrics(
        request("/api/multiplayer-remote/sessions/80/join-requests/pending")
      )
    ).toBe(false);
  });
});
