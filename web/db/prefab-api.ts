// The Prefab API (ADR 0009): each route under app/api/prefabs is one call here, from a
// Request to its Response, so the tests can make the same calls against a throwaway
// database. Every write checks the Sign in with Steam session (lib/auth.ts) and refuses a
// request another site sent. `deps` carries the database and what the tests stand in for:
// the session's secret and clock, the upload ping, the uploader's Steam persona, and the cache
// to expire after a write.
import { and, eq, isNull, sql } from "drizzle-orm";

import { isCrossSite, prefabSessionOf, sessionOf, type AuthEnv } from "../lib/auth";
import { checkPrefab } from "../lib/prefab-check";
import {
  ADMIN_STEAM_ID,
  HOURLY_PREFAB_WRITES,
  HOURLY_UPLOADS,
  MAX_HOURLY_UPLOADS,
  NO_UPLOADS,
  UPLOAD_WINDOW_MS,
  checkAngle,
  checkFields,
  type PrefabAngle,
  type PrefabFields,
  type UploadQuota,
  type UploaderLimit,
} from "../lib/prefabs";
import { isSteamId } from "../lib/rules";
import type { Db } from "./client";
import { spendHourly, type Bucket } from "./hourly-limit";
import { discordPing, type PrefabPing } from "./prefab-ping";
import { LIVE, addPrefab, prefabOf, type Conn } from "./prefabs";
import { prefabBans, prefabLimits, prefabs } from "./schema";

export interface PrefabDeps {
  db: Db;
  auth?: AuthEnv;
  /* tells the Prefabs Discord channel about an upload */
  ping?: (p: PrefabPing) => Promise<void>;
  /* a Steam ID's persona on Steam, or null */
  persona?: (steamId: string) => Promise<string | null>;
  /* expires the cached Prefab reads */
  changed?: () => void;
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "private, no-store" } });

/* the hourly upload limit the admin gave `steamId`, or null when they have the default */
async function ownLimitOf(db: Conn, steamId: string): Promise<number | null> {
  const { rows } = await db.execute(
    sql`select per_hour from prefab_limits where steam_id = ${steamId}`,
  );
  return (rows as Array<{ per_hour: number }>).at(0)?.per_hour ?? null;
}

/* how many uploads `steamId` has left now, of their limit, and, at none, when the next frees up */
async function quotaOf(db: Conn, steamId: string, now: number) {
  const limit = (await ownLimitOf(db, steamId)) ?? HOURLY_UPLOADS;
  const since = new Date(now - UPLOAD_WINDOW_MS).toISOString();
  const { rows } = await db.execute(sql`
    select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at
    from prefabs where uploader = ${steamId} and created_at > ${since}
    order by created_at`);
  const times = (rows as Array<{ at: string }>).map((r) => r.at);
  const left = Math.max(0, limit - times.length);
  const oldest = times.at(-limit);
  return {
    left,
    limit,
    nextAt: left || !oldest ? null : new Date(Date.parse(oldest) + UPLOAD_WINDOW_MS).toISOString(),
  };
}

async function isBanned(db: Conn, steamId: string) {
  const { rows } = await db.execute(sql`select 1 from prefab_bans where steam_id = ${steamId}`);
  return rows.length > 0;
}

/* why `steamId` can't upload now, banned or over their hourly limit, or null when they can */
async function refusalOf(db: Conn, steamId: string, at: number) {
  if (await isBanned(db, steamId)) return { status: 403 as const };
  const quota = await quotaOf(db, steamId, at);
  return quota.left ? null : { status: 429 as const, limit: quota.limit, nextAt: quota.nextAt };
}

/* GET /api/prefabs: what the upload form tells the reader before they start */
export async function uploadQuota(request: Request, deps: PrefabDeps): Promise<Response> {
  const id = prefabSessionOf(request, deps.auth);
  const quota: UploadQuota = !id
    ? NO_UPLOADS
    : (await isBanned(deps.db, id))
      ? { ...NO_UPLOADS, signedIn: true, banned: true }
      : { signedIn: true, banned: false, ...(await quotaOf(deps.db, id, now(deps))) };
  return json(quota);
}

const now = (deps: PrefabDeps) => deps.auth?.now ?? Date.now();

/* the PNG signature, and the most a preview still may weigh */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_PICTURE_BYTES = 1_000_000;

/* the preview still the upload form sends, or null when there is none, it isn't a PNG, or
   it is too big; it is only ever shown to the admin in Discord */
async function pictureOf(v: FormDataEntryValue | null): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!(v instanceof Blob) || v.size > MAX_PICTURE_BYTES) return null;
  const bytes = new Uint8Array(await v.arrayBuffer());
  return PNG.every((b, i) => bytes[i] === b) ? bytes : null;
}

/* an angle as sent: null for none (the default), undefined for one that can't be an angle */
const angleOf = (v: unknown) => (v === null ? null : (checkAngle(v) ?? undefined));
const parsed = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
const BAD_ANGLE = "That view can't be saved. Pick it again.";

/* the upload form's fields, or null when the body isn't one; the file's size is the upload
   check's to refuse (Vercel caps a request body at 4.5 MB before it gets here) */
async function formOf(request: Request): Promise<
  | (PrefabFields & {
      file: string;
      picture: Uint8Array<ArrayBuffer> | null;
      angle: PrefabAngle | null | undefined;
    })
  | null
> {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const text = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : "";
    };
    if (!(file instanceof Blob)) return null;
    return {
      name: text("name"),
      description: text("description"),
      tags: form.getAll("tags").filter((v) => typeof v === "string"),
      file: await file.text(),
      picture: await pictureOf(form.get("picture")),
      angle: text("angle") ? angleOf(parsed(text("angle"))) : null,
    };
  } catch {
    return null;
  }
}

/* POST /api/prefabs: the upload form. Live at once (U2), so the admin gets a ping; refused signed
   out, from another site, banned, over the hourly limit, or with a file or fields that fail
   their checks */
export async function uploadPrefab(request: Request, deps: PrefabDeps): Promise<Response> {
  if (isCrossSite(request)) return json({ error: "cross-site" }, 403);
  const id = prefabSessionOf(request, deps.auth);
  if (!id) return json({ error: "sign in with Steam to upload" }, 401);
  const form = await formOf(request);
  if (!form) return json({ problems: ["That upload didn't arrive whole. Try again."] }, 400);
  const file = checkPrefab(form.file);
  const fields = checkFields(form);
  if (!file.ok || !fields.ok || form.angle === undefined)
    return json(
      {
        problems: [
          ...(file.ok ? [] : file.problems),
          ...(fields.ok ? [] : fields.problems),
          ...(form.angle === undefined ? [BAD_ANGLE] : []),
        ],
      },
      400,
    );
  /* a banned or spent uploader is refused before Steam is asked for their persona, and asked
     again under the lock, for an upload that raced this one */
  const early = await refusalOf(deps.db, id, now(deps));
  const uploaderName = early ? null : await (deps.persona ?? steamPersona)(id).catch(() => null);
  const result =
    early ??
    (await deps.db.transaction(async (tx) => {
      /* one upload at a time per player, so two at once can't both take the last slot */
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"prefab-upload:" + id}))`);
      const refused = await refusalOf(tx, id, now(deps));
      if (refused) return refused;
      const { slug } = await addPrefab(tx, {
        ...fields.fields,
        uploader: id,
        uploaderName,
        file: form.file,
        angle: form.angle,
        createdAt: new Date(now(deps)),
      });
      return { status: 201 as const, slug };
    }));
  if (result.status === 403) return json({ error: "you can't upload prefabs" }, 403);
  if (result.status === 429)
    return json(
      {
        error: "that's your uploads for the last hour",
        limit: result.limit,
        nextAt: result.nextAt,
      },
      429,
    );
  deps.changed?.();
  const name = (await prefabOf(deps.db, result.slug))?.uploader.name;
  await (deps.ping ?? discordPing)({
    slug: result.slug,
    name: fields.fields.name,
    pieces: file.pieces,
    tags: fields.fields.tags,
    uploader: { steamId: id, name: name ?? id },
    picture: form.picture,
  }).catch((e: unknown) => console.warn("prefab ping failed:", e));
  return json({ slug: result.slug }, 201);
}

/* a Steam ID's persona from its public community profile, or null */
export async function steamPersona(steamId: string): Promise<string | null> {
  const r = await fetch(`https://steamcommunity.com/profiles/${steamId}/?xml=1`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!r.ok) return null;
  const m = /<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/.exec(await r.text());
  return m?.[1].trim().slice(0, 64) || null; // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing -- an empty persona is none
}

const WRITES_SPENT = "that's your hearts and edits for the last hour";

/* a heart added or taken back, or an edit: each expires the cached Prefab reads */
const PREFAB_WRITES: Bucket = { name: "prefab-write", perKey: HOURLY_PREFAB_WRITES };

/* thrown inside a write's transaction to roll the write back when its spend is refused */
class Spent extends Error {}

/* makes `write` in one transaction, which says whether it changed anything; a change spends
   one of `steamId`'s hourly writes, and with none left it is rolled back. "same" when
   nothing changed, so it cost nothing */
async function spendingWrite(
  db: Db,
  steamId: string,
  at: number,
  write: (tx: Conn) => Promise<boolean>,
): Promise<"changed" | "same" | "spent"> {
  try {
    return await db.transaction(async (tx) => {
      if (!(await write(tx))) return "same";
      if (!(await spendHourly(tx, PREFAB_WRITES, steamId, at))) throw new Spent();
      return "changed";
    });
  } catch (e) {
    if (e instanceof Spent) return "spent";
    throw e;
  }
}

/* a live Prefab's id and uploader by its slug, or null: deleted, taken down and hidden
   ones can't be hearted or edited */
async function liveOf(db: Conn, slug: string): Promise<{ id: number; uploader: string } | null> {
  const { rows } = await db.execute(
    sql`select p.id, p.uploader from prefabs p where p.slug = ${slug} and ${LIVE}`,
  );
  return (rows as Array<{ id: number; uploader: string }>).at(0) ?? null;
}

/* GET, PUT and DELETE /api/prefabs/<slug>/favorite: whether the reader has hearted it and
   how many have; PUT hearts it, DELETE takes the heart back. Signed out, GET only counts */
export async function favoritePrefab(
  request: Request,
  deps: PrefabDeps,
  slug: string,
): Promise<Response> {
  const write = request.method !== "GET";
  if (write && isCrossSite(request)) return json({ error: "cross-site" }, 403);
  const id = prefabSessionOf(request, deps.auth);
  if (write && !id) return json({ error: "sign in with Steam to favorite" }, 401);
  const prefab = (await liveOf(deps.db, slug))?.id;
  if (prefab === undefined) return json({ error: "no such prefab" }, 404);
  if (id && write) {
    /* a heart added or taken back counts against the player's hourly writes and expires the
       cached reads; one that changes nothing, such as the same heart sent twice at once,
       costs neither */
    const done = await spendingWrite(deps.db, id, now(deps), async (tx) => {
      const { rowCount } = await tx.execute(
        request.method === "PUT"
          ? sql`insert into prefab_favorites (prefab_id, steam_id) values (${prefab}, ${id})
                on conflict do nothing`
          : sql`delete from prefab_favorites where prefab_id = ${prefab} and steam_id = ${id}`,
      );
      return (rowCount ?? 0) > 0;
    });
    if (done === "spent") return json({ error: WRITES_SPENT }, 429);
    if (done === "changed") deps.changed?.();
  }
  const { rows } = await deps.db.execute(sql`
    select count(*)::int as favorites, coalesce(bool_or(steam_id = ${id ?? ""}), false) as on
    from prefab_favorites where prefab_id = ${prefab}`);
  return json((rows as Array<{ on: boolean; favorites: number }>)[0]);
}

/* PATCH /api/prefabs/<slug> with { name, description, tags } and or { angle }: the uploader
   edits what the gallery and page say, or the view its picture is drawn from (null for the
   default); the file and the link stay. Each edit counts against the uploader's hourly hearts
   and edits. DELETE: the uploader deletes it, whatever they have left, since it happens once;
   its row stays, so it still counts against their hourly upload limit, and its page reads
   gone. Either is made only while the Prefab is still live when it lands */
export async function editPrefab(
  request: Request,
  deps: PrefabDeps,
  slug: string,
): Promise<Response> {
  if (isCrossSite(request)) return json({ error: "cross-site" }, 403);
  const id = prefabSessionOf(request, deps.auth);
  if (!id) return json({ error: "sign in with Steam" }, 401);
  const prefab = await liveOf(deps.db, slug);
  if (!prefab) return json({ error: "no such prefab" }, 404);
  if (prefab.uploader !== id) return json({ error: "only its uploader can change it" }, 403);
  const at = new Date(now(deps)).toISOString();
  if (request.method === "DELETE") {
    const { rowCount } = await deps.db.execute(
      sql`update prefabs p set deleted_at = ${at} where p.id = ${prefab.id} and ${LIVE}`,
    );
    if (!rowCount) return json({ error: "no such prefab" }, 404);
    deps.changed?.();
    return json({ deleted: slug });
  }
  const sent: unknown = await request.json().catch(() => null);
  const body =
    typeof sent === "object" && sent !== null
      ? (sent as Partial<PrefabFields> & { angle?: unknown })
      : null;
  const set: Partial<typeof prefabs.$inferInsert> = { updatedAt: new Date(at) };
  /* a body with an angle and none of the words leaves the words as they are */
  const words =
    !body || !("angle" in body) || ["name", "description", "tags"].some((k) => k in body);
  if (words) {
    const fields = checkFields({
      name: typeof body?.name === "string" ? body.name : "",
      description: typeof body?.description === "string" ? body.description : "",
      tags: Array.isArray(body?.tags) ? body.tags.filter((t) => typeof t === "string") : [],
    });
    if (!fields.ok) return json({ problems: fields.problems }, 400);
    Object.assign(set, fields.fields);
  }
  if (body && "angle" in body) {
    const angle = angleOf(body.angle);
    if (angle === undefined) return json({ problems: [BAD_ANGLE] }, 400);
    set.angle = angle;
  }
  const edited = await spendingWrite(deps.db, id, now(deps), async (tx) => {
    /* still live as it lands: an edit racing a take-down, a ban or its own delete changes
       nothing */
    const done = await tx
      .update(prefabs)
      .set(set)
      .where(
        and(
          eq(prefabs.id, prefab.id),
          isNull(prefabs.deletedAt),
          isNull(prefabs.takenDownAt),
          sql`not exists (select 1 from prefab_bans b where b.steam_id = ${prefabs.uploader})`,
        ),
      )
      .returning({ id: prefabs.id });
    return done.length > 0;
  });
  if (edited === "spent") return json({ error: WRITES_SPENT }, 429);
  if (edited === "same") return json({ error: "no such prefab" }, 404);
  deps.changed?.();
  return json({ slug });
}

/* the admin's Steam ID when the request is theirs, from this site; else the refusal */
function asAdmin(request: Request, deps: PrefabDeps): string | Response {
  if (isCrossSite(request)) return json({ error: "cross-site" }, 403);
  const id = sessionOf(request, deps.auth);
  if (!id) return json({ error: "sign in with Steam" }, 401);
  if (id !== ADMIN_STEAM_ID) return json({ error: "only the admin can do that" }, 403);
  return id;
}

/* POST /api/prefabs/<slug>/takedown: the admin takes a Prefab down (B1). Its row stays,
   stamped, and its page reads gone */
export async function takeDownPrefab(
  request: Request,
  deps: PrefabDeps,
  slug: string,
): Promise<Response> {
  const admin = asAdmin(request, deps);
  if (admin instanceof Response) return admin;
  const at = new Date(now(deps));
  const done = await deps.db
    .update(prefabs)
    .set({ takenDownAt: at })
    .where(and(eq(prefabs.slug, slug), isNull(prefabs.takenDownAt)))
    .returning({ id: prefabs.id });
  if (!done.length) return json({ error: "no such prefab" }, 404);
  deps.changed?.();
  return json({ takenDown: slug });
}

/* PUT /api/prefab-bans/<steam_id>: the admin stops a player uploading, which hides every
   Prefab they uploaded; DELETE lifts the ban and brings them back (B1) */
export async function banUploader(
  request: Request,
  deps: PrefabDeps,
  steamId: string,
): Promise<Response> {
  const admin = asAdmin(request, deps);
  if (admin instanceof Response) return admin;
  if (!isSteamId(steamId)) return json({ error: "not a Steam ID" }, 400);
  if (steamId === admin) return json({ error: "you can't ban yourself" }, 400);
  if (request.method === "DELETE")
    await deps.db.delete(prefabBans).where(eq(prefabBans.steamId, steamId));
  else
    await deps.db
      .insert(prefabBans)
      .values({ steamId, bannedBy: admin, bannedAt: new Date(now(deps)) })
      .onConflictDoNothing();
  deps.changed?.();
  return json({ steamId, banned: request.method !== "DELETE" });
}

/* the { perHour } a PUT sends, if it is a whole number the admin may set */
function perHourOf(body: unknown): number | null {
  const perHour = (body as { perHour?: unknown } | null)?.perHour;
  return typeof perHour === "number" &&
    Number.isInteger(perHour) &&
    perHour >= 1 &&
    perHour <= MAX_HOURLY_UPLOADS
    ? perHour
    : null;
}

/* GET /api/prefab-limits/<steam_id>: the player's hourly upload limit; PUT with { perHour } gives
   them their own, DELETE puts them back on the default. The admin's only */
export async function limitUploader(
  request: Request,
  deps: PrefabDeps,
  steamId: string,
): Promise<Response> {
  const admin = asAdmin(request, deps);
  if (admin instanceof Response) return admin;
  if (!isSteamId(steamId)) return json({ error: "not a Steam ID" }, 400);
  if (request.method === "DELETE")
    await deps.db.delete(prefabLimits).where(eq(prefabLimits.steamId, steamId));
  if (request.method === "PUT") {
    const perHour = perHourOf(await request.json().catch(() => null));
    if (perHour === null)
      return json({ error: `a whole number from 1 to ${String(MAX_HOURLY_UPLOADS)}` }, 400);
    const row = { perHour, setBy: admin, setAt: new Date(now(deps)) };
    await deps.db
      .insert(prefabLimits)
      .values({ steamId, ...row })
      .onConflictDoUpdate({ target: prefabLimits.steamId, set: row });
  }
  const own = await ownLimitOf(deps.db, steamId);
  return json({
    steamId,
    perHour: own ?? HOURLY_UPLOADS,
    own: own !== null,
  } satisfies UploaderLimit);
}
