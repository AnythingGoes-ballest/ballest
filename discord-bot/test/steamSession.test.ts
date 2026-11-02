import { describe, expect, it } from "@effect/vitest";
import { EventEmitter } from "node:events";
import { ConfigProvider, Effect, Either, Fiber, Layer, TestClock } from "effect";
import Protos from "steam-user/protobufs/generated/_load.js";
import {
  EMSG_GET_LB_ENTRIES,
  FRESH_LOGON_AFTER_MS,
  makeSteamSession,
} from "../src/steam/session.js";

/**
 * A stand-in steam-user client. It logs on at once, unless Steam is `refusing` log ons, and
 * answers every leaderboard read with one entry, until `dead`: then, like the connection on
 * 2026-10-06, nothing answers. Like steam-user, it drops every message while logged off.
 */
class FakeClient extends EventEmitter {
  steamID: object | null = null;
  dead = false;
  loggedOff = false;

  constructor(private readonly steam: { refusing: boolean }) {
    super();
  }

  logOn() {
    if (this.steam.refusing) {
      this.emit("error", new Error("refused"));
      return;
    }
    this.steamID = {};
    this.emit("loggedOn");
  }

  logOff() {
    this.loggedOff = true;
    this.steamID = null;
  }

  _send(header: { readonly msg: number }, _body: Buffer, callback: (reply: Buffer) => void): void {
    if (this.dead || this.steamID === null || header.msg !== EMSG_GET_LB_ENTRIES) return;
    const res = Protos.CMsgClientLBSGetLBEntriesResponse!;
    const reply = res.fromObject({
      eresult: 1,
      leaderboard_entry_count: 145,
      entries: [
        {
          steam_id_user: "76561198000000001",
          global_rank: 1,
          score: 1_234_567,
          ugc_id: "1234567890123456789",
        },
        // No Ghost attached: Steam's invalid UGC handle.
        {
          steam_id_user: "76561198000000002",
          global_rank: 2,
          score: 1_300_000,
          ugc_id: "18446744073709551615",
        },
      ],
    });
    callback(Buffer.from(res.encode(reply).finish()));
  }
}

const config = Layer.setConfigProvider(
  ConfigProvider.fromMap(new Map([["STEAM_REFRESH_TOKEN", "fake-token"]])),
);

/** A session over fake clients, and every client it has made so far. */
const session = Effect.gen(function* () {
  const clients: Array<FakeClient> = [];
  const steam = { refusing: false };
  const s = yield* makeSteamSession(() => {
    const c = new FakeClient(steam);
    clients.push(c);
    return c;
  });
  return { s, clients, steam };
});

/** One read, with the clock run past its three timeouts. */
const readThroughTimeouts = <A, E>(read: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(Effect.either(read));
    yield* TestClock.adjust("20 seconds");
    return yield* Fiber.join(fiber);
  });

describe("the Steam session", () => {
  it.scoped("reads a board while Steam answers", () =>
    Effect.gen(function* () {
      const { s } = yield* session;
      const entries = yield* s.players(1, ["76561198000000001"]);
      expect(entries).toEqual([
        {
          steamId: "76561198000000001",
          globalRank: 1,
          score: 1_234_567,
          ugcId: "1234567890123456789",
        },
        { steamId: "76561198000000002", globalRank: 2, score: 1_300_000, ugcId: null },
      ]);
    }).pipe(Effect.provide(config)),
  );

  it.scoped("reads a board's top ranks with how many entries it holds", () =>
    Effect.gen(function* () {
      const { s } = yield* session;
      expect(yield* s.range(1, 1, 3)).toEqual({
        count: 145,
        entries: [
          {
            steamId: "76561198000000001",
            globalRank: 1,
            score: 1_234_567,
            ugcId: "1234567890123456789",
          },
          { steamId: "76561198000000002", globalRank: 2, score: 1_300_000, ugcId: null },
        ],
      });
    }).pipe(Effect.provide(config)),
  );

  it.scoped("logs on with a fresh client once Steam has stopped answering for a while", () =>
    Effect.gen(function* () {
      const { s, clients } = yield* session;
      clients[0]!.dead = true;

      // The first unanswered read starts the clock; nothing is replaced yet.
      expect(Either.isLeft(yield* readThroughTimeouts(s.players(1, ["a"])))).toBe(true);
      yield* TestClock.adjust(FRESH_LOGON_AFTER_MS);
      expect(clients).toHaveLength(1);

      // Still unanswered after that long: the dead client goes and a fresh one logs on.
      expect(Either.isLeft(yield* readThroughTimeouts(s.players(1, ["a"])))).toBe(true);
      expect(clients).toHaveLength(2);
      expect(clients[0]!.loggedOff).toBe(true);

      // Reads go to the fresh client, and Steam answers again.
      expect(yield* s.players(1, ["a"])).toHaveLength(2);
    }).pipe(Effect.provide(config)),
  );

  it.scoped("logs on afresh when the client stays logged off with no reads at all", () =>
    Effect.gen(function* () {
      const { clients } = yield* session;
      // steam-user lost the connection and its own reconnect never came back.
      clients[0]!.steamID = null;
      yield* TestClock.adjust("1 minute");
      expect(clients).toHaveLength(1);
      yield* TestClock.adjust(FRESH_LOGON_AFTER_MS);
      expect(clients).toHaveLength(2);
      expect(clients[1]!.steamID).not.toBeNull();
    }).pipe(Effect.provide(config)),
  );

  it.scoped("tries a failed fresh log on again, no sooner than the wait", () =>
    Effect.gen(function* () {
      const { s, clients, steam } = yield* session;
      clients[0]!.dead = true;
      steam.refusing = true;
      yield* readThroughTimeouts(s.players(1, ["a"]));
      yield* TestClock.adjust(FRESH_LOGON_AFTER_MS);
      yield* readThroughTimeouts(s.players(1, ["a"]));
      expect(clients).toHaveLength(2);
      expect(clients[1]!.loggedOff).toBe(true);

      // Steam takes log ons again; the logged-off client is caught by the session's own check.
      steam.refusing = false;
      yield* TestClock.adjust("1 minute");
      expect(clients).toHaveLength(2);
      yield* TestClock.adjust(FRESH_LOGON_AFTER_MS);
      expect(clients).toHaveLength(3);
      expect(yield* s.players(1, ["a"])).toHaveLength(2);
    }).pipe(Effect.provide(config)),
  );

  it.scoped("counts a failure long after the last one as a new start, not an outage", () =>
    Effect.gen(function* () {
      const { s, clients } = yield* session;
      clients[0]!.dead = true;
      yield* readThroughTimeouts(s.players(1, ["a"]));
      yield* TestClock.adjust("1 hour");
      yield* readThroughTimeouts(s.players(1, ["a"]));
      expect(clients).toHaveLength(1);
    }).pipe(Effect.provide(config)),
  );

  it.scoped("keeps answering through short gaps without logging on again", () =>
    Effect.gen(function* () {
      const { s, clients } = yield* session;
      clients[0]!.dead = true;
      yield* readThroughTimeouts(s.players(1, ["a"]));
      clients[0]!.dead = false;
      expect(yield* s.players(1, ["a"])).toHaveLength(2);
      // The answer cleared the clock, so a later failure starts it afresh.
      yield* TestClock.adjust(FRESH_LOGON_AFTER_MS * 2);
      clients[0]!.dead = true;
      yield* readThroughTimeouts(s.players(1, ["a"]));
      expect(clients).toHaveLength(1);
    }).pipe(Effect.provide(config)),
  );
});
