// Each Workshop Map's preview image, for both surfaces: the Card draws it behind the Map's title,
// and the Activity page shows it on the Map's tile and in the Match view. One fetch and one cache
// serve both, so a preview one shows the other shows, and Steam is asked about a Map only when it
// isn't kept (two draws at the same moment can both ask).
import { Clock, Context, Data, Effect, Layer, Option, Ref } from "effect";

/** A preview image as Steam serves it: PNG or JPEG, the formats the Card's renderer can draw. */
export interface Preview {
  readonly type: string;
  readonly body: Uint8Array;
}

/** A preview as the renderer draws it: a data URI. */
export const previewUri = (p: Preview) =>
  `data:${p.type};base64,${Buffer.from(p.body).toString("base64")}`;

/** Steam's image host wouldn't give a preview it can use. */
export class PreviewUnavailable extends Data.TaggedError("PreviewUnavailable")<{
  readonly reason: string;
}> {}

/** Fetching one preview from Steam's image host. */
export class PreviewSource extends Context.Tag("multiballs/PreviewSource")<
  PreviewSource,
  { readonly fetch: (url: string) => Effect.Effect<Preview, PreviewUnavailable> }
>() {}

/** How many previews are kept: far more than there are live Matches at once. */
const KEPT = 50;
/** A preview Steam wouldn't give is asked for again after this long. */
const MISSING_RETRY_MS = 5 * 60_000;

export class MapPreviews extends Effect.Service<MapPreviews>()("multiballs/MapPreviews", {
  effect: Effect.gen(function* () {
    const source = yield* PreviewSource;
    /** Each preview by URL, or None (with when) for one Steam wouldn't give. Oldest first. */
    const kept = yield* Ref.make(
      new Map<string, { readonly preview: Option.Option<Preview>; readonly at: number }>(),
    );

    return {
      /** A Map's preview, or None when there's none to show (the surfaces draw their stand-in). */
      of: Effect.fn("MapPreviews.of")(function* (url: string) {
        if (url === "") return Option.none<Preview>();
        const now = yield* Clock.currentTimeMillis;
        const known = (yield* Ref.get(kept)).get(url);
        if (
          known !== undefined &&
          (Option.isSome(known.preview) || now - known.at < MISSING_RETRY_MS)
        )
          return known.preview;
        const preview = yield* source.fetch(url).pipe(
          Effect.tapError((e) =>
            Effect.logWarning(`no preview at ${url} (${e.reason}); showing the stand-in`),
          ),
          Effect.option,
        );
        yield* Ref.update(kept, (m) => {
          const next = new Map(m);
          next.delete(url);
          next.set(url, { preview, at: now });
          for (const key of next.keys()) if (next.size > KEPT) next.delete(key);
          return next;
        });
        return preview;
      }),
    };
  }),
}) {}

/** The real host: a plain HTTPS fetch, given up after five seconds. */
export const PreviewSourceLive = Layer.succeed(
  PreviewSource,
  PreviewSource.of({
    fetch: Effect.fn("PreviewSource.fetch")(function* (url: string) {
      const response = yield* Effect.tryPromise({
        try: () => fetch(url, { signal: AbortSignal.timeout(5000) }),
        catch: (cause) => new PreviewUnavailable({ reason: String(cause) }),
      });
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !/^image\/(png|jpeg)/.test(type))
        return yield* new PreviewUnavailable({ reason: `${response.status} ${type}` });
      const body = yield* Effect.tryPromise({
        try: () => response.arrayBuffer(),
        catch: (cause) => new PreviewUnavailable({ reason: String(cause) }),
      });
      const preview: Preview = { type, body: new Uint8Array(body) };
      return preview;
    }),
  }),
);
