import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

mock.module("@/config/env", () => ({ env: { DEMO_MODE: true } }));
const { registerProviderRoutes } = await import("@/modules/enrichment/enrichment.providers");
let app: FastifyInstance;
let calls = 0;
const previousFetch = globalThis.fetch;

beforeAll(async () => {
  globalThis.fetch = (() => { calls++; throw new Error("Demo must never fetch metadata providers"); }) as unknown as typeof fetch;
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ message: String(error) }));
  registerProviderRoutes(app);
  await app.ready();
});
afterAll(async () => { await app.close(); globalThis.fetch = previousFetch; });

describe("isolated demo metadata providers", () => {
  it("lists providers and installed demo scrapers without network", async () => {
    const list = await app.inject({ method: "GET", url: "/providers" });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.providers.some((p: { id: string }) => p.id === "fansdb")).toBe(true);
    const scrapers = await app.inject({ method: "GET", url: "/stash/scrapers" });
    expect(scrapers.json().data[0].performer.supported_scrapes).toContain("URL");
    expect(calls).toBe(0);
  });
  it("keeps provider secrets write-only and only simulates explicit drafts", async () => {
    const configured = await app.inject({ method: "PATCH", url: "/providers/fansdb", payload: { api_key: "never-expose-test-secret", enabled: true } });
    expect(configured.statusCode).toBe(200);
    expect(configured.body).not.toContain("never-expose-test-secret");
    const list = await app.inject({ method: "GET", url: "/providers" });
    expect(list.body).not.toContain("never-expose-test-secret");
    const payload = { entity_type: "creator", stash_id: "42", source: "fansdb" };
    const preview = await app.inject({ method: "POST", url: "/stash/contributions/prepare", payload });
    expect(preview.json().data.ready).toBe(true);
    const unconfirmed = await app.inject({ method: "POST", url: "/stash/contributions/submit", payload });
    expect(unconfirmed.statusCode).toBe(400);
    const submitted = await app.inject({ method: "POST", url: "/stash/contributions/submit", payload: { ...payload, confirm: true } });
    expect(submitted.json().data).toEqual({ draft_id: "demo-creator-42", demo: true });
    expect(calls).toBe(0);
  });
});
