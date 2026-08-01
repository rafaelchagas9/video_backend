# Artwork fonts

The artwork title renderer uses local, static instances so output does not
depend on fonts installed on the host:

- `Figtree-Display.ttf`: Figtree at `wght=560`. The current title face, matching
  the clients' "Broadcast" display pairing. 560 is not one of Figtree's named
  instances — it is pinned to exactly that value because the live HTML title
  treatment is set in `font-[560]`, and the baked and live paths have to be the
  same weight or swapping between them shifts the page.
- `Fraunces-Display.ttf`: Fraunces at `wght=380`, `opsz=144`, `SOFT=0`,
  `WONK=0`. Kept for the "Canon" pairing.
- `Archivo-Regular.ttf`: Archivo at `wght=400`, `wdth=100`, used as the
  fallback face.

All were instantiated from the matching variable fonts,
downloaded from the official [Google Fonts repository](https://github.com/google/fonts).
Their SIL Open Font License 1.1 texts are stored alongside the font files.

Which face is used is configuration, not code — see `ARTWORK_TITLE_FONT_PATH`
and `ARTWORK_TITLE_FONT_FAMILY`. Changing it means regenerating existing title
assets, because they are baked.
