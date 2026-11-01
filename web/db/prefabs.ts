// Prefabs in the site's database (ADR 0009): the reads behind a Prefab's page and the gallery,
// and the writes the API routes make. Each takes the database it works on, so the tests can
// run it against a throwaway one. Results are plain JSON, because db/data.ts caches the reads.
import { sql, type SQL } from "drizzle-orm";

import { slugOf, type PrefabAngle } from "../lib/prefabs";
import type { Db } from "./client";
import { prefabs } from "./schema";

/* the database, or a transaction on it */
export type Conn = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

async function rows<T>(db: Conn, query: SQL): Promise<Array<T>> {
  return (await db.execute(query)).rows as Array<T>;
}

export interface Uploader {
  steamId: string;
  name: string;
  /* whether the boards have seen them, so the byline can link their player page */
  isPlayer: boolean;
}

/* live, or why it reads as gone: deleted by its uploader, taken down by the admin, or
   hidden while its uploader is banned */
export type PrefabState = "live" | "deleted" | "taken-down" | "hidden";

export interface PrefabView {
  state: PrefabState;
  slug: string;
  name: string;
  description: string;
  tags: Array<string>;
  uploader: Uploader;
  file: string;
  pieces: number;
  bytes: number;
  favorites: number;
  createdAt: string;
  /* when it was uploaded or last edited, which names its share image anew */
  updatedAt: string;
  /* the view its uploader picked for its picture, or null for the default */
  angle: PrefabAngle | null;
}

export interface NewPrefab {
  name: string;
  description: string;
  tags: Array<string>;
  uploader: string;
  uploaderName: string | null;
  file: string;
  angle?: PrefabAngle | null;
  /* now, unless a test says otherwise */
  createdAt?: Date;
}

/* store a Prefab under the first free slug its name gives */
export async function addPrefab(db: Conn, p: NewPrefab): Promise<{ slug: string }> {
  const base = slugOf(p.name);
  const taken = new Set(
    (
      await rows<{ slug: string }>(
        db,
        sql`select slug from prefabs where slug = ${base} or slug ~ ${`^${base}-[0-9]+$`}`,
      )
    ).map((r) => r.slug),
  );
  const row = {
    ...p,
    updatedAt: p.createdAt,
    pieces: (JSON.parse(p.file) as { items: Array<unknown> }).items.length,
    bytes: Buffer.byteLength(p.file),
  };
  /* a slug taken between the read and the insert (two uploads of one name at once) moves
     on to the next */
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${String(n)}`;
    if (taken.has(slug)) continue;
    const added = await db
      .insert(prefabs)
      .values({ ...row, slug })
      .onConflictDoNothing({ target: prefabs.slug })
      .returning({ id: prefabs.id });
    if (added.length) return { slug };
  }
}

/* a Prefab as the gallery and its page show it, its uploader named from the boards when
   they have raced, else by their Steam persona when they uploaded */
const VIEW = sql`
  case
    when p.deleted_at is not null then 'deleted'
    when p.taken_down_at is not null then 'taken-down'
    when exists (select 1 from prefab_bans b where b.steam_id = p.uploader) then 'hidden'
    else 'live'
  end as state,
  p.slug, p.name, p.description, p.tags, p.pieces, p.bytes, p.angle,
  to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
  to_char(p.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt",
  json_build_object(
    'steamId', p.uploader,
    'name', coalesce(pl.persona, p.uploader_name, p.uploader),
    'isPlayer', pl.steam_id is not null
  ) as uploader,
  (select count(*)::int from prefab_favorites f where f.prefab_id = p.id) as favorites`;

/* a Prefab by its slug, whatever its state, or null for one nobody uploaded */
export async function prefabOf(db: Db, slug: string): Promise<PrefabView | null> {
  const found = await rows<PrefabView>(
    db,
    sql`select ${VIEW}, p.file
      from prefabs p left join players pl on pl.steam_id = p.uploader
      where p.slug = ${slug}`,
  );
  return found.at(0) ?? null;
}

/* VIEW reads the description too, which the game's list searches and shows */
export type PrefabCard = Omit<PrefabView, "file">;

/* a Prefab anyone can see: not deleted, not taken down, its uploader not banned */
export const LIVE = sql`p.deleted_at is null and p.taken_down_at is null
  and not exists (select 1 from prefab_bans b where b.steam_id = p.uploader)`;

/* every live Prefab, newest first: not deleted, not taken down, its uploader not banned */
export async function prefabList(db: Db): Promise<Array<PrefabCard>> {
  return rows<PrefabCard>(
    db,
    sql`select ${VIEW}
      from prefabs p left join players pl on pl.steam_id = p.uploader
      where ${LIVE}
      order by p.created_at desc, p.id desc`,
  );
}
