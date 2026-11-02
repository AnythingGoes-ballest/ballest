// The Steam port on real Steam: the logged-in session for leaderboards, the Web API for the
// Workshop list and profiles. Board ids are cached in SQLite (they never change), and the
// Workshop list is cached for an hour.
import { SqlClient, SqlSchema } from "@effect/sql";
import { Clock, Effect, Layer, Option, Ref, Schema } from "effect";
import { MigratorLive } from "../db.js";
import type { MapInfo } from "../domain.js";
import { ProfileNotFound, Steam, SteamUnavailable, type ProfilePreview } from "../ports.js";
import { SteamSession } from "./session.js";
import { WebApi } from "./webApi.js";

const CATALOGUE_TTL_MS = 60 * 60_000;

/** What a pasted profile says: a SteamID64 outright, or a custom URL name to resolve. */
export type ProfileInput =
  | { readonly _tag: "SteamId"; readonly steamId: string }
  | { readonly _tag: "Vanity"; readonly name: string };

export const parseProfileInput = (input: string): Option.Option<ProfileInput> => {
  const s = input.trim().replace(/\/+$/, "");
  const id = /^(\d{17})$/.exec(s) ?? /steamcommunity\.com\/profiles\/(\d{17})/i.exec(s);
  if (id?.[1] !== undefined) return Option.some({ _tag: "SteamId", steamId: id[1] });
  const vanity = /steamcommunity\.com\/id\/([^/?#]+)/i.exec(s) ?? /^([A-Za-z0-9_-]{2,32})$/.exec(s);
  if (vanity?.[1] !== undefined) return Option.some({ _tag: "Vanity", name: vanity[1] });
  return Option.none();
};

/**
 * The name the Workshop metadata gives is trimmed, but the game names the board from the
 * untrimmed map title, so a title typed with a leading or trailing space only resolves with
 * the space put back (seen once: " dfgzdfgg"). Same rule as find_map_board_id in
 * tools/steampy_common.py.
 */
const boardNameVariants = (name: string): ReadonlyArray<string> => {
  const at = name.indexOf("_Climb_");
  if (at < 0) return [name];
  const prefix = name.slice(0, at + "_Climb_".length);
  const title = name.slice(at + "_Climb_".length);
  return [name, `${prefix} ${title}`, `${prefix}${title} `];
};

const make = Effect.gen(function* () {
  const session = yield* SteamSession;
  const web = yield* WebApi;
  const sql = yield* SqlClient.SqlClient;

  const cachedBoard = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ board_id: Schema.Number }),
    execute: (name) => sql`SELECT board_id FROM board_ids WHERE board_name = ${name}`,
  });

  /** A Map's board id: from the cache, or found by name once and remembered. None: no board yet. */
  const boardIdOf = Effect.fn("Steam.boardIdOf")(function* (map: MapInfo) {
    const hit = yield* cachedBoard(map.boardName).pipe(Effect.orDie);
    if (Option.isSome(hit)) return Option.some(hit.value.board_id);
    for (const name of boardNameVariants(map.boardName)) {
      const found = yield* session.findBoard(name);
      if (Option.isSome(found)) {
        yield* sql`INSERT OR REPLACE INTO board_ids ${sql.insert({ board_name: map.boardName, board_id: found.value })}`.pipe(
          Effect.orDie,
        );
        return found;
      }
    }
    // Not cached: a board appears once someone finishes the Map.
    return Option.none<number>();
  });

  const catalogueCache = yield* Ref.make<
    Option.Option<{ readonly at: number; readonly maps: ReadonlyArray<MapInfo> }>
  >(Option.none());

  return Steam.of({
    catalogue: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = yield* Ref.get(catalogueCache);
      if (Option.isSome(cached) && now - cached.value.at < CATALOGUE_TTL_MS)
        return cached.value.maps;
      const maps = yield* web.workshopMaps();
      yield* Ref.set(catalogueCache, Option.some({ at: now, maps }));
      return maps;
    }),

    check: Effect.fn("Steam.check")(function* (map, steamIds) {
      const boardId = yield* boardIdOf(map);
      if (Option.isNone(boardId)) return { boardId: null, worldRecordTicks: null, played: [] };
      const top = yield* session.top(boardId.value);
      const played = yield* session.players(boardId.value, steamIds);
      return {
        boardId: boardId.value,
        worldRecordTicks: Option.match(top, { onNone: () => null, onSome: (e) => e.score }),
        played: played.map((e) => ({ steamId: e.steamId, ticks: e.score })),
      };
    }),

    readPlayers: Effect.fn("Steam.readPlayers")(function* (boardId, steamIds) {
      return yield* session.players(boardId, steamIds).pipe(
        Effect.map((es) =>
          es.map((e) => ({
            steamId: e.steamId,
            ticks: e.score,
            ...(e.ugcId === null ? {} : { ugcId: e.ugcId }),
          })),
        ),
      );
    }),

    resolveProfile: Effect.fn("Steam.resolveProfile")(function* (input) {
      const parsed = parseProfileInput(input);
      if (Option.isNone(parsed))
        return yield* new ProfileNotFound({
          input,
          reason: "not a Steam profile link, custom URL name or SteamID64",
        });
      const steamId =
        parsed.value._tag === "SteamId"
          ? parsed.value.steamId
          : yield* web.resolveVanity(parsed.value.name).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new ProfileNotFound({ input, reason: "no profile with that custom URL" }),
                    ),
                  onSome: (id) => Effect.succeed(id),
                }),
              ),
            );
      const summary = (yield* web.summaries([steamId]))[0];
      if (summary === undefined)
        return yield* new ProfileNotFound({ input, reason: "no Steam account with that id" });
      let campaignTracks = 0;
      const tracks = yield* web.trackBoardIds();
      for (const boardId of tracks) {
        if ((yield* session.players(boardId, [steamId])).length > 0) campaignTracks++;
      }
      const preview: ProfilePreview = {
        steamId,
        personaName: summary.personaname,
        avatarUrl: summary.avatarfull,
        campaignTracks,
        campaignTrackTotal: tracks.length,
      };
      return preview;
    }),
  });
});

/** The Steam port on real Steam. Needs STEAM_REFRESH_TOKEN, STEAM_API_KEY and a SqlClient. */
export const SteamLive = Layer.effect(Steam, make).pipe(
  Layer.provide(Layer.mergeAll(SteamSession.Default, WebApi.Default, MigratorLive)),
);

export { SteamUnavailable };
