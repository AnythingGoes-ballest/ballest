// The read layer the pages call: the queries in site.ts over this server's database, each
// cached with "use cache: remote" under DATA_TAG for as long as nothing revalidates it.
// Remote, because a page or API call rendered at request time runs on whichever serverless
// instance takes it, and plain "use cache" keeps entries in that instance's memory only:
// every new instance would read the Workshop, the derived boards and the rest again. Pages stay
// static between Refreshes, and POST /api/revalidate (which the collector calls once a
// Refresh lands) expires them all at once. A cache entry's key includes the build, so a
// preview's entries never mix with another deploy's.
//
// Only what a page shows unasked is cached; a search is read fresh, since its keys would
// never repeat. What a reader can name in a URL (a player, a Map, a slice of a board) is
// checked against what exists, or read in fixed blocks, before its data is cached, so a
// script walking made-up IDs or offsets can only add an empty answer per ID, never a
// record. The check is per ID because a cache entry comes back whole on every read: a
// list of every player or Map read to look up one costs its full size each time.
import { cacheLife, cacheTag, revalidateTag } from "next/cache";

import {
  CAMPAIGNS,
  campaignBoard,
  campaignOf,
  campaignOfBoard,
  EVENTS,
  eventOf,
  mapLabel,
  type Campaign,
} from "../lib/campaigns";
import { CIRCUIT, circuitBoard } from "../lib/circuit";
import { boardHistory, type BoardHistory } from "../lib/history";
import { playerRecord, type IndexBoard, type PlayerRecord } from "../lib/player";
import { podiumTallies, tally, type PodiumTally } from "../lib/podiums";
import { isPfid, mapPfidOf } from "../lib/rules";
import type {
  BoardPage,
  DailyCell,
  DailyDay,
  DailyStandings,
  BoardRow,
  PlayerCampaignRow,
  PlayerDailies,
  WorkshopMap,
  WorkshopStandings,
} from "../lib/rows";
import type { CampaignStanding } from "../lib/share";
import { mapCard, timed, trendCard, trending, type MapCard, type TrendCard } from "../lib/workshop";
import { footprintOf, partsOf, shapesOf, type PrefabFile } from "../lib/prefab";
import { fileNameOf } from "../lib/prefab-check";
import type { PrefabAngle } from "../lib/prefabs";
import { isPrefabSlug } from "../lib/routes";
import type { AuthEnv } from "../lib/auth";
import type { ChosenSkinDeps } from "./chosen-skin-api";
import { addressOf, spendGameSignIn } from "./game-sign-in";
import { connect, type Db } from "./client";
import type { PrefabDeps } from "./prefab-api";
import { prefabList, prefabOf, type PrefabCard, type PrefabView } from "./prefabs";
import * as q from "./site";
import { linkPageOf, type LinkPage, type StatsLinkDeps } from "./stats-link";
import { boardTag, DAILY_TAG, DATA_TAG } from "./tags";

export { DATA_TAG } from "./tags";
/* the Prefab reads, expired by every write the site makes to them (and, since an uploader's
   persona comes from the boards, by a Refresh too) */
export const PREFAB_TAG = "prefabs";
/* what is read from a Prefab's file alone, which never changes after upload, so no write
   expires it: a burst of writes can't make the game's list read every file again (ADR 0016).
   Nothing in the site revalidates it; it only names these entries, should they ever need a
   purge by hand (revalidateTag(PREFAB_FILE_TAG)) */
export const PREFAB_FILE_TAG = "prefab-files";

/* every player's Chosen Skin, expired only by a save (PUT or DELETE /api/me/skin) */
export const CHOSEN_SKIN_TAG = "chosen-skins";

let client: Db | undefined;

// One pool per server process, opened on the first read.
function db(): Db {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    client = connect(url);
  }
  return client;
}

export interface Site {
  refreshedAt: string | null;
  mapsReadBy: string | null;
  /* refreshedAt in Unix ms, or 0 before the first Refresh: what an age counts to until the
     browser's clock takes over (useClock in hooks/client.ts) */
  asOf: number;
  /* every Circuit board in the site's order, with how many it ranks */
  boards: Array<IndexBoard>;
  podiums: Array<PodiumTally>;
}

/* What every page's frame needs: the Circuit's boards and podiums, and when they were read */
export async function getSite(): Promise<Site> {
  "use cache: remote";
  cacheTag(DATA_TAG);
  cacheLife("max");
  const [fresh, counts, placings] = await Promise.all([
    q.freshness(db()),
    q.circuitCounts(db()),
    q.trackPodiums(db()),
  ]);
  return {
    ...fresh,
    asOf: fresh.refreshedAt ? Date.parse(fresh.refreshedAt) : 0,
    boards: CIRCUIT.map((b) => ({
      name: b.name,
      group: b.group,
      tier: b.tier,
      display: b.display,
      entryCount: counts[b.name] ?? 0,
    })),
    podiums: podiumTallies(placings),
  };
}

/* every player's Chosen Skin, as its object path by Steam ID (components/ChosenSkins.tsx):
   read once per page by the root layout */
export async function getChosenSkins(): Promise<Record<string, string>> {
  "use cache: remote";
  cacheTag(CHOSEN_SKIN_TAG);
  cacheLife("max");
  return q.chosenSkins(db());
}

/* every Circuit Track's Steam leaderboard ID, in the site's order (GET /api/tracks) */
export async function getTrackBoards(): Promise<Array<{ name: string; leaderboardId: number }>> {
  "use cache: remote";
  cacheTag(DATA_TAG);
  cacheLife("max");
  return q.trackBoards(db());
}

export async function getWorkshop(): Promise<Array<WorkshopMap>> {
  "use cache: remote";
  cacheTag(DATA_TAG);
  cacheLife("max");
  return q.workshopMaps(db());
}

/* one Map the Workshop lists, by its published file ID, or null; only an ID shaped like
   one is looked up */
export async function getMap(pfid: string): Promise<WorkshopMap | null> {
  return isPfid(pfid) ? mapOf(pfid) : null;
}

async function mapOf(pfid: string): Promise<WorkshopMap | null> {
  "use cache: remote";
  cacheTag(DATA_TAG);
  cacheLife("max");
  return (await getWorkshop()).find((m) => m.pfid === pfid) ?? null;
}

/* a Map's stored file and its version, or null (GET /map/<pfid>/file). Read fresh, never
   cached here: its bytes are no JSON, and the response itself is cached a year by version */
export function readMapFile(pfid: string) {
  return isPfid(pfid) ? q.mapFile(db(), pfid) : Promise.resolve(null);
}

/* whether the Workshop lists any Map, for the header's tab */
export async function hasWorkshop(): Promise<boolean> {
  "use cache: remote";
  cacheTag(DATA_TAG);
  cacheLife("max");
  return (await getWorkshop()).length > 0;
}

/* the Maps with a time, as the cards the Workshop views and their search draw */
export async function getMapCards(): Promise<Array<MapCard>> {
  "use cache: remote";
  cacheTag(DATA_TAG);
  cacheLife("max");
  return timed(await getWorkshop()).map(mapCard);
}

/* Trending this week's rows, in order (spec #348) */
export async function getTrending(): Promise<Array<TrendCard>> {
  "use cache: remote";
  cacheTag(DATA_TAG);
  cacheLife("max");
  return trending(timed(await getWorkshop())).map(trendCard);
}

/* a slice of a board in rank order, unfiltered; for the fixed slices a page shows */
export async function getBoardPage(name: string, from: number, count: number) {
  "use cache: remote";
  cacheTag(DATA_TAG, boardTag(name));
  cacheLife("max");
  return q.boardPage(db(), name, { from, count });
}

/* rows a board is cached in for reads from the URL: a list growing as the reader scrolls,
   or reading down to a player's row, asks for any slice, and gets it cut from these */
const BLOCK = 1000;

async function getBoardBlock(name: string, k: number) {
  "use cache: remote";
  cacheTag(DATA_TAG, boardTag(name));
  cacheLife("max");
  return q.boardPage(db(), name, { from: k * BLOCK, count: BLOCK });
}

/* any slice of a board in rank order, unfiltered, read through whole blocks; only a block
   inside the board is ever read */
export async function readBoard(name: string, from: number, count: number): Promise<BoardPage> {
  const head = await getBoardBlock(name, 0);
  const end = Math.min(from + count, head.total);
  if (end <= from) return { total: head.total, rows: [] };
  const first = Math.floor(from / BLOCK);
  const blocks = await Promise.all(
    Array.from({ length: Math.floor((end - 1) / BLOCK) - first + 1 }, (_, i) =>
      first + i ? getBoardBlock(name, first + i) : Promise.resolve(head),
    ),
  );
  const at = from - first * BLOCK;
  return { total: head.total, rows: blocks.flatMap((b) => b.rows).slice(at, at + end - from) };
}

/* whether a board can be read: a Circuit board, a Campaign's, or a Map the Workshop lists */
export async function isBoard(name: string): Promise<boolean> {
  const pfid = mapPfidOf(name);
  return (
    !!circuitBoard(name) ||
    !!campaignOfBoard(name) ||
    EVENTS.some((e) => e.board === name) ||
    (pfid !== null && (await getMap(pfid)) !== null)
  );
}

/* whether a board's runs can race: a board that can be read, or a Daily's */
export async function isRaceBoard(name: string): Promise<boolean> {
  const day = /_Daily_(\d{4})(\d{2})(\d{2})_/.exec(name);
  if (!day) return isBoard(name);
  return (await getDaily(`${day[1]}-${day[2]}-${day[3]}`))?.board === name;
}

/* a run's Ghost against its rival's for the race drawer, or null; for a board
   isRaceBoard accepts and a Steam ID the database has seen */
export async function getBoardRun(name: string, steamId: string) {
  return (await isPlayer(steamId)) ? boardRunOf(name, steamId) : null;
}

async function boardRunOf(name: string, steamId: string) {
  "use cache: remote";
  cacheTag(DATA_TAG, boardTag(name));
  cacheLife("max");
  return q.boardRun(db(), name, steamId);
}

/* the rows of a board whose persona or Steam ID contains `query`, read fresh */
export function searchBoard(name: string, query: string, from: number, count: number) {
  return q.boardPage(db(), name, { from, count, q: query });
}

/* a Track's or a Map's record history (lib/history.ts), or null for an Overall board; for a
   board the page has already checked */
export async function getBoardHistory(name: string): Promise<BoardHistory | null> {
  "use cache: remote";
  cacheTag(DATA_TAG, boardTag(name));
  cacheLife("max");
  const input = await q.historyInput(db(), name);
  return input && boardHistory(input);
}

export async function getBoardScores(name: string) {
  "use cache: remote";
  cacheTag(DATA_TAG, boardTag(name));
  cacheLife("max");
  return q.boardScores(db(), name);
}

/* where `ids` stand on a board: an Overall board's podium order says where each player on
   a podium stands on points, and a link to a player's row on a board needs their rank */
export async function getBoardPlaces(name: string, ids: ReadonlyArray<string>) {
  const known = await Promise.all(ids.map(isPlayer));
  return getPlacesOf(
    name,
    ids.filter((_, i) => known[i]),
  );
}

/* the same, for Steam IDs the database gave (a podium tally's), which need no check */
export async function getPlacesOf(name: string, ids: ReadonlyArray<string>) {
  "use cache: remote";
  cacheTag(DATA_TAG, boardTag(name));
  cacheLife("max");
  return q.boardPlaces(db(), name, ids);
}

/* Season 1 Current and All Seasons ranked whole, once per Refresh, for every player page */
async function getDerivedStandings() {
  "use cache: remote";
  cacheTag(DATA_TAG);
  cacheLife("max");
  return q.derivedStandings(db());
}

/* whether the database has seen a Steam ID */
async function isPlayer(steamId: string): Promise<boolean> {
  "use cache: remote";
  cacheTag(DATA_TAG, DAILY_TAG);
  cacheLife("max");
  return q.isPlayer(db(), steamId);
}

/* a player's record, or null for a Steam ID nobody raced under */
export async function getPlayer(steamId: string): Promise<PlayerRecord | null> {
  return (await isPlayer(steamId)) ? playerOf(steamId) : null;
}

async function playerOf(steamId: string): Promise<PlayerRecord | null> {
  "use cache: remote";
  cacheTag(DATA_TAG);
  cacheLife("max");
  const [data, site, maps] = await Promise.all([
    q.playerData(db(), steamId, await getDerivedStandings()),
    getSite(),
    getWorkshop(),
  ]);
  return data ? playerRecord(data, site.boards, maps) : null;
}

export async function getStandings() {
  "use cache: remote";
  cacheTag(DATA_TAG);
  cacheLife("max");
  return q.standings(db());
}

/* the Workshop standings now and at a baseline (Unix ms), which GET /api/standings serves;
   the route keeps baselines to the hour and the last week, so few are ever cached */
export async function getWorkshopStandings(since: number): Promise<WorkshopStandings> {
  "use cache: remote";
  cacheTag(DATA_TAG);
  cacheLife("max");
  return q.workshopStandings(db(), since);
}

/* every Daily's date, oldest first */
export async function getDailyDates(): Promise<Array<string>> {
  "use cache: remote";
  cacheTag(DATA_TAG, DAILY_TAG);
  cacheLife("max");
  return q.dailyDates(db());
}

/* every Daily as the calendar draws it, oldest first */
export async function getDailies(): Promise<Array<DailyCell>> {
  "use cache: remote";
  cacheTag(DATA_TAG, DAILY_TAG);
  cacheLife("max");
  return q.dailies(db());
}

/* one Daily by its date, or null for a date with none; only a date that has one is read */
export async function getDaily(date: string): Promise<DailyDay | null> {
  return (await getDailyDates()).includes(date) ? dailyOf(date) : null;
}

async function dailyOf(date: string) {
  "use cache: remote";
  cacheTag(DATA_TAG, DAILY_TAG);
  cacheLife("max");
  return q.dailyDay(db(), date);
}

/* the all-time Daily standings, over final Dailies only */
export async function getDailyStandings(): Promise<DailyStandings> {
  "use cache: remote";
  cacheTag(DATA_TAG, DAILY_TAG);
  cacheLife("max");
  return q.dailyStandings(db());
}

/* a player's Daily record (their place on each Daily, their runs); only a Steam ID the
   database has seen is read */
export async function getPlayerDailies(steamId: string): Promise<PlayerDailies | null> {
  return (await isPlayer(steamId)) ? playerDailiesOf(steamId) : null;
}

async function playerDailiesOf(steamId: string) {
  "use cache: remote";
  cacheTag(DATA_TAG, DAILY_TAG);
  cacheLife("max");
  return q.playerDailies(db(), steamId);
}

export interface CampaignData {
  c: Campaign;
  /* its Maps the Workshop lists, in the Campaign's order */
  maps: Array<WorkshopMap>;
  /* how many players its board ranks: those with a time on one of those Maps */
  players: number;
  /* first on its board, or null while nobody has a time */
  leader: BoardRow | null;
  /* the podium places on those Maps, labelled as the rail numbers them */
  tally: PodiumTally;
}

/* a curated Campaign by its slug with its Maps, players, leader and podium tally, or null
   for one that isn't curated or none of whose Maps the Workshop lists. Every list of
   Campaigns is made of these, so a Campaign is listed, counted and led the same way on
   every page. */
export async function getCampaign(slug: string): Promise<CampaignData | null> {
  return campaignOf(slug) ? campaignData(slug) : null;
}

async function campaignData(slug: string): Promise<CampaignData | null> {
  "use cache: remote";
  cacheTag(DATA_TAG);
  cacheLife("max");
  const c = campaignOf(slug);
  if (!c) return null;
  const [workshop, events] = await Promise.all([getWorkshop(), eventMaps(c)]);
  const maps = c.maps.flatMap((id) => [...workshop, ...events].filter((m) => m.pfid === id));
  if (!maps.length) return null;
  const boards = maps.map((m) => m.name);
  const label = (name: string) => {
    const m = maps.find((x) => x.name === name);
    return m ? mapLabel(c, m.pfid, m.title) : name;
  };
  const [head, podiums] = await Promise.all([
    getBoardPage(campaignBoard(c), 0, 1),
    q.mapPodiums(db(), boards),
  ]);
  return {
    c,
    maps,
    players: head.total,
    leader: head.rows[0] ?? null,
    tally: tally(c.title, boards, podiums, label),
  };
}

/* a Campaign's Event boards as its Maps, each read one (with open Entries) drawn as a Map
   card draws a Workshop Map: its picture for the preview, Medals and Workshop counters none */
async function eventMaps(c: Campaign): Promise<Array<WorkshopMap>> {
  const events = c.maps.flatMap((id) => eventOf(id) ?? []);
  const read = await q.eventBoards(
    db(),
    events.map((e) => e.board),
  );
  return events.flatMap((e) =>
    read
      .filter((b) => b.board === e.board)
      .map((b) => ({
        pfid: e.id,
        name: e.board,
        title: e.title,
        creator: c.creator,
        cid: c.creatorId,
        preview: e.picture,
        created: 0,
        medals: [],
        entryCount: b.runs,
        sessions: 0,
        subs: 0,
        top3: b.top3,
        gap13: b.gap13,
        crowd: 0,
        authorBeaten: 0,
        fileVersion: null,
        weekPlays: 0,
        votesUp: 0,
        votesDown: 0,
        voteScore: 0,
      })),
  );
}

/* a Campaign as the lists draw it: the Campaign switch, the banners, a player's cards */
export interface ListedCampaign {
  c: Campaign;
  players: number;
  /* its listed Maps' preview pictures, in its order */
  previews: Array<string | null>;
  leader: BoardRow | null;
}

/* every Campaign getCampaign finds, pinned ones first, then most players, equal counts in the
   curated order:
   what the Campaign switch, the homepage's carousel and /campaigns list; one none of whose
   Maps the Workshop lists is shown nowhere */
export async function getCampaigns(): Promise<Array<ListedCampaign>> {
  "use cache: remote";
  cacheTag(DATA_TAG);
  cacheLife("max");
  const all = await Promise.all(CAMPAIGNS.map((c) => campaignData(c.slug)));
  return all
    .flatMap((d) =>
      d
        ? [{ c: d.c, players: d.players, previews: d.maps.map((m) => m.preview), leader: d.leader }]
        : [],
    )
    .sort((a, b) => Number(!!b.c.pinned) - Number(!!a.c.pinned) || b.players - a.players);
}

export interface PlayerCampaign extends Omit<PlayerCampaignRow, "slug"> {
  c: Campaign;
  /* its listed Maps' pictures, in its order */
  previews: Array<string | null>;
  /* how many players its board ranks */
  players: number;
}

/* where a player stands in each Campaign they hold a place in, in getCampaigns' order, with
   the Campaign's pictures and field: their page's Campaigns shelf. Only a Steam ID the
   database has seen is read. */
export async function getPlayerCampaigns(steamId: string): Promise<Array<PlayerCampaign>> {
  return (await isPlayer(steamId)) ? playerCampaignsOf(steamId) : [];
}

async function playerCampaignsOf(steamId: string): Promise<Array<PlayerCampaign>> {
  "use cache: remote";
  cacheTag(DATA_TAG);
  cacheLife("max");
  const [listed, mine] = await Promise.all([
    getCampaigns(),
    q.playerCampaigns(db(), steamId, CAMPAIGNS),
  ]);
  return listed.flatMap(({ c, previews, players }) => {
    const at = mine.find((x) => x.slug === c.slug);
    return at
      ? [{ c, previews, players, rank: at.rank, score: at.score, finished: at.finished }]
      : [];
  });
}

/* what a Campaign's share card reads: its Maps and where it stands, or null where
   getCampaign is null */
export async function getCampaignShare(
  slug: string,
): Promise<{ data: CampaignData; standing: CampaignStanding } | null> {
  const data = await getCampaign(slug);
  if (!data) return null;
  return {
    data,
    standing: {
      players: data.players,
      leader: data.leader,
      finishedEveryMap: await finishedEveryMapOf(slug),
    },
  };
}

async function finishedEveryMapOf(slug: string) {
  "use cache: remote";
  cacheTag(DATA_TAG);
  cacheLife("max");
  const c = campaignOf(slug);
  return c ? q.finishedEveryMap(db(), c) : 0;
}

/* the Compare dialog's search, read fresh */
export function searchPlayers(query: string, except: string) {
  return q.searchPlayers(db(), query, { except });
}

/* which of the site search's makers have a time on a board, read fresh with it */
export function withTimes(ids: ReadonlyArray<string>) {
  return q.withTimes(db(), ids);
}

/* every live Prefab as the gallery's cards, newest first */
export async function getPrefabCards(): Promise<Array<PrefabCard>> {
  "use cache: remote";
  cacheTag(DATA_TAG, PREFAB_TAG);
  cacheLife("max");
  return prefabList(db());
}

export interface PrefabPage extends Omit<PrefabView, "file"> {
  parts: Array<{ piece: string; count: number }>;
  size: { w: number; d: number; h: number };
  fileName: string;
}

/* a Prefab's page, without its file (the viewer fetches that), or null for a slug nobody
   uploaded; one that isn't live comes back with its state, for the page to say it's gone.
   Only a slug shaped like one is looked up */
export async function getPrefab(slug: string): Promise<PrefabPage | null> {
  return isPrefabSlug(slug) ? prefabPageOf(slug) : null;
}

async function prefabPageOf(slug: string): Promise<PrefabPage | null> {
  "use cache: remote";
  cacheTag(DATA_TAG, PREFAB_TAG);
  cacheLife("max");
  const p = await prefabOf(db(), slug);
  if (!p) return null;
  const { file, ...rest } = p;
  const parsed = JSON.parse(file) as PrefabFile;
  return {
    ...rest,
    parts: partsOf(parsed),
    size: footprintOf(shapesOf(parsed)),
    fileName: fileNameOf(p.name),
  };
}

/* a Prefab's size in metres (wide, deep, tall) as its page shows it, or null for a slug
   nobody uploaded; whether it is live is the caller's to know */
export async function getPrefabSize(slug: string): Promise<PrefabPage["size"] | null> {
  "use cache: remote";
  cacheTag(PREFAB_FILE_TAG);
  cacheLife("max");
  if (!isPrefabSlug(slug)) return null;
  const p = await prefabOf(db(), slug);
  if (!p) return null;
  /* a file that can't be read leaves its entry without a size rather than its whole page */
  try {
    return footprintOf(shapesOf(JSON.parse(p.file) as PrefabFile));
  } catch {
    return null;
  }
}

/* small enough that a page of 50 costs a few megabytes, big enough for a card */
const PREFAB_THUMB = [320, 200] as const;

/* a live Prefab drawn small for the game's list (ADR 0016), as at its edit `updatedAt`, from
   the angle its uploader picked, by the same drawing as its share image, as base64. Kept for
   days apart from the Prefab reads, so no write throws it away; a new angle is a new edit and
   so a new entry. A drawing that fails throws, so nothing is kept for it. It takes the three
   values it is drawn from rather than the card, since its arguments are its cache key and a
   card's hearts change */
export async function getPrefabThumb(
  slug: string,
  updatedAt: string,
  angle: PrefabAngle | null,
): Promise<string> {
  "use cache: remote";
  cacheTag(PREFAB_FILE_TAG);
  cacheLife("days");
  const file = await prefabFileText(slug);
  if (file === null) throw new Error(`${slug} at ${updatedAt}: no such prefab`);
  const [w, h] = PREFAB_THUMB;
  /* loaded here, not at the top, so the reads every page makes don't load three.js */
  const { prefabPicture } = await import("../components/share/prefab");
  return (await prefabPicture(JSON.parse(file) as PrefabFile, angle, w, h)).toString("base64");
}

/* a Prefab's file read fresh, whatever its state, or null for a slug nobody uploaded: for a
   cached read of it, which mustn't read through getPrefabFile, since a "use cache" inside
   another passes its tags out, and every Prefab write would then throw it away */
async function prefabFileText(slug: string): Promise<string | null> {
  if (!isPrefabSlug(slug)) return null;
  return (await prefabOf(db(), slug))?.file ?? null;
}

/* a file bigger than this is read fresh, not cached: a cache entry has a size limit */
const CACHED_FILE_BYTES = 1_000_000;

/* a live Prefab's file as it was uploaded and the name it downloads as, or null */
export async function getPrefabFile(
  slug: string,
): Promise<{ fileName: string; file: string } | null> {
  if (!isPrefabSlug(slug)) return null;
  const cached = await prefabFileOf(slug);
  if (!cached) return null;
  if (cached.file !== null) return { fileName: cached.fileName, file: cached.file };
  const p = await prefabOf(db(), slug);
  return p?.state === "live" ? { fileName: fileNameOf(p.name), file: p.file } : null;
}

async function prefabFileOf(slug: string) {
  "use cache: remote";
  cacheTag(PREFAB_TAG);
  cacheLife("max");
  const p = await prefabOf(db(), slug);
  if (p?.state !== "live") return null;
  return { fileName: fileNameOf(p.name), file: p.bytes > CACHED_FILE_BYTES ? null : p.file };
}

/* what the Prefab API's routes write with: this server's database, and every cached Prefab
   read expired after a write so the change shows at once */
export function prefabDeps(): PrefabDeps {
  return { db: db(), changed: () => revalidateTag(PREFAB_TAG, { expire: 0 }) };
}

/* the game's sign-in limit on this server's database: each address so many an hour */
export function gameSignInDeps(): Pick<AuthEnv, "allowGameSignIn"> {
  return {
    allowGameSignIn: (request) => spendGameSignIn(db(), addressOf(request), Date.now()),
  };
}

/* what the Chosen Skin API writes with: this server's database, and the cached picks expired
   after a save, so every page draws it on its next load without reading the boards again */
export function chosenSkinDeps(): ChosenSkinDeps {
  return { db: db(), changed: () => revalidateTag(CHOSEN_SKIN_TAG, { expire: 0 }) };
}

/* what the link page and its confirm read and write with: this server's database, uncached,
   since a link request lives minutes and the page is read once (ADR 0014) */
export function statsLinkDeps(): StatsLinkDeps {
  return { db: db() };
}

/* the link page for `token`, as `steamId` (null signed out) reads it: per reader and changed
   by the confirm, so read fresh, never cached (ADR 0014) */
export function getLinkPage(token: string, steamId: string | null): Promise<LinkPage> {
  return linkPageOf(statsLinkDeps(), token, steamId);
}
