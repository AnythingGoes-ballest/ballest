// The Weekly Cup's record (spec #353): each server's #weekly-cup and each week's Cup, with its
// Entrants, Shortlist, votes, bars and counted times, in the bot's own SQLite (migration
// 0016_weekly_cup). The schedule works only from this and the clock, so a restart resumes it.
import { SqlClient } from "@effect/sql";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { MigratorLive } from "../db.js";
import { CUP_STATES, CupMap, type CupState, type Slot } from "./model.js";

const Ids = Schema.Array(Schema.String);
const CupRow = Schema.Struct({
  state: Schema.Literal(...CUP_STATES),
  messages: Schema.parseJson(
    Schema.Struct({ post: Ids, shortlist: Ids, standings: Ids, results: Ids }),
  ),
  bars_at: Schema.NullOr(Schema.Number),
  final_reads: Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Number })),
});
const ChannelRow = Schema.Struct({ channel_id: Schema.String });
const EntrantRow = Schema.Struct({ discord_id: Schema.String, signed_up_at: Schema.Number });
const MapRow = Schema.Struct({
  data: Schema.parseJson(CupMap),
  cup_rank: Schema.NullOr(Schema.Number),
  votes: Schema.NullOr(Schema.Number),
});
const BaselineRow = Schema.Struct({
  pfid: Schema.String,
  discord_id: Schema.String,
  ticks: Schema.Number,
});
const TimeRow = Schema.Struct({
  pfid: Schema.String,
  discord_id: Schema.String,
  ticks: Schema.Number,
  first_at: Schema.Number,
  first_set_at: Schema.NullOr(Schema.Number),
  seen_at: Schema.Number,
  flagged: Schema.Number,
});
const VoteRow = Schema.Struct({
  discord_id: Schema.String,
  picks: Schema.parseJson(Schema.Array(Schema.String)),
});

/** A week's Cup. */
export interface CupRecord {
  readonly state: CupState;
  /**
   * The messages each slot shows, none until it is first shown. The results' are there once they
   * went up, which they do once.
   */
  readonly shown: Readonly<Record<Slot, ReadonlyArray<string>>>;
  /** When every Entrant's bar was taken, as racing opened. */
  readonly barsAt: number | null;
  /** When each Cup Map's final read landed, by pfid. */
  readonly finalReads: Readonly<Record<string, number>>;
}

/** A new week's record, as its post goes up. */
export const freshCup = (post: ReadonlyArray<string>): CupRecord => ({
  state: "open",
  shown: { post, shortlist: [], standings: [], results: [] },
  barsAt: null,
  finalReads: {},
});
export interface Entrant {
  readonly discordId: string;
  readonly signedUpAt: number;
}
/** A Shortlist Map, with its rank and votes once it is a Cup Map. */
export interface ShortlistedMap {
  readonly map: CupMap;
  readonly cupRank: number | null;
  readonly votes: number | null;
}
export interface Vote {
  readonly discordId: string;
  readonly picks: ReadonlyArray<string>;
}
/** An Entrant's PB on a Cup Map when their bar was taken: only a faster time counts. */
export interface Baseline {
  readonly pfid: string;
  readonly discordId: string;
  readonly ticks: number;
}
/** An Entrant's counted best on a Cup Map. */
export interface CupTime {
  readonly pfid: string;
  readonly discordId: string;
  readonly ticks: number;
  /** When their first counted time on this Map was seen. */
  readonly firstAt: number;
  /** When that first time was set, by its Ghost; null when the Ghost gave no date. */
  readonly firstSetAt: number | null;
  /** When this one was. */
  readonly seenAt: number;
  /** Whether a Flag was told for them on this Map. */
  readonly flagged: boolean;
}

/** Each server's Cups, by week, with their Entrants, Shortlists and votes: the bot's own SQLite. */
export class CupLog extends Context.Tag("multiballs/CupLog")<
  CupLog,
  {
    /** The server's #weekly-cup, as the bot last kept it. */
    readonly channelOf: (guildId: string) => Effect.Effect<Option.Option<string>>;
    readonly keepChannel: (guildId: string, channelId: string) => Effect.Effect<void>;
    readonly get: (guildId: string, week: string) => Effect.Effect<Option.Option<CupRecord>>;
    readonly put: (guildId: string, week: string, cup: CupRecord) => Effect.Effect<void>;
    /** The week's Entrants, in sign-up order. */
    readonly entrants: (guildId: string, week: string) => Effect.Effect<ReadonlyArray<Entrant>>;
    /** False when they were signed up already. */
    readonly addEntrant: (
      guildId: string,
      week: string,
      entrant: Entrant,
    ) => Effect.Effect<boolean>;
    /** False when they weren't signed up. */
    readonly removeEntrant: (
      guildId: string,
      week: string,
      discordId: string,
    ) => Effect.Effect<boolean>;
    /** The week's Shortlist in draw order; empty until it is drawn. */
    readonly shortlist: (
      guildId: string,
      week: string,
    ) => Effect.Effect<ReadonlyArray<ShortlistedMap>>;
    readonly putShortlist: (
      guildId: string,
      week: string,
      maps: ReadonlyArray<CupMap>,
    ) => Effect.Effect<void>;
    /** Make these Shortlist Maps the Cup Maps, in rank order, each with its votes. */
    readonly putCupMaps: (
      guildId: string,
      week: string,
      ranked: ReadonlyArray<{ readonly pfid: string; readonly votes: number }>,
    ) => Effect.Effect<void>;
    readonly votes: (guildId: string, week: string) => Effect.Effect<ReadonlyArray<Vote>>;
    /** An Entrant's vote, replacing the one before. */
    readonly putVote: (guildId: string, week: string, vote: Vote) => Effect.Effect<void>;
    readonly baselines: (guildId: string, week: string) => Effect.Effect<ReadonlyArray<Baseline>>;
    /** These Entrants' bars, replacing any they had: one with no time on a Map has none there. */
    readonly putBaselines: (
      guildId: string,
      week: string,
      discordIds: ReadonlyArray<string>,
      bars: ReadonlyArray<Baseline>,
    ) => Effect.Effect<void>;
    /** Weeks before this one still racing: their results never went up. */
    readonly unfinished: (guildId: string, before: string) => Effect.Effect<ReadonlyArray<string>>;
    readonly times: (guildId: string, week: string) => Effect.Effect<ReadonlyArray<CupTime>>;
    /** A counted best, replacing the one before. */
    readonly putTime: (guildId: string, week: string, time: CupTime) => Effect.Effect<void>;
  }
>() {}

export const CupLogLive = Layer.effect(
  CupLog,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The bot's own SQLite: a failure there is a defect, which the schedule reports to ops.
    return CupLog.of({
      channelOf: Effect.fn("CupLog.channelOf")(function* (guildId: string) {
        const rows =
          yield* sql`SELECT channel_id FROM weekly_cup_channels WHERE guild_id = ${guildId}`.pipe(
            Effect.flatMap(Schema.decodeUnknown(Schema.Array(ChannelRow))),
            Effect.orDie,
          );
        return Option.fromNullable(rows[0]?.channel_id);
      }),
      keepChannel: Effect.fn("CupLog.keepChannel")(function* (guildId: string, channelId: string) {
        yield* sql`INSERT OR REPLACE INTO weekly_cup_channels (guild_id, channel_id) VALUES (${guildId}, ${channelId})`.pipe(
          Effect.orDie,
        );
      }),
      get: Effect.fn("CupLog.get")(function* (guildId: string, week: string) {
        const rows =
          yield* sql`SELECT state, messages, bars_at, final_reads FROM weekly_cups WHERE guild_id = ${guildId} AND week = ${week}`.pipe(
            Effect.flatMap(Schema.decodeUnknown(Schema.Array(CupRow))),
            Effect.orDie,
          );
        return Option.map(Option.fromNullable(rows[0]), (r): CupRecord => ({
          state: r.state,
          shown: r.messages,
          barsAt: r.bars_at,
          finalReads: r.final_reads,
        }));
      }),
      put: Effect.fn("CupLog.put")(function* (guildId: string, week: string, cup: CupRecord) {
        yield* sql`INSERT OR REPLACE INTO weekly_cups (guild_id, week, state, messages, bars_at, final_reads) VALUES (${guildId}, ${week}, ${cup.state}, ${JSON.stringify(cup.shown)}, ${cup.barsAt}, ${JSON.stringify(cup.finalReads)})`.pipe(
          Effect.orDie,
        );
      }),

      entrants: Effect.fn("CupLog.entrants")(function* (guildId: string, week: string) {
        const rows =
          yield* sql`SELECT discord_id, signed_up_at FROM weekly_cup_entrants WHERE guild_id = ${guildId} AND week = ${week} ORDER BY signed_up_at, rowid`.pipe(
            Effect.flatMap(Schema.decodeUnknown(Schema.Array(EntrantRow))),
            Effect.orDie,
          );
        return rows.map((r) => ({ discordId: r.discord_id, signedUpAt: r.signed_up_at }));
      }),
      addEntrant: Effect.fn("CupLog.addEntrant")(function* (
        guildId: string,
        week: string,
        entrant: Entrant,
      ) {
        const added =
          yield* sql`INSERT OR IGNORE INTO weekly_cup_entrants (guild_id, week, discord_id, signed_up_at) VALUES (${guildId}, ${week}, ${entrant.discordId}, ${entrant.signedUpAt}) RETURNING discord_id`.pipe(
            Effect.orDie,
          );
        return added.length > 0;
      }),
      removeEntrant: Effect.fn("CupLog.removeEntrant")(function* (
        guildId: string,
        week: string,
        discordId: string,
      ) {
        const removed =
          yield* sql`DELETE FROM weekly_cup_entrants WHERE guild_id = ${guildId} AND week = ${week} AND discord_id = ${discordId} RETURNING discord_id`.pipe(
            Effect.orDie,
          );
        return removed.length > 0;
      }),
      shortlist: Effect.fn("CupLog.shortlist")(function* (guildId: string, week: string) {
        const rows =
          yield* sql`SELECT data, cup_rank, votes FROM weekly_cup_maps WHERE guild_id = ${guildId} AND week = ${week} ORDER BY position`.pipe(
            Effect.flatMap(Schema.decodeUnknown(Schema.Array(MapRow))),
            Effect.orDie,
          );
        return rows.map((r) => ({ map: r.data, cupRank: r.cup_rank, votes: r.votes }));
      }),
      putShortlist: Effect.fn("CupLog.putShortlist")(function* (
        guildId: string,
        week: string,
        maps: ReadonlyArray<CupMap>,
      ) {
        const encode = Schema.encode(Schema.parseJson(CupMap));
        yield* Effect.forEach(maps, (map, position) =>
          Effect.flatMap(
            encode(map),
            (data) =>
              sql`INSERT INTO weekly_cup_maps (guild_id, week, position, pfid, board_id, data) VALUES (${guildId}, ${week}, ${position}, ${map.pfid}, ${map.boardId}, ${data})`,
          ),
        ).pipe(sql.withTransaction, Effect.orDie);
      }),
      putCupMaps: Effect.fn("CupLog.putCupMaps")(function* (
        guildId: string,
        week: string,
        ranked: ReadonlyArray<{ readonly pfid: string; readonly votes: number }>,
      ) {
        yield* Effect.forEach(
          ranked,
          ({ pfid, votes }, i) =>
            sql`UPDATE weekly_cup_maps SET cup_rank = ${i + 1}, votes = ${votes} WHERE guild_id = ${guildId} AND week = ${week} AND pfid = ${pfid}`,
        ).pipe(sql.withTransaction, Effect.orDie);
      }),
      votes: Effect.fn("CupLog.votes")(function* (guildId: string, week: string) {
        const rows =
          yield* sql`SELECT discord_id, picks FROM weekly_cup_votes WHERE guild_id = ${guildId} AND week = ${week} ORDER BY rowid`.pipe(
            Effect.flatMap(Schema.decodeUnknown(Schema.Array(VoteRow))),
            Effect.orDie,
          );
        return rows.map((r) => ({ discordId: r.discord_id, picks: r.picks }));
      }),
      putVote: Effect.fn("CupLog.putVote")(function* (guildId: string, week: string, vote: Vote) {
        yield* sql`INSERT OR REPLACE INTO weekly_cup_votes (guild_id, week, discord_id, picks) VALUES (${guildId}, ${week}, ${vote.discordId}, ${JSON.stringify(vote.picks)})`.pipe(
          Effect.orDie,
        );
      }),
      baselines: Effect.fn("CupLog.baselines")(function* (guildId: string, week: string) {
        const rows =
          yield* sql`SELECT pfid, discord_id, ticks FROM weekly_cup_baselines WHERE guild_id = ${guildId} AND week = ${week}`.pipe(
            Effect.flatMap(Schema.decodeUnknown(Schema.Array(BaselineRow))),
            Effect.orDie,
          );
        return rows.map((r) => ({ pfid: r.pfid, discordId: r.discord_id, ticks: r.ticks }));
      }),
      putBaselines: Effect.fn("CupLog.putBaselines")(function* (
        guildId: string,
        week: string,
        discordIds: ReadonlyArray<string>,
        bars: ReadonlyArray<Baseline>,
      ) {
        yield* Effect.gen(function* () {
          for (const id of discordIds)
            yield* sql`DELETE FROM weekly_cup_baselines WHERE guild_id = ${guildId} AND week = ${week} AND discord_id = ${id}`;
          for (const b of bars)
            yield* sql`INSERT OR REPLACE INTO weekly_cup_baselines (guild_id, week, pfid, discord_id, ticks) VALUES (${guildId}, ${week}, ${b.pfid}, ${b.discordId}, ${b.ticks})`;
        }).pipe(sql.withTransaction, Effect.orDie);
      }),
      unfinished: Effect.fn("CupLog.unfinished")(function* (guildId: string, before: string) {
        const rows =
          yield* sql`SELECT week FROM weekly_cups WHERE guild_id = ${guildId} AND week < ${before} AND state = 'racing' ORDER BY week`.pipe(
            Effect.flatMap(
              Schema.decodeUnknown(Schema.Array(Schema.Struct({ week: Schema.String }))),
            ),
            Effect.orDie,
          );
        return rows.map((r) => r.week);
      }),
      times: Effect.fn("CupLog.times")(function* (guildId: string, week: string) {
        const rows =
          yield* sql`SELECT pfid, discord_id, ticks, first_at, first_set_at, seen_at, flagged FROM weekly_cup_times WHERE guild_id = ${guildId} AND week = ${week}`.pipe(
            Effect.flatMap(Schema.decodeUnknown(Schema.Array(TimeRow))),
            Effect.orDie,
          );
        return rows.map((r) => ({
          pfid: r.pfid,
          discordId: r.discord_id,
          ticks: r.ticks,
          firstAt: r.first_at,
          firstSetAt: r.first_set_at,
          seenAt: r.seen_at,
          flagged: r.flagged !== 0,
        }));
      }),
      putTime: Effect.fn("CupLog.putTime")(function* (guildId: string, week: string, t: CupTime) {
        yield* sql`INSERT OR REPLACE INTO weekly_cup_times (guild_id, week, pfid, discord_id, ticks, first_at, first_set_at, seen_at, flagged) VALUES (${guildId}, ${week}, ${t.pfid}, ${t.discordId}, ${t.ticks}, ${t.firstAt}, ${t.firstSetAt}, ${t.seenAt}, ${t.flagged ? 1 : 0})`.pipe(
          Effect.orDie,
        );
      }),
    });
  }),
).pipe(Layer.provide(MigratorLive));
