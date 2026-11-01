// Every URL the site links to, and how an old #/ link from the single-page site maps onto
// one. A Steam ID only ever reaches a path through isSteamId: one can arrive from the URL.
import {
  campaignOf,
  campaignOfBoard,
  campaignOfMap,
  eventOf,
  eventOfBoard,
  type Campaign,
} from "./campaigns";
import { PFID, STEAM_ID, isSteamId, mapPfidOf } from "./rules";
import type { ShareKind } from "./share";

/* where the site is served: link previews and links posted outside it start here */
export const SITE_ORIGIN = "https://ballestrecords.com";

export const PLAYER_TABS = ["circuit", "workshop", "made", "daily"] as const;
export type PlayerTab = (typeof PLAYER_TABS)[number];

/* an Overall board's slot for its podium order; a Steam ID is all digits, so they can't collide */
export const PODIUM_SORT = "podiums";

export const PL_SCOPES = ["all", "circuit", "workshop"] as const;
export type PlScope = (typeof PL_SCOPES)[number];
export const PL_SORTS = ["wr", "pod", "t5", "maps"] as const;
export type PlSort = (typeof PL_SORTS)[number];

/* what a path segment may be; the proxy and the pages check a path with the same ones */
const oneOf =
  <T extends string>(list: ReadonlyArray<T>) =>
  (s: string | undefined): s is T =>
    (list as ReadonlyArray<string | undefined>).includes(s);
export const isPlayerTab = oneOf(PLAYER_TABS);
export const isPlScope = oneOf(PL_SCOPES);
export const isPlSort = oneOf(PL_SORTS);

export const homeHref = () => "/";

export const playerHref = (id: string, tab?: string | null) =>
  isSteamId(id) ? "/player/" + id + (tab ? "/" + tab : "") : "/";

export const mapHref = (pfid: string, focus?: string | null) =>
  "/map/" + pfid + (focus && isSteamId(focus) ? "/" + focus : "");
/* a Map's file at one version, for its 3D view (app/map/[pfid]/file); the version in the
   address lets the response be cached for good */
export const MAP_FILE = "file";
export const mapFileHref = (pfid: string, version: string) =>
  mapHref(pfid) + "/" + MAP_FILE + "?v=" + encodeURIComponent(version);

/* a board, optionally with a player's row marked or (Overall) its podium order; a Map's
   board name turns into its /map/ link */
export function boardHref(name: string, slot?: string | null) {
  const pfid = mapPfidOf(name);
  if (pfid) return mapHref(pfid, slot);
  const tail = slot && (slot === PODIUM_SORT || isSteamId(slot)) ? "/" + slot : "";
  const campaign = campaignOfBoard(name);
  if (campaign) return campaignHref(campaign.slug) + tail;
  /* an Event board's page is its Campaign's slot for it, which takes a row after it */
  const event = eventOfBoard(name);
  const home = event && campaignOfMap(event.id);
  if (home)
    return campaignHref(home.campaign.slug, event.id) + (slot && isSteamId(slot) ? "/" + slot : "");
  return "/board/" + name + tail;
}

/* a Campaign's page: its Overall board, or one of its Maps inside its frame */
export const campaignHref = (slug: string, pfid?: string | null) =>
  "/campaign/" + slug + (pfid ? "/" + pfid : "");

/* an Event's own static page beside the site (EventBoard's viewer), such as /leth/ */
export const viewerHref = (folder: string) => "/" + folder + "/";

/* every Campaign, as banners */
export const campaignsHref = () => "/campaigns";

/* what follows a Campaign's slug in its path, or null for what can't: nothing (its Overall
   board), podiums (its podium order), one of its Maps (`map`, inside its frame) or a Steam
   ID whose row to mark (`focus`), on its board or, after an Event's id, on the Event's.
   Another Campaign's Map is shaped like a Steam ID, and is none. The proxy and the page both
   read a path through it. */
export function campaignSlot(
  c: Campaign,
  slot: string | null | undefined,
  row?: string | null,
): { map: string | null; focus: string | null; podiums: boolean } | null {
  const none = { map: null, focus: null, podiums: false };
  /* only an Event's slot takes a row after it: a Workshop Map's row is on its own page */
  if (row)
    return slot && c.maps.includes(slot) && eventOf(slot) && isSteamId(row)
      ? { ...none, map: slot, focus: row }
      : null;
  if (!slot) return none;
  if (slot === PODIUM_SORT) return { ...none, podiums: true };
  if (c.maps.includes(slot)) return { ...none, map: slot };
  return isSteamId(slot) && !campaignOfMap(slot) ? { ...none, focus: slot } : null;
}

/* the Campaign a path under /campaign/ names and what follows its slug (campaignSlot), or
   null for a path that is no Campaign's page */
export function campaignPath(path: string) {
  const m = /^\/campaign\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/.exec(path);
  const c = m && campaignOf(m[1]);
  const at = c && campaignSlot(c, m[2], m[3]);
  return c && at ? { c, ...at } : null;
}

export const vsHref = (a: string, b: string) =>
  isSteamId(a) && isSteamId(b) ? "/vs/" + a + "/" + b : "/";

/* the Prefabs gallery, a Prefab's page, its file (the download and what the viewer draws),
   and the upload form; a slug only ever reaches a path through isPrefabSlug */
export const PREFAB_SLUG = /[a-z0-9]+(?:-[a-z0-9]+)*/;
const WHOLE_PREFAB_SLUG = new RegExp(`^${PREFAB_SLUG.source}$`);
export const isPrefabSlug = (s: string | undefined): s is string =>
  !!s && s.length <= 64 && WHOLE_PREFAB_SLUG.test(s);
export const prefabsHref = () => "/prefabs";
export const newPrefabHref = () => "/prefabs/new";
/* How to: saving, spawning and sharing a Prefab, and decals */
export const prefabGuideHref = () => "/prefabs/guide";
/* Make your own and a Generator's page. GENERATORS in lib/generators/index.ts lists
   the same keys in the same order; they are kept apart so a page that only links one never
   loads them */
export const GENERATOR_KEYS = [
  "sign",
  "arrow",
  "pixel-art",
  "stairs",
  "bridge",
  "floor-tiles",
  "spiral",
  "loop",
  "jump",
  "plinko",
  "rollers",
  "lamp",
  "fountain",
  "trophy",
  "fence",
  "finish-arch",
  "tree",
  "pine",
  "block-tree",
  "bush",
  "house",
  "tower",
  "castle",
] as const;
export const isGeneratorKey = (k: string): k is (typeof GENERATOR_KEYS)[number] =>
  (GENERATOR_KEYS as ReadonlyArray<string>).includes(k);
export const makePrefabHref = () => "/prefabs/make";
export const generatorHref = (key: string) =>
  isGeneratorKey(key) ? "/prefabs/make/" + key : makePrefabHref();
export const prefabHref = (slug: string) => (isPrefabSlug(slug) ? "/prefab/" + slug : "/prefabs");

/* what the upload ping's admin buttons ask a Prefab's page to confirm (`?admin=`) */
export type AdminAction = "take-down" | "ban";
export const prefabAdminHref = (slug: string, action: AdminAction) =>
  `${prefabHref(slug)}?admin=${action}`;
/* the action a Prefab page's address asks for, or null */
export const adminActionOf = (search: string): AdminAction | null => {
  const want = new URLSearchParams(search).get("admin");
  return want === "take-down" || want === "ban" ? want : null;
};
/* the Prefab API (db/prefab-api.ts): uploading, a Prefab's file, favorite, edit and take
   down, and a player's upload ban and daily limit */
export const prefabsApiHref = () => "/api/prefabs";
export const prefabApiHref = (slug: string) => "/api/prefabs/" + slug;
export const prefabFileHref = (slug: string) => prefabApiHref(slug) + "/file";
/* its thumbnail, named by its last edit so a new angle isn't served from the CDN's old copy */
export const prefabThumbHref = (slug: string, updatedAt: string) =>
  `${prefabApiHref(slug)}/thumb?v=${String(Date.parse(updatedAt))}`;
export const prefabFavoriteHref = (slug: string) => prefabApiHref(slug) + "/favorite";
export const prefabTakeDownHref = (slug: string) => prefabApiHref(slug) + "/takedown";
export const prefabBanHref = (id: string) => (isSteamId(id) ? "/api/prefab-bans/" + id : null);
export const prefabLimitHref = (id: string) => (isSteamId(id) ? "/api/prefab-limits/" + id : null);
/* the Chosen Skin API (db/chosen-skin-api.ts): saving or clearing your own pick */
export const chosenSkinApiHref = () => "/api/me/skin";

export const mapsHref = (view?: string | null) => "/maps" + (view ? "/" + view : "");
/* All maps narrowed to the Maps whose title or maker contains `q` (the site search's "All N
   Maps matching") */
export const MAPS_QUERY = "q";
export const mapsSearchHref = (q: string) =>
  mapsHref() + "?" + new URLSearchParams({ [MAPS_QUERY]: q }).toString();

/* the site search's read (app/api/search) */
export const searchApiHref = (q: string) => "/api/search?" + new URLSearchParams({ q }).toString();

/* a Daily's date as its path names it: a real day, YYYY-MM-DD */
export const DAILY_DATE = /\d{4}-\d{2}-\d{2}/;
const WHOLE_DAILY_DATE = new RegExp(`^${DAILY_DATE.source}$`);
export function isDailyDate(s: string | undefined): s is string {
  if (!s || !WHOLE_DAILY_DATE.test(s)) return false;
  const t = new Date(s + "T00:00:00Z");
  return !Number.isNaN(t.getTime()) && t.toISOString().startsWith(s);
}

/* the Daily page on one day, or on the newest Daily */
export const dailyHref = (date?: string | null) =>
  "/daily" + (date && isDailyDate(date) ? "/" + date : "");

/* the all-time Daily standings; a date is never this, so the two can't collide */
export const DAILY_STANDINGS = "standings";
export const dailyStandingsHref = () => "/daily/" + DAILY_STANDINGS;

export const playersHref = (scope: PlScope, sort: PlSort) =>
  "/players" + (scope === "all" && sort === "wr" ? "" : "/" + scope + "/" + sort);

/* Where you stand: You on the four Workshop standings, reached from the Players tab */
export const youHref = () => "/you";

/* the sitemap robots.txt names (lib/sitemap.ts) */
export const sitemapHref = () => "/sitemap.xml";

/* Sign in with Steam (ADR 0008), coming back to the path `next` */
export const signInHref = (next: string) => "/api/auth/steam?next=" + encodeURIComponent(next);
/* sign out (a POST), coming back to the path `next` */
export const signOutHref = (next: string) => "/api/auth/signout?next=" + encodeURIComponent(next);

/* the link page for a link request Multiballs wrote (ADR 0014), and its confirm (a POST) */
export const statsLinkHref = (token: string) => "/discord/link?t=" + encodeURIComponent(token);
export const statsLinkConfirmHref = (token: string) =>
  "/api/discord/link?t=" + encodeURIComponent(token);

/* The single-page site's #/ routes, each to the path that replaces it, or null for a hash
   that named nothing (the page then stays where it is). */
const ID = STEAM_ID.source;
const LEGACY: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [new RegExp(`^#/player/(${ID})(?:/(${PLAYER_TABS.join("|")}))?$`), (m) => playerHref(m[1], m[2])],
  [new RegExp(`^#/vs/(${ID})/(${ID})$`), (m) => vsHref(m[1], m[2])],
  [
    new RegExp(`^#/players(?:/(${PL_SCOPES.join("|")})(?:/(${PL_SORTS.join("|")}))?)?$`),
    (m) =>
      playersHref(
        ((m[1] as string | undefined) ?? "all") as PlScope,
        ((m[2] as string | undefined) ?? "wr") as PlSort,
      ),
  ],
  [new RegExp(`^#/map/(${PFID.source})(?:/(${ID}))?$`), (m) => mapHref(m[1], m[2])],
  [/^#\/maps(?:\/([a-z]{1,12}))?$/, (m) => mapsHref(m[1])],
  [
    new RegExp(`^#/board/([A-Za-z0-9_]{1,64})(?:/(${ID}|${PODIUM_SORT}))?$`),
    (m) => boardHref(m[1], m[2]),
  ],
  [/^#\/?(workshop)?$/, () => homeHref()],
];

export function legacyPath(hash: string): string | null {
  for (const [re, to] of LEGACY) {
    const m = re.exec(hash);
    if (m) return to(m);
  }
  return null;
}

/* a page's share image (lib/share.ts); v is the latest Refresh (or a Prefab's later edit), so
   each is a new URL for crawlers that keep a picture by its URL (Discord, Slack, X) */
export const shareHref = (kind: ShareKind, id: string, version: number) =>
  `/og/${kind}/${id}?v=${String(version)}`;
