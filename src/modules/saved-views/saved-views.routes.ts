import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { savedViewsTable, usersTable } from "@/database/schema";
import { BadRequestError } from "@/utils/errors";
import { listVideosQuerySchema } from "@/modules/videos/videos.schemas";
import { getDemoSqlite, initializeDemoDatabase } from "@/database/demo/client";

export const savedViewSchema = z.object({
  id: z.uuid(), name: z.string().trim().min(1).max(80),
  filters: listVideosQuerySchema.strict().transform(({ page: _page, limit: _limit, include: _include, ...filters }) => filters),
});
const params = z.object({ id: z.uuid() });

export async function savedViewsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);
  app.get("/", async (request) => {
    const userId = request.user!.id;
    if (env.DEMO_MODE) {
      initializeDemoDatabase();
      const rows = getDemoSqlite().query("SELECT id, name, filters FROM demo_saved_library_views WHERE user_id = ? ORDER BY name").all(userId) as Array<{ id: string; name: string; filters: string }>;
      return { success: true, data: rows.map(row => ({ ...row, filters: JSON.parse(row.filters) })) };
    }
    const rows = await db.select({ id: savedViewsTable.id, name: savedViewsTable.name, filters: savedViewsTable.filters }).from(savedViewsTable).where(eq(savedViewsTable.userId, userId)).orderBy(savedViewsTable.name);
    return { success: true, data: rows };
  });
  app.put("/:id", { schema: { params, body: savedViewSchema } }, async (request) => {
    const userId = request.user!.id;
    const view = request.body;
    if (request.params.id !== view.id) throw new BadRequestError("View ID does not match.");
    if (env.DEMO_MODE) {
      initializeDemoDatabase();
      const sqlite = getDemoSqlite();
      sqlite.transaction(() => {
        const rows = sqlite.query("SELECT id FROM demo_saved_library_views WHERE user_id = ?").all(userId) as Array<{id: string}>;
        if (rows.length >= 50 && !rows.some(row => row.id === view.id)) throw new BadRequestError("You can save up to 50 views.");
        sqlite.query("INSERT INTO demo_saved_library_views (user_id,id,name,filters) VALUES (?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,filters=excluded.filters").run(userId, view.id, view.name, JSON.stringify(view.filters));
      })();
    } else {
      await db.transaction(async tx => {
        await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).for("update");
        const rows = await tx.select({ id: savedViewsTable.id }).from(savedViewsTable).where(eq(savedViewsTable.userId, userId));
        if (rows.length >= 50 && !rows.some(row => row.id === view.id)) throw new BadRequestError("You can save up to 50 views.");
        await tx.insert(savedViewsTable).values({ userId, ...view }).onConflictDoUpdate({ target: [savedViewsTable.userId, savedViewsTable.id], set: { name: view.name, filters: view.filters } });
      });
    }
    return { success: true, data: view };
  });
  app.delete("/:id", { schema: { params } }, async (request) => {
    if (env.DEMO_MODE) {
      initializeDemoDatabase();
      getDemoSqlite().query("DELETE FROM demo_saved_library_views WHERE user_id = ? AND id = ?").run(request.user!.id, request.params.id);
    } else {
      await db.delete(savedViewsTable).where(and(eq(savedViewsTable.userId, request.user!.id), eq(savedViewsTable.id, request.params.id)));
    }
    return { success: true, message: "Saved view removed" };
  });
}
