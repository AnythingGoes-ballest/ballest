// When a run was set, read off its Ghost replay. Steam's leaderboard Entry carries no date, but
// the Ghost a run uploads holds the moment it was set, to the second: the Daily Report dates the
// longest-standing records with it, and the Weekly Cup times its Flags by it.
import { Context, Data, Effect, Layer, Option } from "effect";
import { WebApi } from "./webApi.js";

export class GhostUnavailable extends Data.TaggedError("GhostUnavailable")<{
  readonly reason: string;
}> {}

/** When a ghost replay says its run was set (ms), or None when its stamp was never set. */
export class GhostDates extends Context.Tag("multiballs/GhostDates")<
  GhostDates,
  { readonly setAt: (ugcId: string) => Effect.Effect<Option.Option<number>, GhostUnavailable> }
>() {}

/**
 * A ghost's `timestamp` (Unreal's FDateTime, "2025.11.07-17.25.22", UTC) in ms, or None when it
 * doesn't parse or was never set: an unset one reads "0001.01.01-00.00.00", and anything before
 * 1970 is treated the same.
 */
export const parseGhostStamp = (stamp: string): Option.Option<number> => {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})$/.exec(stamp);
  if (m === null) return Option.none();
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (y === undefined || mo === undefined || d === undefined) return Option.none();
  return y < 1970 ? Option.none() : Option.some(Date.UTC(y, mo - 1, d, h ?? 0, mi ?? 0, s ?? 0));
};

/** Ghost dates through the Steam Web API: the file's CDN address, then the replay itself. */
export const GhostDatesLive = Layer.effect(
  GhostDates,
  Effect.gen(function* () {
    const api = yield* WebApi;
    return GhostDates.of({
      setAt: Effect.fn("GhostDates.setAt")(function* (ugcId: string) {
        return parseGhostStamp(
          yield* api
            .ghostStamp(ugcId)
            .pipe(Effect.mapError((e) => new GhostUnavailable({ reason: e.reason }))),
        );
      }),
    });
  }),
).pipe(Layer.provide(WebApi.Default));
