import { z } from "zod";

export interface Tag {
  id: number;
  name: string;
  parent_id: number | null;
  description: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export interface TagWithPath extends Tag {
  path: string; // "Genre > Action > Sci-Fi"
}

export interface TagTreeNode extends Tag {
  children: TagTreeNode[];
}

export interface ListTagsOptions {
  page?: number;
  limit?: number;
  search?: string;
  sort?: "name" | "created_at";
  order?: "asc" | "desc";
  tree?: boolean;
}

export interface PaginatedTags {
  data: Tag[] | TagTreeNode[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export const createTagSchema = z.object({
  name: z.string().min(1).max(255),
  parent_id: z.number().int().positive().nullable().optional(),
  description: z.string().max(2000).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color")
    .optional(),
});

export const updateTagSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  parent_id: z.number().int().positive().nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color")
    .nullable()
    .optional(),
});

export type CreateTagInput = z.infer<typeof createTagSchema>;
export type UpdateTagInput = z.infer<typeof updateTagSchema>;
