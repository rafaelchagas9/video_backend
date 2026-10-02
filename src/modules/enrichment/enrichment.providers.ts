import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { env } from "@/config/env";
import { AppError, BadRequestError } from "@/utils/errors";
import { getEnrichmentClient } from "./enrichment.client";

const providerPatch = z
  .object({
    name: z.string().min(1).max(100).optional(),
    kind: z.enum(["stashbox", "stash"]).optional(),
    endpoint: z.union([z.httpUrl(), z.literal("")]).optional(),
    enabled: z.boolean().optional(),
    api_key: z.string().max(8192).optional(),
    dialect: z.enum(["stashbox", "tpdb", "standard"]).optional(),
    auth_style: z.enum(["apikey", "bearer"]).optional(),
  })
  .strict();
const contribution = z
  .object({
    entity_type: z.enum(["creator", "scene"]).default("creator"),
    stash_id: z.string().min(1).max(255),
    source: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    confirm: z.boolean().default(false),
  })
  .strict();
const idParams = z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) });

type ProviderDescriptor = {
  id: string;
  name: string;
  kind: "stashbox" | "stash";
  endpoint: string;
  enabled: boolean;
  configured: boolean;
  dialect: string;
  auth_style: string;
  capabilities: string[];
};

// Demo management is isolated in memory and never reaches Python or disk.
const demoProviders: ProviderDescriptor[] = [
  {
    id: "theporndb",
    name: "ThePornDB",
    kind: "stashbox",
    endpoint: "https://theporndb.net/graphql",
    enabled: true,
    configured: true,
    dialect: "tpdb",
    auth_style: "bearer",
    capabilities: ["creator", "scene", "fingerprints"],
  },
  {
    id: "stashdb",
    name: "StashDB",
    kind: "stashbox",
    endpoint: "https://stashdb.org/graphql",
    enabled: true,
    configured: true,
    dialect: "stashbox",
    auth_style: "apikey",
    capabilities: ["creator", "scene", "fingerprints"],
  },
  {
    id: "fansdb",
    name: "FansDB",
    kind: "stashbox",
    endpoint: "https://fansdb.cc/graphql",
    enabled: false,
    configured: false,
    dialect: "standard",
    auth_style: "apikey",
    capabilities: ["creator", "scene", "fingerprints"],
  },
  {
    id: "stash",
    name: "Stash local",
    kind: "stash",
    endpoint: "http://127.0.0.1:9999/graphql",
    enabled: true,
    configured: true,
    dialect: "stashbox",
    auth_style: "apikey",
    capabilities: [
      "creator_url",
      "scene_url",
      "scrapers",
      "fingerprints",
      "contribution_drafts",
    ],
  },
];

export function registerProviderRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.get(
    "/providers",
    {
      schema: {
        tags: ["enrichment"],
        summary: "List configured metadata providers without credentials",
      },
    },
    async () => ({
      success: true,
      data: env.DEMO_MODE
        ? {
            providers: demoProviders,
            bridge: {
              configured: demoProviders.some(
                (p) => p.kind === "stash" && p.configured
              ),
            },
            demo: true,
          }
        : await getEnrichmentClient().request("/providers"),
    })
  );
  app.patch(
    "/providers/:id",
    { schema: { params: idParams, body: providerPatch, tags: ["enrichment"] } },
    async (request) => {
      const body = request.body;
      if (body.endpoint) {
        const url = new URL(body.endpoint);
        if (url.username || url.password || url.search || url.hash)
          throw new BadRequestError(
            "Use an endpoint without embedded credentials or query parameters"
          );
      }
      let data: unknown;
      if (env.DEMO_MODE) {
        const current = demoProviders.find((p) => p.id === request.params.id);
        const { api_key, ...publicPatch } = body;
        const provider: ProviderDescriptor = {
          id: request.params.id,
          name: request.params.id,
          kind: "stashbox",
          endpoint: "",
          enabled: false,
          configured: false,
          dialect: "standard",
          auth_style: "apikey",
          capabilities: ["creator", "scene", "fingerprints"],
          ...current,
          ...publicPatch,
        };
        if (api_key !== undefined)
          provider.configured = Boolean(api_key && provider.endpoint);
        if (provider.kind === "stash")
          provider.configured = Boolean(provider.endpoint);
        if (current) Object.assign(current, provider);
        else demoProviders.push(provider);
        data = provider;
      } else
        data = await getEnrichmentClient().request(
          `/providers/${request.params.id}`,
          "PATCH",
          body
        );
      return { success: true, data };
    }
  );
  app.get(
    "/stash/scrapers",
    { schema: { tags: ["enrichment"] } },
    async () => ({
      success: true,
      data: env.DEMO_MODE
        ? [
            {
              id: "demo-profiles",
              name: "Creator profiles (demo)",
              performer: {
                urls: ["https://example.com/creators/"],
                supported_scrapes: ["URL"],
              },
              scene: null,
            },
          ]
        : await getEnrichmentClient().request("/stash/scrapers"),
    })
  );
  for (const operation of ["prepare", "submit"] as const) {
    app.post(
      `/stash/contributions/${operation}`,
      { schema: { body: contribution, tags: ["enrichment"] } },
      async (request) => {
        if (operation === "submit" && !request.body.confirm)
          throw new BadRequestError(
            "Explicit confirmation is required to submit a draft"
          );
        let data: unknown;
        if (env.DEMO_MODE) {
          const provider = demoProviders.find(
            (p) => p.id === request.body.source && p.kind === "stashbox"
          );
          if (!provider?.configured)
            throw new AppError(
              409,
              "Configure the target metadata source first"
            );
          data =
            operation === "submit"
              ? {
                  draft_id: `demo-${request.body.entity_type}-${request.body.stash_id}`,
                  demo: true,
                }
              : {
                  entity: {
                    id: request.body.stash_id,
                    name: "Demo creator",
                    title: "Demo scene",
                    urls: ["https://example.com/profile"],
                    details: "Synthetic contribution preview",
                  },
                  source: request.body.source,
                  ready: true,
                  issues: [],
                  demo: true,
                };
        } else
          data = await getEnrichmentClient().request(
            `/stash/contributions/${operation}`,
            "POST",
            request.body
          );
        return { success: true, data };
      }
    );
  }
}
