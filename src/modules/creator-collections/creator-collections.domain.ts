import { z } from "zod";
import { ConflictError, ValidationError } from "@/utils/errors";

const ids = z
  .array(z.number().int().positive())
  .max(500)
  .refine((v) => new Set(v).size === v.length, "Choose each item only once");
export const collectionInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(""),
  release_date: z.iso.date().nullable().default(null),
  source_url: z
    .url()
    .refine((v) => /^https?:/.test(v))
    .nullable()
    .default(null),
  gallery_ids: ids.default([]),
  video_ids: ids.default([]),
});
export const collectionSchema = collectionInput.extend({
  id: z.string().uuid(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  removed_gallery_ids: z.array(z.number().int().positive()).default([]),
  removed_video_ids: z.array(z.number().int().positive()).default([]),
});
export const collectionDocument = z.object({
  revision: z.number().int().nonnegative(),
  sets: z.array(collectionSchema),
});
export type CollectionInput = z.infer<typeof collectionInput>;
export type CreatorCollection = z.infer<typeof collectionSchema>;
export type CollectionDocument = z.infer<typeof collectionDocument>;
export function updateCollectionDocument(
  document: CollectionDocument,
  input: CollectionInput,
  revision: number,
  members: { gallery: Set<number>; videos: Set<number> },
  id?: string,
  now = new Date().toISOString()
): CollectionDocument {
  if (document.revision !== revision)
    throw new ConflictError(
      "This creator's collections changed. Reload before saving."
    );
  const previous = id ? document.sets.find((v) => v.id === id) : undefined;
  if (id && !previous) throw new ValidationError("Collection no longer exists");
  // Previously selected members may disappear between opening and saving. Keep
  // their IDs in history, while rejecting newly introduced foreign members.
  const knownGallery = new Set(previous?.gallery_ids ?? []);
  const knownVideos = new Set(previous?.video_ids ?? []);
  if (
    input.gallery_ids.some(
      (v) => !members.gallery.has(v) && !knownGallery.has(v)
    )
  )
    throw new ValidationError(
      "Every image must belong to this creator's gallery"
    );
  if (
    input.video_ids.some((v) => !members.videos.has(v) && !knownVideos.has(v))
  )
    throw new ValidationError(
      "Every video must be associated with this creator"
    );
  if (!id && document.sets.length >= 200)
    throw new ValidationError("A creator can have up to 200 collections");
  const next = {
    ...input,
    gallery_ids: input.gallery_ids.filter((v) => members.gallery.has(v)),
    video_ids: input.video_ids.filter((v) => members.videos.has(v)),
    removed_gallery_ids: [
      ...new Set([
        ...(previous?.removed_gallery_ids ?? []),
        ...(previous?.gallery_ids ?? []).filter((v) => !members.gallery.has(v)),
      ]),
    ].filter((v) => !input.gallery_ids.includes(v) || !members.gallery.has(v)),
    removed_video_ids: [
      ...new Set([
        ...(previous?.removed_video_ids ?? []),
        ...(previous?.video_ids ?? []).filter((v) => !members.videos.has(v)),
      ]),
    ].filter((v) => !input.video_ids.includes(v) || !members.videos.has(v)),
    id: previous?.id ?? crypto.randomUUID(),
    created_at: previous?.created_at ?? now,
    updated_at: now,
  };
  return {
    revision: revision + 1,
    sets: previous
      ? document.sets.map((v) => (v.id === id ? next : v))
      : [...document.sets, next],
  };
}

/** Drop one set. Its gallery pictures and films are untouched; only the edition goes. */
export function removeCollection(
  document: CollectionDocument,
  revision: number,
  id: string
): CollectionDocument {
  if (document.revision !== revision)
    throw new ConflictError(
      "This creator's collections changed. Reload before saving."
    );
  if (!document.sets.some((v) => v.id === id))
    throw new ValidationError("Collection no longer exists");
  return {
    revision: revision + 1,
    sets: document.sets.filter((v) => v.id !== id),
  };
}

/** Reconcile for display without writing or advancing the user's revision. */
export function reconcileCollectionDocument(
  document: CollectionDocument,
  members: { gallery: Set<number>; videos: Set<number> }
): CollectionDocument {
  return {
    ...document,
    sets: document.sets.map((set) => ({
      ...set,
      gallery_ids: set.gallery_ids.filter((v) => members.gallery.has(v)),
      video_ids: set.video_ids.filter((v) => members.videos.has(v)),
      removed_gallery_ids: [
        ...new Set([
          ...set.removed_gallery_ids,
          ...set.gallery_ids.filter((v) => !members.gallery.has(v)),
        ]),
      ],
      removed_video_ids: [
        ...new Set([
          ...set.removed_video_ids,
          ...set.video_ids.filter((v) => !members.videos.has(v)),
        ]),
      ],
    })),
  };
}

/** Keep target editions first and source editions in their original order. */
export function mergeCollectionDocuments(
  target: CollectionDocument,
  source: CollectionDocument,
  galleryIds?: Map<number, number>
): CollectionDocument {
  const targetIds = new Set(target.sets.map((set) => set.id));
  if (source.sets.some((set) => targetIds.has(set.id)))
    throw new ConflictError(
      "Collection IDs overlap; resolve the duplicate edition before merging creators"
    );
  return {
    revision: Math.max(target.revision, source.revision) + 1,
    sets: [
      ...target.sets,
      ...source.sets.map((set) => ({
        ...set,
        gallery_ids: galleryIds
          ? set.gallery_ids.flatMap((id) =>
              galleryIds.has(id) ? [galleryIds.get(id)!] : []
            )
          : set.gallery_ids,
        removed_gallery_ids: [
          ...new Set([
            ...set.removed_gallery_ids,
            ...(galleryIds
              ? set.gallery_ids.filter((id) => !galleryIds.has(id))
              : []),
          ]),
        ],
      })),
    ],
  };
}
