// The standings the Daily Report's image draws, three Workshop standings and Most Daily wins, and
// yesterday's Daily above them: counted by the site, not here (docs/adr/0011), and read from its
// GET /api/standings. A site that can't be reached, or answers with something that isn't the four
// lists and the Daily, fails the day's report as an unreachable database does.
import { Context, Effect, Either, Layer } from "effect";
import { type SiteStandings, WebApi } from "../steam/webApi.js";
import { type SiteStanding, STATS, type Standings, type Stat } from "./report.js";
import { ReportDataUnavailable } from "./source.js";

export class StandingsSource extends Context.Tag("multiballs/StandingsSource")<
  StandingsSource,
  {
    /** The four lists now and at `since` (ms), which the site reads down to the hour. */
    readonly read: (since: number) => Effect.Effect<Standings, ReportDataUnavailable>;
  }
>() {}

/** The site's payload with its players named, or why it can't be read. */
export const standingsFrom = (
  payload: SiteStandings,
): Either.Either<Standings, ReportDataUnavailable> => {
  const lists: Partial<Record<Stat, ReadonlyArray<SiteStanding>>> = {};
  for (const stat of STATS) {
    const rows: Array<SiteStanding> = [];
    const served = stat === "wins" ? payload.daily.wins : payload.lists[stat];
    for (const { player, n, nBefore, place, placeBefore } of served) {
      const named = payload.players[player];
      if (named === undefined)
        return Either.left(
          new ReportDataUnavailable({
            reason: `the site's ${stat} standings name player ${player} of ${payload.players.length}`,
          }),
        );
      rows.push({ steamId: named[0], persona: named[1], n, nBefore, place, placeBefore });
    }
    lists[stat] = rows;
  }
  const latest = payload.daily.latest;
  const top: Array<NonNullable<Standings["yesterday"]>["top"][number]> = [];
  for (const { player, score, rank } of latest?.top ?? []) {
    const named = payload.players[player];
    if (named === undefined)
      return Either.left(
        new ReportDataUnavailable({
          reason: `the site's yesterday's Daily names player ${player} of ${payload.players.length}`,
        }),
      );
    top.push({ steamId: named[0], persona: named[1], score, rank });
  }
  const yesterday = latest === null ? null : { ...latest, top };
  return Either.right({ ...(lists as Record<Stat, ReadonlyArray<SiteStanding>>), yesterday });
};

export const StandingsSourceLive = Layer.effect(
  StandingsSource,
  Effect.gen(function* () {
    const api = yield* WebApi;
    return StandingsSource.of({
      read: Effect.fn("StandingsSource.read")(function* (since: number) {
        const payload = yield* api
          .workshopStandings(since)
          .pipe(
            Effect.mapError(
              (e) => new ReportDataUnavailable({ reason: `the site's standings: ${e.reason}` }),
            ),
          );
        return yield* standingsFrom(payload);
      }),
    });
  }),
).pipe(Layer.provide(WebApi.Default));
