import { existsSync } from "node:fs";
export interface VrThumbnailDependencies {
  artwork: () => Promise<Array<{ id: number; variant: string }>>;
  assetPath: (id: number) => Promise<string>;
  legacyPath: () => Promise<string | null>;
  exists?: (path: string) => boolean;
}
/** Prefer curated raster artwork. A missing render can fall back without generating or editing anything. */
export async function resolveVrThumbnail(
  deps: VrThumbnailDependencies
): Promise<string | null> {
  const exists = deps.exists ?? existsSync;
  const assets = await deps.artwork();
  for (const variant of ["card", "poster", "square", "hero"]) {
    for (const asset of assets.filter((asset) => asset.variant === variant)) {
      const path = await deps.assetPath(asset.id);
      if (exists(path)) return path;
    }
  }
  const path = await deps.legacyPath();
  return path && exists(path) ? path : null;
}
// Valid PNG supported by native image decoders; SVG placeholders are not portable to headset players.
export const VR_PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAACJklEQVR4nO3TQQkAMAzAwMoozL/PedhnBA5OQD6Z3QNEzfcC4JmBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQdgFUfu7QIiFfqAAAAABJRU5ErkJggg==",
  "base64"
);
