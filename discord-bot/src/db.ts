// The bot's one SQLite database: every table, in migration order. Each module that owns a
// table (the Store, the Steam adapter's board cache, ...) queries its own; this file only
// creates them.
import { NodeContext } from "@effect/platform-node";
import { Migrator, SqlClient } from "@effect/sql";
import { SqliteMigrator } from "@effect/sql-sqlite-node";
import { Effect, Layer } from "effect";

type Migrations = Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>;

/** Every migration by its id and name, applied in order; never edit one that has shipped. */
const MIGRATIONS: Migrations = {
  "0001_links_and_matches": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE links (
        discord_id TEXT PRIMARY KEY,
        steam_id TEXT NOT NULL,
        persona_name TEXT NOT NULL
      )`;
    yield* sql`CREATE TABLE matches (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        data TEXT NOT NULL
      )`;
    yield* sql`CREATE INDEX matches_state ON matches (state)`;
    yield* sql`CREATE TABLE match_ids (n INTEGER PRIMARY KEY AUTOINCREMENT)`;
  }),
  // A board's id never changes, and finding one by name costs a Steam round trip.
  "0002_board_ids": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE board_ids (board_name TEXT PRIMARY KEY, board_id INTEGER NOT NULL)`;
  }),
  // Where the Footer and each Match's Card and Match Thread are, so a restart can find them.
  "0003_discord_layout": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE discord_layout (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)`;
  }),
  // Members who answered the @Multiplayer ping offer (Get or No), so it is never made again.
  // Keyed by Discord id, not by Link: a member without a Link can answer it too.
  "0004_ping_offer_answers": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE ping_offer_answers (discord_id TEXT PRIMARY KEY)`;
  }),
  // Each day the Daily Report was posted (UTC, "2026-10-04"), so it is never posted twice.
  "0005_daily_reports": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE daily_reports (day TEXT PRIMARY KEY, message_id TEXT NOT NULL)`;
  }),
  // Each Daily Post (spec #268) by its Daily's date, so a restart resumes the live one and
  // never posts a date twice. `data` is the record as JSON (dailyPost/schedule.ts).
  "0006_daily_posts": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE daily_posts (date TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL)`;
  }),
  // Each read of a Daily that changed its lead (spec #268): its leaders (a JSON array of names)
  // and leading time. It draws the Daily Post's lead graph and its thread's lines.
  "0007_daily_leads": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE daily_leads (date TEXT NOT NULL, at INTEGER NOT NULL, leaders TEXT NOT NULL, ticks INTEGER NOT NULL)`;
    yield* sql`CREATE INDEX daily_leads_date ON daily_leads (date, at)`;
  }),
  // The My Stats channel (spec #323) the bot made, and its panel with the fingerprint of what
  // it shows: found by id at each start, so a renamed or moved channel is kept.
  "0008_my_stats_channel": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE my_stats_channel (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        channel_id TEXT NOT NULL,
        panel_id TEXT,
        panel_fingerprint TEXT
      )`;
  }),
  // Each day the Traffic Report was posted (UTC), so it is never posted twice.
  "0009_traffic_reports": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE traffic_reports (day TEXT PRIMARY KEY)`;
  }),
  // Venues (spec #315): each Venue's channel has its own Footer and Cards, so the layout is kept
  // per Venue. The one row there was is the home Venue's, so a deploy finds its Footer in place.
  // `discord_layout` stays as it was, so a rollback to the build before Venues still starts.
  // The copy runs once: a redeploy after a rollback picks up the layout from before the rollback.
  "0010_venue_layouts": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE venue_layouts (venue TEXT PRIMARY KEY, data TEXT NOT NULL)`;
    yield* sql`INSERT INTO venue_layouts (venue, data) SELECT 'home', data FROM discord_layout WHERE id = 1`;
  }),
  // Each Venue offers its own @Multiplayer ping role, so an answer is kept per Venue; the
  // answers given before were all to the home Venue's offer. `ping_offer_answers` stays, as above.
  "0011_venue_ping_offer_answers": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE venue_ping_offer_answers (venue TEXT NOT NULL, discord_id TEXT NOT NULL, PRIMARY KEY (venue, discord_id))`;
    yield* sql`INSERT INTO venue_ping_offer_answers (venue, discord_id) SELECT 'home', discord_id FROM ping_offer_answers`;
  }),
  // Each server the bot set up as a Venue itself (spec #321): its name (the server's id), its
  // Match channel and its ping role. The home Venue is never here: it is its three settings.
  "0012_venues": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE venues (
        name TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL UNIQUE,
        channel_id TEXT NOT NULL,
        ping_role_id TEXT NOT NULL
      )`;
  }),
  // Every server the bot knows (spec #321): `wanted` 1 for a server that invited it (a Venue, or
  // one whose setup is still to work), 0 for one it was already in when this build first started,
  // which a deploy must never set up. `known_servers_baseline` has its one row once that first
  // start has listed them.
  "0013_known_servers": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE known_servers (guild_id TEXT PRIMARY KEY, wanted INTEGER NOT NULL)`;
    yield* sql`INSERT INTO known_servers (guild_id, wanted) SELECT guild_id, 1 FROM venues`;
    yield* sql`CREATE TABLE known_servers_baseline (id INTEGER PRIMARY KEY CHECK (id = 1))`;
  }),
  // When the baseline was taken (ms), so a server the bot joined again since counts as invited.
  "0014_known_servers_baseline_time": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE known_servers_baseline ADD COLUMN taken_at INTEGER`;
  }),
  // When the bot restarted to change its Venues (ms), so a brake holds across restarts.
  "0015_venue_restarts": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE venue_restarts (at INTEGER NOT NULL)`;
  }),
  // The Weekly Cup (spec #353): each server's #weekly-cup the bot made or reused, found by id at
  // each start; each week's Cup by its server and Monday (Central), with its state, the messages
  // each of its slots shows (JSON: post, shortlist, standings, results), when its bars were taken
  // as racing opened, and when each Cup Map's final read landed (JSON, pfid to ms); its Entrants,
  // with when each signed up; its Shortlist in draw order, each Map as JSON with its board id and,
  // once the vote closes, its rank (ties settled at random, kept so a restart never redraws) and
  // votes; each Entrant's latest vote (a JSON array of pfids); each Entrant's bar on each Cup Map
  // (their PB when it was taken: a time counts only once it beats it); and each Entrant's counted
  // best there, with when their first counted time on it was seen, when this one was, and whether
  // its Flag was told.
  "0016_weekly_cup": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE weekly_cup_channels (guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL)`;
    yield* sql`CREATE TABLE weekly_cups (
        guild_id TEXT NOT NULL,
        week TEXT NOT NULL,
        state TEXT NOT NULL,
        messages TEXT NOT NULL,
        bars_at INTEGER,
        final_reads TEXT NOT NULL,
        PRIMARY KEY (guild_id, week)
      )`;
    yield* sql`CREATE TABLE weekly_cup_entrants (
        guild_id TEXT NOT NULL,
        week TEXT NOT NULL,
        discord_id TEXT NOT NULL,
        signed_up_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, week, discord_id)
      )`;
    yield* sql`CREATE TABLE weekly_cup_maps (
        guild_id TEXT NOT NULL,
        week TEXT NOT NULL,
        position INTEGER NOT NULL,
        pfid TEXT NOT NULL,
        board_id INTEGER NOT NULL,
        data TEXT NOT NULL,
        cup_rank INTEGER,
        votes INTEGER,
        PRIMARY KEY (guild_id, week, position)
      )`;
    yield* sql`CREATE TABLE weekly_cup_votes (
        guild_id TEXT NOT NULL,
        week TEXT NOT NULL,
        discord_id TEXT NOT NULL,
        picks TEXT NOT NULL,
        PRIMARY KEY (guild_id, week, discord_id)
      )`;
    yield* sql`CREATE TABLE weekly_cup_baselines (
        guild_id TEXT NOT NULL,
        week TEXT NOT NULL,
        pfid TEXT NOT NULL,
        discord_id TEXT NOT NULL,
        ticks INTEGER NOT NULL,
        PRIMARY KEY (guild_id, week, pfid, discord_id)
      )`;
    yield* sql`CREATE TABLE weekly_cup_times (
        guild_id TEXT NOT NULL,
        week TEXT NOT NULL,
        pfid TEXT NOT NULL,
        discord_id TEXT NOT NULL,
        ticks INTEGER NOT NULL,
        first_at INTEGER NOT NULL,
        seen_at INTEGER NOT NULL,
        flagged INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, week, pfid, discord_id)
      )`;
  }),
  // When each Entrant's first counted time on a Cup Map was set, by its Ghost, or null when its
  // Ghost gave no date: a Flag then times the runs themselves rather than the reads.
  "0017_weekly_cup_first_set_at": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE weekly_cup_times ADD COLUMN first_set_at INTEGER`;
  }),
};

/** The migrations a build had before the one with this id (`"0010"`): tests start a database from an older build. */
export const migrationsBefore = (id: string): Migrations =>
  Object.fromEntries(Object.entries(MIGRATIONS).filter(([name]) => name < id));

/** Run these migrations on the provided SqlClient. */
export const migratorFor = (migrations: Migrations) =>
  SqliteMigrator.layer({ loader: Migrator.fromRecord(migrations) }).pipe(
    Layer.provide(NodeContext.layer),
  );

export const MigratorLive = migratorFor(MIGRATIONS);
