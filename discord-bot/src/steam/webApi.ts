// Steam Web API calls (plain HTTPS with the API key), plus two reads from our own site: the
// Circuit Track boards (GET /api/tracks), so the bot never keeps a second copy of the board table,
// and the Workshop standings (GET /api/standings), which the site counts (docs/adr/0011).
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import { Config, Effect, Option, Redacted, Schedule, Schema } from "effect";
import type { MapInfo } from "../domain.js";
import { SteamUnavailable } from "../ports.js";
import { APP_ID } from "./session.js";

const PAGE_SIZE = 100;
const SUMMARIES_PER_CALL = 100;

const QueryFilesPage = Schema.Struct({
  response: Schema.Struct({
    next_cursor: Schema.optional(Schema.String),
    publishedfiledetails: Schema.optionalWith(
      Schema.Array(
        Schema.Struct({
          publishedfileid: Schema.String,
          title: Schema.optionalWith(Schema.String, { default: () => "" }),
          creator: Schema.String,
          preview_url: Schema.optionalWith(Schema.String, { default: () => "" }),
          metadata: Schema.optionalWith(Schema.String, { default: () => "" }),
        }),
      ),
      { default: () => [] },
    ),
  }),
});

/** IPublishedFileService/GetDetails: the same fields as a QueryFiles page, for the ids asked. */
const FileDetails = Schema.Struct({
  response: Schema.Struct({
    publishedfiledetails: QueryFilesPage.fields.response.fields.publishedfiledetails,
  }),
});

/** The game writes each Map's board name and Medal times into its Workshop metadata. */
const BallestMetadata = Schema.parseJson(
  Schema.Struct({
    ballest: Schema.Struct({
      leaderboard_name_current: Schema.String,
      medal_times_by_index: Schema.Tuple(
        Schema.Number,
        Schema.Number,
        Schema.Number,
        Schema.Number,
      ),
    }),
  }),
);
const decodeMetadata = Schema.decodeUnknownOption(BallestMetadata);

const Summaries = Schema.Struct({
  response: Schema.Struct({
    players: Schema.Array(
      Schema.Struct({
        steamid: Schema.String,
        personaname: Schema.String,
        avatarfull: Schema.optionalWith(Schema.String, { default: () => "" }),
      }),
    ),
  }),
});
export type Summary = (typeof Summaries.Type)["response"]["players"][number];

const Vanity = Schema.Struct({
  response: Schema.Struct({ success: Schema.Number, steamid: Schema.optional(Schema.String) }),
});

/** Where a UGC file (a ghost replay) can be downloaded. */
const UgcDetails = Schema.Struct({ data: Schema.Struct({ url: Schema.String }) });
/** A ghost replay is plain JSON; only its stamp is read. */
const Ghost = Schema.Struct({ timestamp: Schema.String });

/** The leaderboard site's GET /api/tracks: every Circuit Track's board, in the site's order. */
const SiteTracks = Schema.Struct({
  tracks: Schema.Array(Schema.Struct({ name: Schema.String, leaderboardId: Schema.Number })),
});

/** One player on one of the site's Workshop standings. The site serves it as a tuple, [index into
 * players, count now, count at the baseline, shared place now, shared place at the baseline]
 * (standingRow in web/lib/workshop-standings.ts); this names its fields, the one place that reads
 * them by position. */
const SiteStandingRow = Schema.transform(
  Schema.Tuple(Schema.Number, Schema.Number, Schema.Number, Schema.Number, Schema.Number),
  Schema.Struct({
    player: Schema.Number,
    n: Schema.Number,
    nBefore: Schema.Number,
    place: Schema.Number,
    placeBefore: Schema.Number,
  }),
  {
    strict: true,
    decode: ([player, n, nBefore, place, placeBefore]) => ({
      player,
      n,
      nBefore,
      place,
      placeBefore,
    }),
    encode: (r) => [r.player, r.n, r.nBefore, r.place, r.placeBefore] as const,
  },
);
const SiteStandingList = Schema.Array(SiteStandingRow);

/** The newest final Daily as the site serves it (web/lib/rows.ts, LatestDaily): its Map, its
 * player count, and its top 10 as its board ranks it, each an index into `players`, the score in
 * ticks and the rank. */
const SiteLatestDaily = Schema.Struct({
  date: Schema.String,
  title: Schema.String,
  preview: Schema.NullOr(Schema.String),
  players: Schema.Number,
  top: Schema.Array(
    Schema.Struct({ player: Schema.Number, score: Schema.Number, rank: Schema.Number }),
  ),
});

/** The leaderboard site's GET /api/standings (web/lib/rows.ts, StandingsPayload): the Workshop
 * standings the report draws and, beside them, Most Daily wins, now and at a baseline, each list
 * in the site's order, and the newest final Daily (null while none is final). The site also
 * serves top 5s, which the report no longer reads. */
export const SiteStandings = Schema.Struct({
  readAt: Schema.NullOr(Schema.String),
  since: Schema.String,
  maps: Schema.Number,
  players: Schema.Array(Schema.Tuple(Schema.String, Schema.String)),
  lists: Schema.Struct({
    played: SiteStandingList,
    author: SiteStandingList,
    wr: SiteStandingList,
  }),
  daily: Schema.Struct({ wins: SiteStandingList, latest: Schema.NullOr(SiteLatestDaily) }),
});
export type SiteStandings = typeof SiteStandings.Type;

export class WebApi extends Effect.Service<WebApi>()("multiballs/WebApi", {
  effect: Effect.gen(function* () {
    const key = yield* Config.redacted("STEAM_API_KEY");
    const site = yield* Config.string("SITE_URL").pipe(
      Config.withDefault("https://ballestrecords.com"),
    );
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({ schedule: Schedule.exponential("500 millis"), times: 3 }),
    );
    const getJson = Effect.fn("WebApi.getJson")(function* <A, I>(
      url: string,
      params: Record<string, string>,
      schema: Schema.Schema<A, I>,
    ) {
      return yield* http.execute(HttpClientRequest.get(url, { urlParams: params })).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.scoped,
        Effect.mapError(
          (e) => new SteamUnavailable({ reason: `${new URL(url).pathname}: ${e._tag}` }),
        ),
      );
    });
    const steamApi = Effect.fn("WebApi.steamApi")(function* <A, I>(
      path: string,
      params: Record<string, string>,
      schema: Schema.Schema<A, I>,
    ) {
      return yield* getJson(
        `https://api.steampowered.com${path}`,
        { key: Redacted.value(key), ...params },
        schema,
      );
    });

    const summaries = Effect.fn("WebApi.summaries")(function* (steamIds: ReadonlyArray<string>) {
      const out: Array<Summary> = [];
      for (let i = 0; i < steamIds.length; i += SUMMARIES_PER_CALL) {
        const body = yield* steamApi(
          "/ISteamUser/GetPlayerSummaries/v2/",
          { steamids: steamIds.slice(i, i + SUMMARIES_PER_CALL).join(",") },
          Summaries,
        );
        out.push(...body.response.players);
      }
      return out;
    });

    return {
      /** Every published Workshop Map with usable Ballest metadata, creators named. */
      workshopMaps: Effect.fn("WebApi.workshopMaps")(function* () {
        const files: Array<
          (typeof QueryFilesPage.Type)["response"]["publishedfiledetails"][number]
        > = [];
        const seen = new Set<string>();
        let cursor = "*";
        while (true) {
          const page = yield* steamApi(
            "/IPublishedFileService/QueryFiles/v1/",
            {
              appid: String(APP_ID),
              query_type: "1",
              numperpage: String(PAGE_SIZE),
              cursor,
              return_metadata: "1",
            },
            QueryFilesPage,
          );
          const batch = page.response.publishedfiledetails;
          for (const f of batch) {
            if (seen.has(f.publishedfileid)) continue;
            seen.add(f.publishedfileid);
            files.push(f);
          }
          const next = page.response.next_cursor;
          if (batch.length === 0 || next === undefined || next === cursor) break;
          cursor = next;
        }
        const creators = new Map(
          (yield* summaries([...new Set(files.map((f) => f.creator))])).map((s) => [
            s.steamid,
            s.personaname,
          ]),
        );
        return files.flatMap((f): Array<MapInfo> =>
          Option.match(decodeMetadata(f.metadata), {
            onNone: () => [],
            onSome: ({ ballest }) => {
              const [bronze, silver, gold, author] = ballest.medal_times_by_index;
              return [
                {
                  pfid: f.publishedfileid,
                  title: f.title,
                  creator: creators.get(f.creator) ?? "",
                  previewUrl: f.preview_url,
                  boardName: ballest.leaderboard_name_current,
                  medals: { bronze, silver, gold, author },
                },
              ];
            },
          }),
        );
      }),

      /** One Workshop Map by its id, creator named; None without usable Ballest metadata. */
      workshopMap: Effect.fn("WebApi.workshopMap")(function* (pfid: string) {
        const body = yield* steamApi(
          "/IPublishedFileService/GetDetails/v1/",
          { "publishedfileids[0]": pfid, includemetadata: "true", appid: String(APP_ID) },
          FileDetails,
        );
        const file = body.response.publishedfiledetails[0];
        if (file === undefined) return Option.none<MapInfo>();
        const creator = (yield* summaries([file.creator]))[0]?.personaname ?? "";
        return Option.map(decodeMetadata(file.metadata), ({ ballest }): MapInfo => {
          const [bronze, silver, gold, author] = ballest.medal_times_by_index;
          return {
            pfid: file.publishedfileid,
            title: file.title,
            creator,
            previewUrl: file.preview_url,
            boardName: ballest.leaderboard_name_current,
            medals: { bronze, silver, gold, author },
          };
        });
      }),

      /** A custom URL name to a SteamID64, or None. */
      resolveVanity: Effect.fn("WebApi.resolveVanity")(function* (name: string) {
        const body = yield* steamApi(
          "/ISteamUser/ResolveVanityURL/v1/",
          { vanityurl: name },
          Vanity,
        );
        return body.response.success === 1
          ? Option.fromNullable(body.response.steamid)
          : Option.none<string>();
      }),

      summaries,

      /** The `timestamp` inside a record's ghost replay, as written (see parseGhostStamp). */
      ghostStamp: Effect.fn("WebApi.ghostStamp")(function* (ugcId: string) {
        const file = yield* steamApi(
          "/ISteamRemoteStorage/GetUGCFileDetails/v1/",
          { appid: String(APP_ID), ugcid: ugcId },
          UgcDetails,
        );
        return (yield* getJson(file.data.url, {}, Ghost)).timestamp;
      }),

      /** The Circuit Track boards' ids, as the leaderboard site lists them (GET /api/tracks). */
      trackBoardIds: Effect.fn("WebApi.trackBoardIds")(function* () {
        const { tracks } = yield* getJson(`${site}/api/tracks`, {}, SiteTracks);
        return tracks.map((t) => t.leaderboardId);
      }),

      /** The Workshop standings now and at `since` (ms), as the site counts them. */
      workshopStandings: Effect.fn("WebApi.workshopStandings")(function* (since: number) {
        return yield* getJson(`${site}/api/standings`, { since: String(since) }, SiteStandings);
      }),
    } as const;
  }),
  dependencies: [FetchHttpClient.layer],
}) {}
