// A logged-in Steam session and the three leaderboard reads the bot needs.
//
// Three facts shape this file:
// - Leaderboard requests must go ONE AT A TIME. With several in flight, Steam silently drops
//   replies (10% lost at 10 concurrent, 50% at 50). A dropped reply never calls back, so every
//   request has its own timeout and is retried. (The spikes, issue #21, 2026-09-24.)
// - Find-by-name only works with the message header's routing_appid set to the app. (Same.)
// - steam-user's own reconnect after a dropped connection can fail silently and for good: on
//   2026-10-06 the bot lost Steam at 22:09 UTC and every read of a live Lobby failed until it
//   ended. So once requests have gone unanswered, or the client has been logged off, for
//   FRESH_LOGON_AFTER_MS, the session logs on again with a new client.
import { Clock, Config, Data, Effect, Exit, Option, Redacted, Ref, Schedule, Schema } from "effect";
import SteamUser from "steam-user";
import Protos from "steam-user/protobufs/generated/_load.js";
import { SteamUnavailable } from "../ports.js";

export const APP_ID = 3339810;

/** Steam message numbers (steam-user's EMsg table). */
const EMSG_FIND_OR_CREATE_LB = 5416;
export const EMSG_GET_LB_ENTRIES = 5418;
const EResultOK = 1;
/** leaderboard_data_request values. */
const REQUEST_GLOBAL = 0;
const REQUEST_USERS = 3;

const REQUEST_TIMEOUT = "5 seconds";
const REQUEST_RETRIES = 2;
const LOGON_TIMEOUT = "30 seconds";
/** How often the session checks whether its client is logged off. */
const LOGGED_OFF_CHECK = "30 seconds";

/** How long requests may go unanswered before the session logs on again with a new client. */
export const FRESH_LOGON_AFTER_MS = 2 * 60_000;

const FindResponse = Schema.Struct({ eresult: Schema.Number, leaderboard_id: Schema.Number });
const EntriesResponse = Schema.Struct({
  eresult: Schema.Number,
  /** How many entries the whole board holds, whatever range was asked for. */
  leaderboard_entry_count: Schema.Number,
  entries: Schema.Array(
    Schema.Struct({
      steam_id_user: Schema.String,
      global_rank: Schema.Number,
      score: Schema.Number,
      /** The run's Ghost (a UGC handle, as a decimal string), or an invalid handle for none. */
      ugc_id: Schema.String,
    }),
  ),
});

export interface BoardEntry {
  readonly steamId: string;
  readonly globalRank: number;
  /** Run time in hundred-thousandths of a second (SCORE_TICKS_PER_SECOND). */
  readonly score: number;
  /** The run's Ghost replay, as a UGC id, or null when none is attached. */
  readonly ugcId: string | null;
}

/** Steam's "no file" UGC handles: unset (0) and k_UGCHandleInvalid (all ones). */
const NO_UGC = new Set(["0", "18446744073709551615"]);

class NoReply extends Data.TaggedError("NoReply") {}

/**
 * A steam-user client as this file uses it, so a test can stand in for one. `_send` is
 * steam-user's internal send. With `proto` set it writes a protobuf header (routing_appid
 * included); the reply reaches the callback as a ByteBuffer or a Buffer, and a reply Steam
 * drops never calls back. Internal, hence steam-user pinned to an exact version (ADR 0003)
 * and checked for at startup rather than assumed. While logged off (`steamID` null) it drops
 * every message without a word.
 */
export interface SteamClient {
  readonly steamID: object | null;
  _send(
    header: { readonly msg: number; readonly proto: { readonly routing_appid?: number } },
    body: Buffer,
    callback: (reply: Buffer | { toBuffer(): Buffer }) => void,
  ): void;
  logOn(details: { readonly refreshToken: string }): void;
  logOff(): void;
  on(event: "loggedOn", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "disconnected", listener: (eresult: number) => void): unknown;
  once(event: "loggedOn", listener: () => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
  off(event: "loggedOn", listener: () => void): unknown;
  off(event: "error", listener: (err: Error) => void): unknown;
  off(event: "disconnected", listener: (eresult: number) => void): unknown;
}

const hasInternalSend = (client: object): client is Pick<SteamClient, "_send"> =>
  "_send" in client && typeof client._send === "function";

/** A real steam-user client. It reconnects by itself after a dropped connection, mostly. */
export const steamUserClient = (): SteamClient => {
  const client = new SteamUser({ autoRelogin: true });
  if (!hasInternalSend(client)) throw new Error("this steam-user version has no internal _send");
  return client;
};

/** The session over clients from `newClient`: steam-user's in production, a fake in tests. */
export const makeSteamSession = Effect.fn("SteamSession.make")(function* (
  newClient: () => SteamClient,
) {
  const token = yield* Config.redacted("STEAM_REFRESH_TOKEN");

  /** What a client's own reconnects log. Taken off a client once it is replaced. */
  const disconnectedNote = (eresult: number) =>
    console.warn(`[steam] disconnected (${eresult}); steam-user reconnects`);
  const loggedOnAgainNote = () => console.warn("[steam] logged on again");

  /** A new client, logged on. A client whose log on fails or is interrupted is logged off. */
  const connect = Effect.gen(function* () {
    const client = newClient();
    // Without an `error` listener steam-user throws and takes the process down.
    client.on("error", (err) => console.error(`[steam] ${err.message}`));
    client.on("disconnected", disconnectedNote);
    yield* Effect.async<undefined, SteamUnavailable>((resume) => {
      const ok = () => {
        client.off("error", bad);
        resume(Effect.succeed(undefined));
      };
      const bad = (err: Error) => {
        client.off("loggedOn", ok);
        resume(Effect.fail(new SteamUnavailable({ reason: `log on failed: ${err.message}` })));
      };
      client.once("loggedOn", ok);
      client.once("error", bad);
      client.logOn({ refreshToken: Redacted.value(token) });
      return Effect.sync(() => {
        client.off("loggedOn", ok);
        client.off("error", bad);
      });
    }).pipe(
      Effect.timeoutFail({
        duration: LOGON_TIMEOUT,
        onTimeout: () => new SteamUnavailable({ reason: "log on timed out" }),
      }),
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => client.logOff()),
      ),
    );
    // Any later log on is steam-user reconnecting, which otherwise leaves no trace in the log.
    client.on("loggedOn", loggedOnAgainNote);
    return client;
  });

  /** The client in use. Each one replaced is logged off then, and the last at shutdown. */
  const current = yield* Effect.acquireRelease(
    connect.pipe(Effect.flatMap((client) => Ref.make(client))),
    (ref) => Ref.get(ref).pipe(Effect.flatMap((client) => Effect.sync(() => client.logOff()))),
  );
  const oneAtATime = yield* Effect.makeSemaphore(1);
  /** When the current run of failures began; null while Steam answers. */
  const failingSince = yield* Ref.make<number | null>(null);

  /**
   * The old client is logged off first: one account can hold only one session, and a second
   * log on would knock the first off. Its listeners go with it, so its log off isn't logged as
   * a reconnect. If the fresh log on fails, the next failure past FRESH_LOGON_AFTER_MS tries
   * again.
   */
  const logOnAfresh = Effect.fn("SteamSession.logOnAfresh")(function* () {
    yield* Effect.logWarning("[steam] not answering; logging on again with a fresh client");
    const old = yield* Ref.get(current);
    yield* Effect.sync(() => {
      old.off("disconnected", disconnectedNote);
      old.off("loggedOn", loggedOnAgainNote);
      old.logOff();
    });
    // Once logged on, the fresh client is stored even if the caller is interrupted meanwhile.
    const fresh = yield* Effect.uninterruptibleMask((restore) =>
      restore(connect).pipe(
        Effect.tap((client) => Ref.set(current, client)),
        Effect.tapError((e) => Effect.logError(`[steam] fresh log on failed: ${e.reason}`)),
        Effect.option,
      ),
    );
    if (Option.isSome(fresh)) yield* Effect.logInfo("[steam] logged on with a fresh client");
  }, oneAtATime.withPermits(1));

  /**
   * A request went unanswered, or the client is logged off. The first failure starts the
   * clock; one at least FRESH_LOGON_AFTER_MS later logs on afresh and starts it again, so a
   * fresh log on that fails is retried no sooner. A clock left from a failure long ago, with
   * nothing between, starts over rather than counting as an outage.
   */
  const noteFailure = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const due = yield* Ref.modify(failingSince, (since): [boolean, number | null] => {
      if (since === null || now - since > 2 * FRESH_LOGON_AFTER_MS) return [false, now];
      if (now - since < FRESH_LOGON_AFTER_MS) return [false, since];
      return [true, now];
    });
    if (due) yield* logOnAfresh();
  });

  /**
   * A client that stays logged off fails no request while no Match is live, so it is checked
   * on its own: steam-user drops every message while logged off.
   */
  yield* Ref.get(current).pipe(
    Effect.flatMap((client) => (client.steamID === null ? noteFailure : Effect.void)),
    Effect.repeat(Schedule.spaced(LOGGED_OFF_CHECK)),
    Effect.forkScoped,
  );

  /** One leaderboard request: encoded, sent, decoded — alone in flight, with a timeout and retries. */
  const call = Effect.fn("SteamSession.call")(function* <A, I>(
    emsg: number,
    request: string,
    response: string,
    body: object,
    schema: Schema.Schema<A, I>,
    routed: boolean,
  ) {
    const req = Protos[request];
    const res = Protos[response];
    if (req === undefined || res === undefined)
      return yield* Effect.die(`steam-user has no protobuf ${request}/${response}`);
    const send = Ref.get(current).pipe(
      Effect.flatMap((client) =>
        Effect.async<Buffer, NoReply>((resume) => {
          const bytes = Buffer.from(req.encode(req.fromObject(body)).finish());
          client._send(
            { msg: emsg, proto: routed ? { routing_appid: APP_ID } : {} },
            bytes,
            (reply) => resume(Effect.succeed(Buffer.isBuffer(reply) ? reply : reply.toBuffer())),
          );
        }),
      ),
      Effect.timeoutFail({ duration: REQUEST_TIMEOUT, onTimeout: () => new NoReply() }),
    );
    return yield* oneAtATime
      .withPermits(1)(send)
      .pipe(
        Effect.retry({ times: REQUEST_RETRIES }),
        Effect.tapBoth({
          onFailure: () => noteFailure,
          onSuccess: () => Ref.set(failingSince, null),
        }),
        Effect.mapError(() => new SteamUnavailable({ reason: `no reply to ${request}` })),
        Effect.flatMap((bytes) =>
          Schema.decodeUnknown(schema)(
            res.toObject(res.decode(bytes), { longs: String, defaults: true }),
          ),
        ),
        Effect.catchTag("ParseError", (e) =>
          Effect.fail(new SteamUnavailable({ reason: `bad ${response}: ${e.message}` })),
        ),
      );
  });

  const entries = Effect.fn("SteamSession.entries")(function* (
    boardId: number,
    dataRequest: number,
    range: [number, number],
    steamIds: ReadonlyArray<string>,
  ) {
    return yield* call(
      EMSG_GET_LB_ENTRIES,
      "CMsgClientLBSGetLBEntries",
      "CMsgClientLBSGetLBEntriesResponse",
      {
        app_id: APP_ID,
        leaderboard_id: boardId,
        range_start: range[0],
        range_end: range[1],
        leaderboard_data_request: dataRequest,
        steamids: [...steamIds],
      },
      EntriesResponse,
      false,
    ).pipe(
      Effect.filterOrFail(
        (r) => r.eresult === EResultOK,
        (r) => new SteamUnavailable({ reason: `GetLBEntries eresult ${r.eresult}` }),
      ),
      Effect.map((r) => ({
        count: r.leaderboard_entry_count,
        entries: r.entries.map((e): BoardEntry => ({
          steamId: e.steam_id_user,
          globalRank: e.global_rank,
          score: e.score,
          ugcId: NO_UGC.has(e.ugc_id) ? null : e.ugc_id,
        })),
      })),
    );
  });

  return {
    /** A board's id by its exact name; None when no board exists (nobody has finished the Map). */
    findBoard: Effect.fn("SteamSession.findBoard")(function* (name: string) {
      const r = yield* call(
        EMSG_FIND_OR_CREATE_LB,
        "CMsgClientLBSFindOrCreateLB",
        "CMsgClientLBSFindOrCreateLBResponse",
        { app_id: APP_ID, leaderboard_name: name, create_if_not_found: false },
        FindResponse,
        true,
      );
      return r.eresult === EResultOK && r.leaderboard_id !== 0
        ? Option.some(r.leaderboard_id)
        : Option.none();
    }),
    /** Rank 1, if the board has any entry. */
    top: Effect.fn("SteamSession.top")(function* (boardId: number) {
      return yield* entries(boardId, REQUEST_GLOBAL, [1, 1], []).pipe(
        Effect.map((r) => Option.fromNullable(r.entries[0])),
      );
    }),
    /** Ranks `from` to `to`, with how many entries the whole board holds: one request. */
    range: Effect.fn("SteamSession.range")(function* (boardId: number, from: number, to: number) {
      return yield* entries(boardId, REQUEST_GLOBAL, [from, to], []);
    }),
    /** These Players' entries; a Player with no time is simply absent. */
    players: Effect.fn("SteamSession.players")(function* (
      boardId: number,
      steamIds: ReadonlyArray<string>,
    ) {
      return yield* steamIds.length === 0
        ? Effect.succeed<ReadonlyArray<BoardEntry>>([])
        : entries(boardId, REQUEST_USERS, [0, 0], steamIds).pipe(Effect.map((r) => r.entries));
    }),
  } as const;
});

export class SteamSession extends Effect.Service<SteamSession>()("multiballs/SteamSession", {
  scoped: makeSteamSession(steamUserClient),
}) {}
