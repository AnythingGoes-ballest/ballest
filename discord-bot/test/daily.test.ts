import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Ref, TestClock } from "effect";
import { OpsAlerts, opsAlertsOf } from "../src/ops.js";
import { NoChosenSkins } from "../src/chosenSkins.js";
import { MapPreviews, PreviewSource, PreviewUnavailable } from "../src/previews.js";
import { Renderer } from "../src/render/renderer.js";
import type { StandingsImage } from "../src/render/scenes.js";
import { ReportChannel, ReportPostFailed, ThreadPostFailed } from "../src/report/channel.js";
import { dailyLoop, ReportLogLive } from "../src/report/daily.js";
import { GhostDates } from "../src/steam/ghosts.js";
import { DAY_MS, type YesterdayDaily } from "../src/report/report.js";
import { ReportDataUnavailable, ReportSource } from "../src/report/source.js";
import { StandingsSource } from "../src/report/standings.js";

const HOUR = 3_600_000;
const DAY0 = Date.UTC(2026, 9, 4); // midnight UTC, Sunday 4 October
/** Where the channel message's one button goes. */
const YOU = "https://ballestrecords.com/you";
/** The one Map preview the fake Steam gives. */
const PICTURED = "https://images.example.invalid/pictured.png";
const daily = (preview: string | null): YesterdayDaily => ({
  date: "2026-10-03",
  title: "Gully",
  preview,
  players: 2,
  top: [
    { steamId: "amy", persona: "Amy", score: 1_160_400, rank: 1 },
    { steamId: "bob", persona: "Bob", score: 1_163_000, rank: 2 },
  ],
});

/** The schedule over fakes: a database refreshed `refreshedAgo` before each read, a site that
 * records which baselines it was asked for (or is down while `siteDown`), a channel that records
 * what it was given (or fails while `failing`), and the ops channel's messages. */
const setup = Effect.gen(function* () {
  const heads = yield* Ref.make<Array<string>>([]);
  const links = yield* Ref.make<Array<string>>([]);
  const threads = yield* Ref.make(0);
  const alerts = yield* Ref.make<Array<string>>([]);
  const failing = yield* Ref.make(false);
  const threadFailing = yield* Ref.make(false);
  const refreshedAgo = yield* Ref.make(HOUR);
  const siteDown = yield* Ref.make(false);
  const yesterday = yield* Ref.make<YesterdayDaily | null>(null);
  const drawn = yield* Ref.make<Array<StandingsImage["daily"]>>([]);
  const asked = yield* Ref.make<Array<number>>([]);
  const fakes = Layer.mergeAll(
    Layer.succeed(
      ReportSource,
      ReportSource.of({
        read: (at) =>
          Ref.get(refreshedAgo).pipe(
            Effect.map((ago) => ({ maps: [], entries: [], tracks: [], refreshedAt: at - ago })),
          ),
      }),
    ),
    Layer.succeed(
      StandingsSource,
      StandingsSource.of({
        read: (since) =>
          Effect.gen(function* () {
            yield* Ref.update(asked, (a) => [...a, since]);
            if (yield* Ref.get(siteDown))
              return yield* Effect.fail(
                new ReportDataUnavailable({ reason: "the site's standings: ResponseError" }),
              );
            return {
              played: [],
              author: [],
              wr: [],
              wins: [],
              yesterday: yield* Ref.get(yesterday),
            };
          }),
      }),
    ),
    Layer.succeed(GhostDates, GhostDates.of({ setAt: () => Effect.succeed(Option.none()) })),
    Layer.succeed(
      ReportChannel,
      ReportChannel.of({
        post: ({ content, components }) =>
          Effect.gen(function* () {
            if (yield* Ref.get(failing))
              return yield* Effect.fail(new ReportPostFailed({ reason: "Missing Permissions" }));
            yield* Ref.update(heads, (h) => [...h, content.split("\n")[0] ?? ""]);
            yield* Ref.update(links, (l) => [
              ...l,
              components.flatMap((row) => row.components.map((b) => b.url)).join(" "),
            ]);
            const messageId = `m${(yield* Ref.get(heads)).length}`;
            if (yield* Ref.get(threadFailing))
              return yield* Effect.fail(
                new ThreadPostFailed({ messageId, reason: "Missing Create Public Threads" }),
              );
            yield* Ref.update(threads, (n) => n + 1);
            return messageId;
          }),
      }),
    ),
    Layer.succeed(
      OpsAlerts,
      OpsAlerts.make(
        opsAlertsOf({
          configured: true,
          post: (content) => Ref.update(alerts, (a) => [...a, content]),
        }),
      ),
    ),
    ReportLogLive.pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" }))),
    // Drawing runs on a worker, in real time; the schedule is checked on the TestClock.
    Layer.succeed(Renderer, {
      standings: (image: StandingsImage) =>
        Ref.update(drawn, (d) => [...d, image.daily]).pipe(Effect.as(new Uint8Array())),
    } as unknown as Renderer),
    // Steam gives one preview, a PNG of three bytes, and no other
    MapPreviews.Default.pipe(
      Layer.provide(
        Layer.succeed(
          PreviewSource,
          PreviewSource.of({
            fetch: (url) =>
              url === PICTURED
                ? Effect.succeed({ type: "image/png", body: new Uint8Array([1, 2, 3]) })
                : Effect.fail(new PreviewUnavailable({ reason: "404" })),
          }),
        ),
      ),
    ),
    NoChosenSkins,
  );
  return {
    heads,
    links,
    threads,
    alerts,
    failing,
    threadFailing,
    refreshedAgo,
    siteDown,
    yesterday,
    drawn,
    asked,
    fakes,
  };
});

/** Run the schedule from the TestClock's current time until `ms` later, then stop it. */
const runFor = (ms: number) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(dailyLoop);
    yield* TestClock.adjust(ms);
    yield* Fiber.interrupt(fiber);
  });

describe("the Daily Report's schedule", () => {
  it.scoped("posts at 16:00 UTC every day", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(DAY0 + 10 * HOUR);
        yield* runFor(5 * HOUR);
        expect(yield* Ref.get(t.heads)).toEqual([]);
        yield* runFor(2 * HOUR + DAY_MS);
        expect(yield* Ref.get(t.heads)).toEqual(["# Sunday 4 October", "# Monday 5 October"]);
        expect(yield* Ref.get(t.links)).toEqual([YOU, YOU]);
        expect(yield* Ref.get(t.threads)).toBe(2);
      }).pipe(Effect.provide(t.fakes));
    }),
  );

  it.scoped("draws yesterday's Daily's preview, or the stand-in when Steam won't give it", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(DAY0 + 10 * HOUR);
        yield* runFor(5 * HOUR);
        yield* Ref.set(t.yesterday, daily(PICTURED));
        yield* runFor(2 * HOUR);
        yield* Ref.set(t.yesterday, daily("https://images.example.invalid/gone.png"));
        yield* runFor(DAY_MS);
        yield* Ref.set(t.yesterday, null);
        yield* runFor(DAY_MS);
        const drawn = yield* Ref.get(t.drawn);
        expect(drawn.map((d) => d?.preview)).toEqual([
          "data:image/png;base64,AQID",
          null,
          undefined,
        ]);
        expect(drawn[0]?.rows.map((r) => [r.name, r.gap, r.time])).toEqual([
          ["Amy", null, "11.604"],
          ["Bob", "+0.026", "11.630"],
        ]);
      }).pipe(Effect.provide(t.fakes));
    }),
  );

  it.scoped("compares the standings with 24 hours before the post", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(DAY0 + 10 * HOUR);
        yield* runFor(7 * HOUR);
        expect(yield* Ref.get(t.asked)).toEqual([DAY0 + 16 * HOUR - DAY_MS]);
      }).pipe(Effect.provide(t.fakes));
    }),
  );

  it.scoped("tells ops when the site's standings can't be read, and tries again next start", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* Ref.set(t.siteDown, true);
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(DAY0 + 18 * HOUR);
        yield* runFor(HOUR);
        expect(yield* Ref.get(t.heads)).toEqual([]);
        expect(yield* Ref.get(t.alerts)).toEqual([
          "Multiballs couldn't post the Daily Report for 2026-10-04: the site's standings: ResponseError",
        ]);
        yield* Ref.set(t.siteDown, false);
        yield* runFor(HOUR);
        expect(yield* Ref.get(t.heads)).toEqual(["# Sunday 4 October"]);
      }).pipe(Effect.provide(t.fakes));
    }),
  );

  it.scoped("catches up once after a late start, and never posts a day twice", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(DAY0 + 18 * HOUR);
        yield* runFor(HOUR);
        yield* runFor(HOUR); // a restart the same evening
        expect(yield* Ref.get(t.heads)).toEqual(["# Sunday 4 October"]);
        expect(yield* Ref.get(t.links)).toEqual([YOU]);
      }).pipe(Effect.provide(t.fakes));
    }),
  );

  it.scoped("skips a day whose data is over two days old, and tells ops", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* Ref.set(t.refreshedAgo, 3 * DAY_MS);
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(DAY0 + 18 * HOUR);
        yield* runFor(HOUR);
        expect(yield* Ref.get(t.heads)).toEqual([]);
        expect(yield* Ref.get(t.alerts)).toEqual([
          expect.stringContaining("skipped the Daily Report for 2026-10-04"),
        ]);
      }).pipe(Effect.provide(t.fakes));
    }),
  );

  it.scoped("tells ops when a post fails, and tries again on the next start", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* Ref.set(t.failing, true);
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(DAY0 + 18 * HOUR);
        yield* runFor(HOUR);
        expect(yield* Ref.get(t.alerts)).toEqual([
          expect.stringContaining(
            "couldn't post the Daily Report for 2026-10-04: Missing Permissions",
          ),
        ]);
        yield* Ref.set(t.failing, false);
        yield* runFor(HOUR);
        expect(yield* Ref.get(t.heads)).toEqual(["# Sunday 4 October"]);
      }).pipe(Effect.provide(t.fakes));
    }),
  );

  it.scoped("keeps a report whose thread failed, and tells ops", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* Ref.set(t.threadFailing, true);
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(DAY0 + 18 * HOUR);
        yield* runFor(HOUR);
        yield* runFor(HOUR); // a restart: the day is posted, thread or not
        expect(yield* Ref.get(t.heads)).toEqual(["# Sunday 4 October"]);
        expect(yield* Ref.get(t.alerts)).toEqual([
          expect.stringContaining("posted the Daily Report for 2026-10-04, but not its thread"),
        ]);
      }).pipe(Effect.provide(t.fakes));
    }),
  );
});
