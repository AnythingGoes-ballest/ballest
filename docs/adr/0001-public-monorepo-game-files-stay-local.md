# Public monorepo, but the map-making kit stays a separate private repo

The Ballest community tools (the leaderboard site, its collector, the Leth viewer, and
the Discord bot) live in one public repo. The map-making kit is left out and stays a
private repo of its own. It commits level dumps and screenshots extracted from the
game's paks, which are the developers' assets, and merging it here would publish them,
even if they were only in its history.

## Considered Options

- Merging the kit and gitignoring its game-derived files: the kit only works with those
  files, and its history would still have to be rewritten or dropped.
- Making the monorepo private: loses free GitHub Pages hosting.

## Measurements may come here (2026-10-17)

Numbers measured from the game's assets may be committed here; the assets themselves may
not. Will agreed to this for the Prefab viewer's stand-ins (#241): each piece's bounds
(`lib/prefab-meshes.ts`) and, for curved pieces, a coarse outline of a few dozen points
per view, stored as thousandths of those bounds (`lib/prefab-profiles.ts`). They're traced
from the mesh renders in the private kit by its `extract/piece_profiles.py`, and the
viewer builds its own shape from them. Meshes, textures, and the renders and in-game
screenshots made from them stay in the kit.

Since 2026-11-04 the outlines of the meshes a game update adds are traced from the meshes' own
triangles instead, by `web/scripts/prefab-pieces.ts`, from the piece catalogue the kit's
`extract/pieces/` reads from the game's packages. The source changes, not what comes in: each
mesh's bounds and, for a curved one, a coarse outline per view in thousandths of them. The
triangles and the catalogue stay local, in the kit.
