import { pgTable, integer, text, jsonb, primaryKey } from "drizzle-orm/pg-core";
import { usersTable } from "./users.schema";
export const savedViewsTable = pgTable("saved_library_views", {
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  name: text("name").notNull(),
  filters: jsonb("filters").notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.id] })]);
