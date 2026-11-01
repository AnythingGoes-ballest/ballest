// The rules around Prefabs (GLOSSARY.md) the pages and the API share: the fixed tags, the
// gallery's order, a Prefab's link, and who may do what. The file itself is lib/prefab.ts and
// the upload check lib/prefab-check.ts.

/* the tags an uploader picks from (T1), up to MAX_TAGS */
export const TAGS = ["Decoration", "Obstacle", "Ramp", "Loop", "Scenery", "Structure"] as const;
export const MAX_TAGS = 3;

export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 500;
/* uploads per player in any hour, deleted ones included (R1), unless the admin gave them
   their own limit (prefab_limits), up to MAX_HOURLY_UPLOADS */
export const HOURLY_UPLOADS = 5;
export const MAX_HOURLY_UPLOADS = 1000;
export const UPLOAD_WINDOW_MS = 3_600_000;
/* the hearts, unhearts and edits a player may make in a rolling hour: plenty for browsing the
   gallery, few enough that one account can't keep expiring the cached Prefab reads
   (db/prefab-api.ts, ADR 0016) */
export const HOURLY_PREFAB_WRITES = 60;

/* what GET /api/prefabs tells the upload form: who may upload, how many more they may now
   of their hourly limit, and, at none, when the next frees up */
export interface UploadQuota {
  signedIn: boolean;
  banned: boolean;
  left: number;
  limit: number;
  nextAt: string | null;
}
/* the quota of a reader who may not upload: signed out, or banned */
export const NO_UPLOADS: UploadQuota = {
  signedIn: false,
  banned: false,
  left: 0,
  limit: 0,
  nextAt: null,
};

/* a player's hourly upload limit, and whether the admin gave it them or it is the default */
export interface UploaderLimit {
  steamId: string;
  perHour: number;
  own: boolean;
}

/* the site's admin (B2): Will, who can take any Prefab down and ban an uploader */
export const ADMIN_STEAM_ID = "76561198047685844";

export interface PrefabFields {
  name: string;
  description: string;
  tags: Array<string>;
}

/* a Prefab's name, description and tags as typed, trimmed, or every reason they can't be */
export function checkFields(
  raw: PrefabFields,
): { ok: true; fields: PrefabFields } | { ok: false; problems: Array<string> } {
  const name = raw.name.trim();
  const description = raw.description.trim();
  const tags = [...new Set(raw.tags)];
  const problems: Array<string> = [];
  if (!name) problems.push("Give it a name.");
  else if (Array.from(name).length > NAME_MAX)
    problems.push(`Keep the name to ${String(NAME_MAX)} characters.`);
  if (Array.from(description).length > DESCRIPTION_MAX)
    problems.push(`Keep the description to ${String(DESCRIPTION_MAX)} characters.`);
  if (tags.length > MAX_TAGS) problems.push(`Pick up to ${String(MAX_TAGS)} tags.`);
  for (const t of tags)
    if (!(TAGS as ReadonlyArray<string>).includes(t))
      problems.push(`${t.slice(0, 40)} isn't one of the tags.`);
  return problems.length
    ? { ok: false, problems }
    : { ok: true, fields: { name, description, tags } };
}

/* the view of a Prefab its uploader picked for its picture: the gallery card, the upload ping's
   still, and where its viewer starts and Reset view returns. It is relative to the Prefab's
   own bounds (centre and radius), so it frames the same at any picture size */
export interface PrefabAngle {
  /* from where the camera looks to the camera, unit length, in three's axes (y up) */
  from: Vec3;
  /* the camera's distance over the one that just fits the whole Prefab */
  zoom: number;
  /* where the camera looks, from the Prefab's centre, in radii */
  pan: Vec3;
}

type Vec3 = [number, number, number];

/* three-quarters from above, the whole Prefab in view: a Prefab with no angle of its own */
export const DEFAULT_ANGLE: PrefabAngle = {
  from: unit([1, 0.7, 1.2]),
  zoom: 1,
  pan: [0, 0, 0],
};

export const ZOOM_RANGE = [0.05, 20] as const;
export const PAN_MAX = 10;

function unit(v: Vec3): Vec3 {
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n];
}

/* an angle as sent, tidied to four places, or null when it can't be one */
export function checkAngle(raw: unknown): PrefabAngle | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { from, zoom, pan } = raw as Record<string, unknown>;
  const vec = (v: unknown): v is Vec3 =>
    Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && isFinite(x));
  if (!vec(from) || !vec(pan) || typeof zoom !== "number") return null;
  /* a direction too long to measure (its length overflows) would tidy to nothing */
  const length = Math.hypot(...from);
  if (!(length >= 1e-6 && isFinite(length))) return null;
  if (!(zoom >= ZOOM_RANGE[0] && zoom <= ZOOM_RANGE[1])) return null;
  if (pan.some((x) => Math.abs(x) > PAN_MAX)) return null;
  const r = (x: number) => Math.round(x * 1e4) / 1e4 || 0;
  return { from: unit(from).map(r) as Vec3, zoom: r(zoom), pan: pan.map(r) as Vec3 };
}

export type GallerySort = "popular" | "newest";

interface Sortable {
  favorites: number;
  createdAt: string;
  tags: Array<string>;
}

/* the gallery as shown: Popular is most favorited first with the newest breaking a tie,
   Newest is by upload; a tag keeps only the Prefabs carrying it */
export function galleryOf<T extends Sortable>(
  cards: ReadonlyArray<T>,
  sort: GallerySort,
  tag: string | null,
): Array<T> {
  const newest = (a: T, b: T) => b.createdAt.localeCompare(a.createdAt);
  return cards
    .filter((c) => !tag || c.tags.includes(tag))
    .sort((a, b) =>
      sort === "popular" ? b.favorites - a.favorites || newest(a, b) : newest(a, b),
    );
}

/* the game's list (ADR 0016) is read a page at a time: 50 unless it asks for up to 100 */
export const LIST_PAGE = 50;
export const LIST_MOST = 100;
const QUERY_MAX = 100;

export interface ListQuery {
  sort: GallerySort;
  tag: string | null;
  q: string;
  offset: number;
  limit: number;
}

/* what `?sort=&tag=&q=&cursor=&limit=` asks the game's list for, or null when a value
   can't be one: Popular unless it says newest, any tag from TAGS, words to look for, and
   the cursor a page before answered as `next` */
export function listQueryOf(params: URLSearchParams): ListQuery | null {
  const whole = (v: string | null, fallback: number) =>
    v === null ? fallback : /^\d{1,6}$/.test(v) ? Number(v) : NaN;
  const sort = params.get("sort") ?? "popular";
  const tag = params.get("tag");
  const q = (params.get("q") ?? "").trim();
  const offset = whole(params.get("cursor"), 0);
  const limit = whole(params.get("limit"), LIST_PAGE);
  if (sort !== "popular" && sort !== "newest") return null;
  if (tag !== null && !(TAGS as ReadonlyArray<string>).includes(tag)) return null;
  if (q.length > QUERY_MAX || Number.isNaN(offset) || !(limit >= 1 && limit <= LIST_MOST))
    return null;
  return { sort, tag, q, offset, limit };
}

interface Listable extends Sortable {
  name: string;
  description: string;
  uploader: { name: string };
}

/* one page of the game's list: the gallery's order and tag, kept to the Prefabs where every
   word of `q` is in the name, the description, a tag or the uploader's name, with how many
   match in all and the cursor of the page after (null at the end) */
export function listPageOf<T extends Listable>(
  cards: ReadonlyArray<T>,
  { sort, tag, q, offset, limit }: ListQuery,
): { total: number; next: number | null; page: Array<T> } {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const found = galleryOf(cards, sort, tag).filter((c) => {
    const text = [c.name, c.description, c.uploader.name, ...c.tags].join("\n").toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const end = offset + limit;
  return {
    total: found.length,
    next: end < found.length ? end : null,
    page: found.slice(offset, end),
  };
}

/* a Prefab's link from its first name: lower case, every other run of characters a dash */
export function slugOf(name: string) {
  const stem = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return stem || "prefab";
}
