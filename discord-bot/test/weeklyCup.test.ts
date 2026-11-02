// The Weekly Cup's schedule (spec #353, ticket #356) over fakes on the TestClock: the Cup's
// channel and the ops channel, with the Cup's record in SQLite in memory, kept across restarts.
// The week of Monday 26 October 2026 runs across the November clock change.
import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Fiber, Layer, Option, Random, Ref, TestClock } from "effect";
import { OpsAlerts, opsAlertsOf } from "../src/ops.js";
import { Steam, SteamUnavailable } from "../src/ports.js";
import { MapPreviews, PreviewSource } from "../src/previews.js";
import { GhostDates } from "../src/steam/ghosts.js";
import {
  CupChannel,
  CupLinks,
  type CupNotice,
  CupPostFailed,
  type CupPostView,
  type ShortlistView,
  type SkipAsk,
  type Slot,
  type StandingsView,
} from "../src/weeklyCup/model.js";
import { CupLogLive } from "../src/weeklyCup/record.js";
import { makeWeeklyCup } from "../src/weeklyCup/schedule.js";
import { makeFakeSteam, makeMap } from "./harness.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GUILD = "g-racing";
const WEEK = "2026-10-26";
/** Monday 26 October 00:00 Central (CDT). */
const MONDAY = Date.parse("2026-10-26T05:00:00Z");
/** Thursday 29 October 12:00 Central. */
const THURSDAY_NOON = Date.parse("2026-10-29T17:00:00Z");
/** Friday 30 October 09:00 Central. */
const FRIDAY_NINE = Date.parse("2026-10-30T14:00:00Z");
/** Sunday 1 November 20:00 Central (CST, the clocks went back that morning). */
const SUNDAY_EIGHT = Date.parse("2026-11-02T02:00:00Z");
/** Monday 2 November 00:00 Central. */
const NEXT_MONDAY = Date.parse("2026-11-02T06:00:00Z");

const asked = (a: SkipAsk) => (a._tag === "Confirm" ? "ConfirmSkip" : a.text);

const steamIdOf = (discordId: string) => `s-${discordId}`;
/** Twelve Workshop Maps that fit the Cup: author time 20 s, world record 15 s. */
const ELIGIBLE = Array.from({ length: 12 }, (_, i) => makeMap(i + 1));

/**
 * The Cup's world: a channel that records each post, edit and notice (or refuses while
 * `channelDown`), and the ops channel. One database for the whole test, so a restart finds what
 * the run before it recorded.
 */
const setup = Effect.gen(function* () {
  const channelDown = yield* Ref.make(false);
  const posts = yield* Ref.make<Array<{ at: number; view: CupPostView }>>([]);
  const edits = yield* Ref.make<Array<{ at: number; messageId: string; view: CupPostView }>>([]);
  const notices = yield* Ref.make<Array<{ at: number; notice: CupNotice }>>([]);
  const shortlists = yield* Ref.make<Array<{ at: number; view: ShortlistView }>>([]);
  const shortlistEdits = yield* Ref.make<
    Array<{ at: number; messageId: string; view: ShortlistView }>
  >([]);
  /** The standings message: its post and each edit, in order. */
  const standings = yield* Ref.make<Array<{ at: number; messageId: string; view: StandingsView }>>(
    [],
  );
  const results = yield* Ref.make<Array<{ at: number; view: StandingsView }>>([]);
  const alerts = yield* Ref.make<Array<string>>([]);
  const refused = Effect.flatMap(Ref.get(channelDown), (down) =>
    down ? Effect.fail(new CupPostFailed({ reason: "Missing Permissions" })) : Effect.void,
  );
  /**
   * Messages someone deleted from the channel: the channel shows their slot afresh, as the real one
   * does on Unknown Message.
   */
  const deleted = new Set<string>();
  /** Each Cup post's `replacing`, in order: the deleted message it stands in for, if any. */
  const replacing: Array<string | null> = [];
  /** What each message shows: like the real channel, an edit that changes nothing isn't made. */
  const showing = new Map<string, string>();
  const PREFIX: Record<Slot, string> = { post: "m", shortlist: "s", standings: "st", results: "r" };
  const counts: Record<Slot, number> = { post: 0, shortlist: 0, standings: 0, results: 0 };
  // The Workshop: 12 Eligible Maps unless a test sets its own; every member linked as s-<id>.
  const steam = yield* makeFakeSteam({});
  yield* steam.control.setCatalogue(ELIGIBLE);
  const unlinked = new Set<string>();
  const steamDown = yield* Ref.make(false);
  const fakes = Layer.mergeAll(
    Layer.succeed(Steam, {
      ...steam.port,
      catalogue: Effect.flatMap(Ref.get(steamDown), (down) =>
        down ? Effect.fail(new SteamUnavailable({ reason: "no reply" })) : steam.port.catalogue,
      ),
    }),
    Layer.succeed(GhostDates, steam.ghosts),
    Layer.succeed(
      CupLinks,
      CupLinks.of({
        steamIdOf: (id) =>
          Effect.succeed(unlinked.has(id) ? Option.none() : Option.some(steamIdOf(id))),
      }),
    ),
    MapPreviews.Default.pipe(
      Layer.provide(
        Layer.succeed(
          PreviewSource,
          PreviewSource.of({
            fetch: () => Effect.succeed({ type: "image/png", body: new Uint8Array([1]) }),
          }),
        ),
      ),
    ),
    Layer.succeed(
      CupChannel,
      CupChannel.of({
        show: (slot, shown, view, options) =>
          Effect.gen(function* () {
            yield* refused;
            const at = yield* Clock.currentTimeMillis;
            const drawn = JSON.stringify(view);
            const first = shown[0];
            if (first !== undefined && deleted.has(first) && options?.repost === false)
              return yield* Effect.fail(new CupPostFailed({ reason: "Unknown Message" }));
            if (first === undefined || deleted.has(first)) {
              const messageId = `${PREFIX[slot]}${++counts[slot]}`;
              showing.set(messageId, drawn);
              const v = view as never;
              if (slot === "post") {
                replacing.push(first ?? null);
                yield* Ref.update(posts, (p) => [...p, { at, view: v }]);
              }
              if (slot === "shortlist")
                yield* Ref.update(shortlists, (s) => [...s, { at, view: v }]);
              if (slot === "standings")
                yield* Ref.update(standings, (s) => [...s, { at, messageId, view: v }]);
              if (slot === "results") yield* Ref.update(results, (r) => [...r, { at, view: v }]);
              return [messageId];
            }
            if (showing.get(first) !== drawn) {
              showing.set(first, drawn);
              const v = view as never;
              const messageId = first;
              if (slot === "post")
                yield* Ref.update(edits, (e) => [...e, { at, messageId, view: v }]);
              if (slot === "shortlist")
                yield* Ref.update(shortlistEdits, (e) => [...e, { at, messageId, view: v }]);
              if (slot === "standings")
                yield* Ref.update(standings, (s) => [...s, { at, messageId, view: v }]);
            }
            return shown;
          }),
        say: (notice) =>
          Effect.gen(function* () {
            yield* refused;
            const at = yield* Clock.currentTimeMillis;
            yield* Ref.update(notices, (n) => [...n, { at, notice }]);
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
  );
  const log = yield* Layer.build(
    CupLogLive.pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" }))),
  );
  /**
   * Start the bot: the Cup's schedule runs until `stop`, as a deploy would end it. Its draws and
   * tie-breaks come from a Random seeded with `seed`, so two worlds started alike draw alike.
   */
  const startWith = (seed: number) =>
    Effect.gen(function* () {
      const cup = yield* makeWeeklyCup(GUILD);
      const fiber = yield* Effect.fork(cup.run.pipe(Effect.withRandom(Random.make(seed))));
      yield* TestClock.adjust(1);
      return {
        signUp: (who: string) => cup.signUp(WEEK, who),
        withdraw: (who: string) => cup.withdraw(WEEK, who),
        askSkip: (who: string, manageServer: boolean) =>
          cup.askSkip(WEEK, who, manageServer).pipe(Effect.map(asked)),
        skip: (who: string, manageServer: boolean) => cup.skip(WEEK, who, manageServer),
        vote: (who: string, picks: ReadonlyArray<string>) => cup.vote(WEEK, who, picks),
        stop: Fiber.interrupt(fiber),
      };
    }).pipe(Effect.provide(fakes), Effect.provide(log));
  const start = startWith(1);
  /** Start the bot, run it for `ms`, then stop it. */
  const runFor = (ms: number, seed = 1) =>
    Effect.gen(function* () {
      const bot = yield* startWith(seed);
      yield* TestClock.adjust(ms);
      yield* bot.stop;
    });
  const lastView = Effect.gen(function* () {
    const shown = [...(yield* Ref.get(posts)), ...(yield* Ref.get(edits))].sort(
      (a, b) => a.at - b.at,
    );
    return shown.at(-1)?.view;
  });
  return {
    channelDown,
    deleted,
    replacing,
    steamDown,
    steam: steam.control,
    unlinked,
    posts,
    edits,
    notices,
    shortlists,
    shortlistEdits,
    standings,
    results,
    alerts,
    start,
    startWith,
    runFor,
    lastView,
  };
});

describe("the Weekly Cup's schedule", () => {
  it.scoped("posts the week's Cup at Monday 00:00 Central, open for sign-up", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* TestClock.setTime(MONDAY - 3 * HOUR);
      yield* t.runFor(2 * 24 * HOUR);
      const posts = yield* Ref.get(t.posts);
      expect(posts.map((p) => p.at)).toEqual([MONDAY]);
      expect(posts[0]?.view).toMatchObject({
        guildId: GUILD,
        state: "open",
        entrants: [],
        week: { week: WEEK, shortlistAt: THURSDAY_NOON, endsAt: SUNDAY_EIGHT },
      });
      expect(yield* Ref.get(t.edits)).toEqual([]);
    }),
  );

  it.scoped("posts at once when it starts mid-week, before Thursday 12:00", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* TestClock.setTime(MONDAY + 30 * HOUR);
      yield* t.runFor(HOUR);
      expect((yield* Ref.get(t.posts)).map((p) => p.at)).toEqual([MONDAY + 30 * HOUR]);
    }),
  );

  it.scoped("posts nothing for a week it first starts in after Thursday 12:00", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* TestClock.setTime(THURSDAY_NOON + HOUR);
      yield* t.runFor(NEXT_MONDAY - THURSDAY_NOON);
      const posts = yield* Ref.get(t.posts);
      expect(posts.map((p) => [p.at, p.view.week.week])).toEqual([[NEXT_MONDAY, "2026-11-02"]]);
    }),
  );

  it.scoped("signs Entrants up and lets them withdraw, redrawing the post each time", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* TestClock.setTime(MONDAY);
      const bot = yield* t.start;
      expect(yield* bot.signUp("alice")).toContain("You're signed up");
      expect(yield* bot.signUp("bob")).toContain("You're signed up");
      expect(yield* bot.signUp("alice")).toBe("You're already signed up for this week's Cup.");
      expect(yield* bot.withdraw("bob")).toBe(
        "You've withdrawn from this week's Weekly Cup. Sign up again any time before it ends.",
      );
      expect(yield* bot.withdraw("bob")).toBe("You're not signed up for this week's Cup.");
      const edits = yield* Ref.get(t.edits);
      expect(edits.map((e) => [e.messageId, e.view.entrants])).toEqual([
        ["m1", ["alice"]],
        ["m1", ["alice", "bob"]],
        ["m1", ["alice"]],
      ]);
      yield* bot.stop;
    }),
  );

  it.scoped("tells ops each time a call-off notice is refused, week after week", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* TestClock.setTime(MONDAY);
      const bot = yield* t.start;
      /** Thursday 12:00 of the week opening at `monday`, the channel refusing over it. */
      const refusedAt = (monday: number) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(monday + (THURSDAY_NOON - MONDAY) - MINUTE);
          yield* Ref.set(t.channelDown, true);
          yield* TestClock.adjust(2 * MINUTE);
          yield* Ref.set(t.channelDown, false);
        });
      yield* refusedAt(MONDAY);
      yield* TestClock.setTime(NEXT_MONDAY + HOUR);
      yield* refusedAt(NEXT_MONDAY);
      const told = (yield* Ref.get(t.alerts)).filter((a) =>
        a.startsWith("Multiballs couldn't tell the Weekly Cup's Entrants it was cancelled"),
      );
      expect(told).toHaveLength(2);
      yield* bot.stop;
    }),
  );

  it.scoped("cancels a week with fewer than 2 Entrants at Thursday 12:00, and says so", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* TestClock.setTime(MONDAY);
      const bot = yield* t.start;
      yield* bot.signUp("alice");
      yield* TestClock.adjust(THURSDAY_NOON - MONDAY);
      expect((yield* t.lastView)?.state).toBe("cancelled");
      const notices = yield* Ref.get(t.notices);
      expect(notices).toEqual([
        {
          at: THURSDAY_NOON,
          notice: { _tag: "Cancelled", reason: "entrants", week: WEEK, entrants: ["alice"] },
        },
      ]);
      expect(yield* bot.signUp("bob")).toBe(
        "This week's Weekly Cup was cancelled. The next one opens on Monday.",
      );
      // Nothing more that week; the next week's Cup goes up on its Monday.
      yield* TestClock.adjust(NEXT_MONDAY - THURSDAY_NOON);
      expect((yield* Ref.get(t.posts)).map((p) => p.at)).toEqual([MONDAY, NEXT_MONDAY]);
      expect(yield* Ref.get(t.notices)).toHaveLength(1);
      yield* bot.stop;
    }),
  );

  it.scoped("goes on with 2 Entrants, takes late sign-ups, and closes at Sunday 20:00", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* TestClock.setTime(MONDAY);
      const bot = yield* t.start;
      yield* bot.signUp("alice");
      yield* bot.signUp("bob");
      yield* TestClock.adjust(THURSDAY_NOON - MONDAY);
      expect(yield* Ref.get(t.notices)).toEqual([]);
      expect((yield* t.lastView)?.state).toBe("voting");
      yield* TestClock.adjust(FRIDAY_NINE - THURSDAY_NOON + HOUR);
      expect(yield* bot.signUp("carol")).toContain("You're signed up");
      expect((yield* t.lastView)?.state).toBe("racing");
      // Down over the weekend (5-minute reads are slow on the TestClock), up for its close.
      yield* bot.stop;
      yield* TestClock.setTime(SUNDAY_EIGHT - HOUR);
      const again = yield* t.start;
      yield* TestClock.adjust(HOUR);
      const closed = (yield* Ref.get(t.edits)).at(-1);
      expect(closed).toMatchObject({
        at: SUNDAY_EIGHT,
        view: { state: "final", entrants: ["alice", "bob", "carol"] },
      });
      expect(yield* again.signUp("dave")).toBe("This week's Weekly Cup is over.");
      yield* again.stop;
    }),
  );

  it.scoped("lets only a server admin skip the week, after asking, and tells its Entrants", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* TestClock.setTime(MONDAY);
      const bot = yield* t.start;
      yield* bot.signUp("alice");
      yield* bot.signUp("bob");
      expect(yield* bot.askSkip("bob", false)).toBe(
        "Only a server admin (Manage Server) can skip a week.",
      );
      expect(yield* bot.skip("bob", false)).toBe(
        "Only a server admin (Manage Server) can skip a week.",
      );
      expect(yield* bot.askSkip("admin", true)).toBe("ConfirmSkip");
      expect((yield* t.lastView)?.state).toBe("open");
      expect(yield* bot.skip("admin", true)).toBe(
        "Skipped this week's Weekly Cup. Its Entrants have been told.",
      );
      expect((yield* t.lastView)?.state).toBe("skipped");
      expect((yield* Ref.get(t.notices)).map((n) => n.notice)).toEqual([
        { _tag: "Skipped", week: WEEK, entrants: ["alice", "bob"] },
      ]);
      expect(yield* bot.signUp("carol")).toBe(
        "This week's Weekly Cup was skipped. The next one opens on Monday.",
      );
      // Thursday changes nothing for a skipped week.
      yield* TestClock.adjust(NEXT_MONDAY - MONDAY);
      expect(yield* Ref.get(t.notices)).toHaveLength(1);
      expect((yield* Ref.get(t.posts)).map((p) => p.at)).toEqual([MONDAY, NEXT_MONDAY]);
      yield* bot.stop;
    }),
  );

  it.scoped("can't skip a week once its Shortlist is due", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* TestClock.setTime(MONDAY);
      const bot = yield* t.start;
      yield* bot.signUp("alice");
      yield* bot.signUp("bob");
      yield* TestClock.adjust(THURSDAY_NOON - MONDAY);
      expect(yield* bot.askSkip("admin", true)).toBe(
        "This week's Weekly Cup is already under way, so it can't be skipped now.",
      );
      expect(yield* bot.skip("admin", true)).toBe(
        "This week's Weekly Cup is already under way, so it can't be skipped now.",
      );
      yield* bot.stop;
    }),
  );

  it.scoped("answers a press on an earlier week's post as over", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* TestClock.setTime(NEXT_MONDAY + HOUR);
      const bot = yield* t.start;
      expect(yield* bot.signUp("alice")).toBe("This week's Weekly Cup is over.");
      yield* bot.stop;
    }),
  );

  describe("after a restart", () => {
    it.scoped("keeps an open week's post and its Entrants, posting nothing again", () =>
      Effect.gen(function* () {
        const t = yield* setup;
        yield* TestClock.setTime(MONDAY);
        const first = yield* t.start;
        yield* first.signUp("alice");
        yield* first.stop;
        const again = yield* t.start;
        expect(yield* again.signUp("alice")).toBe("You're already signed up for this week's Cup.");
        yield* again.signUp("bob");
        yield* TestClock.adjust(THURSDAY_NOON - MONDAY);
        expect((yield* Ref.get(t.posts)).length).toBe(1);
        expect(yield* Ref.get(t.notices)).toEqual([]);
        expect((yield* t.lastView)?.entrants).toEqual(["alice", "bob"]);
        yield* again.stop;
      }),
    );

    it.scoped("cancels at once a week whose Thursday 12:00 passed while it was down", () =>
      Effect.gen(function* () {
        const t = yield* setup;
        yield* TestClock.setTime(MONDAY);
        yield* t.runFor(HOUR);
        yield* TestClock.setTime(THURSDAY_NOON + 2 * HOUR);
        yield* t.runFor(MINUTE);
        expect((yield* Ref.get(t.notices)).map((n) => n.at)).toEqual([THURSDAY_NOON + 2 * HOUR]);
        expect((yield* Ref.get(t.posts)).length).toBe(1);
      }),
    );

    it.scoped("leaves a cancelled, skipped or finished week as it was", () =>
      Effect.gen(function* () {
        for (const end of ["cancelled", "skipped", "final"] as const) {
          const t = yield* setup;
          yield* TestClock.setTime(MONDAY);
          const bot = yield* t.start;
          yield* bot.signUp("alice");
          if (end !== "cancelled") yield* bot.signUp("bob");
          if (end === "skipped") yield* bot.skip("admin", true);
          const until = end === "final" ? SUNDAY_EIGHT : THURSDAY_NOON;
          yield* TestClock.adjust(THURSDAY_NOON - MONDAY);
          yield* bot.stop;
          if (end === "final") {
            yield* t.runFor(FRIDAY_NINE - THURSDAY_NOON);
            yield* TestClock.setTime(SUNDAY_EIGHT);
            yield* t.runFor(1);
          }
          const before = {
            posts: (yield* Ref.get(t.posts)).length,
            edits: (yield* Ref.get(t.edits)).length,
            notices: (yield* Ref.get(t.notices)).length,
          };
          expect((yield* t.lastView)?.state).toBe(end);
          yield* t.runFor(NEXT_MONDAY - until - MINUTE);
          expect({
            posts: (yield* Ref.get(t.posts)).length,
            edits: (yield* Ref.get(t.edits)).length,
            notices: (yield* Ref.get(t.notices)).length,
          }).toEqual(before);
          yield* TestClock.setTime(MONDAY);
        }
      }),
    );

    it.scoped("carries a racing week on to its close", () =>
      Effect.gen(function* () {
        const t = yield* setup;
        yield* TestClock.setTime(MONDAY);
        const bot = yield* t.start;
        yield* bot.signUp("alice");
        yield* bot.signUp("bob");
        yield* TestClock.adjust(FRIDAY_NINE - MONDAY + HOUR);
        yield* bot.stop;
        yield* TestClock.setTime(SUNDAY_EIGHT - 10 * MINUTE);
        yield* t.runFor(HOUR);
        expect((yield* Ref.get(t.posts)).length).toBe(1);
        expect((yield* t.lastView)?.state).toBe("final");
      }),
    );
  });

  it.scoped("tells ops once when the post fails, and posts on a later try", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* Ref.set(t.channelDown, true);
      yield* TestClock.setTime(MONDAY);
      yield* t.runFor(10 * MINUTE);
      expect(yield* Ref.get(t.alerts)).toEqual([
        `Multiballs couldn't post the Weekly Cup for ${WEEK} in ${GUILD}: Missing Permissions`,
      ]);
      yield* Ref.set(t.channelDown, false);
      yield* t.runFor(2 * MINUTE);
      expect((yield* Ref.get(t.posts)).length).toBe(1);
    }),
  );

  it.scoped("posts the Cup afresh when its post was deleted, and keeps the new one", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* TestClock.setTime(MONDAY);
      const bot = yield* t.start;
      t.deleted.add("m1");
      yield* bot.signUp("alice");
      yield* bot.signUp("bob");
      expect((yield* Ref.get(t.posts)).map((p) => p.view.entrants)).toEqual([[], ["alice"]]);
      expect(t.replacing).toEqual([null, "m1"]);
      expect((yield* Ref.get(t.edits)).map((e) => [e.messageId, e.view.entrants])).toEqual([
        ["m2", ["alice", "bob"]],
      ]);
      // A restart keeps the new post.
      yield* bot.stop;
      const again = yield* t.start;
      yield* again.withdraw("bob");
      expect((yield* Ref.get(t.edits)).at(-1)?.messageId).toBe("m2");
      yield* again.stop;
    }),
  );

  it.scoped("signs up even when the post can't be redrawn", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* TestClock.setTime(MONDAY);
      const bot = yield* t.start;
      yield* Ref.set(t.channelDown, true);
      expect(yield* bot.signUp("alice")).toContain("You're signed up");
      yield* Ref.set(t.channelDown, false);
      yield* bot.signUp("bob");
      expect((yield* t.lastView)?.entrants).toEqual(["alice", "bob"]);
      yield* bot.stop;
    }),
  );
});

describe("the Weekly Cup's Shortlist and vote", () => {
  /** A world at Monday 00:00 with alice and bob signed up, its bot running. */
  const signedUp = (seed = 1) =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* TestClock.setTime(MONDAY);
      const bot = yield* t.startWith(seed);
      yield* bot.signUp("alice");
      yield* bot.signUp("bob");
      return { t, bot };
    });
  const pfidsOf = (t: Effect.Effect.Success<typeof setup>) =>
    Effect.map(Ref.get(t.shortlists), (s) => s.at(-1)?.view.maps.map((m) => m.map.pfid) ?? []);

  it.scoped(
    "draws 10 Maps no Entrant has Played at Thursday 12:00, and posts them with their pictures",
    () =>
      Effect.gen(function* () {
        const { t, bot } = yield* signedUp();
        const longAuthor = makeMap(21, {
          medals: { bronze: 400, silver: 300, gold: 250, author: 181 },
        });
        const quickRecord = makeMap(22, { worldRecordTicks: 300_000 });
        yield* t.steam.setCatalogue([...ELIGIBLE, longAuthor, quickRecord]);
        yield* t.steam.setTime(1, steamIdOf("alice"), 30);
        yield* t.steam.setTime(2, steamIdOf("bob"), 30);
        yield* TestClock.adjust(THURSDAY_NOON - MONDAY);
        const shortlists = yield* Ref.get(t.shortlists);
        expect(shortlists.map((s) => s.at)).toEqual([THURSDAY_NOON]);
        const maps = shortlists[0]?.view.maps ?? [];
        expect(maps.map((m) => m.map.pfid).sort()).toEqual(
          ELIGIBLE.slice(2)
            .map((m) => m.pfid)
            .sort(),
        );
        expect(maps[0]).toMatchObject({
          picture: { type: "image/png", body: new Uint8Array([1]) },
          map: { authorSeconds: 20, creator: "pebblewright" },
        });
        for (const m of maps) expect(m.map.boardId).toBe(Number(m.map.pfid.slice(2)));
        expect((yield* t.lastView)?.state).toBe("voting");
        yield* bot.stop;
      }),
  );

  it.scoped("posts a shorter Shortlist when fewer than 10 Maps are eligible", () =>
    Effect.gen(function* () {
      const { t, bot } = yield* signedUp();
      yield* t.steam.setCatalogue(ELIGIBLE.slice(0, 4));
      yield* TestClock.adjust(THURSDAY_NOON - MONDAY);
      expect(yield* pfidsOf(t)).toHaveLength(4);
      expect((yield* t.lastView)?.state).toBe("voting");
      yield* bot.stop;
    }),
  );

  it.scoped("cancels the week when no Map is eligible, and says why", () =>
    Effect.gen(function* () {
      const { t, bot } = yield* signedUp();
      yield* t.steam.setCatalogue([]);
      yield* TestClock.adjust(THURSDAY_NOON - MONDAY);
      expect(yield* Ref.get(t.shortlists)).toEqual([]);
      expect((yield* Ref.get(t.notices)).map((n) => n.notice)).toEqual([
        { _tag: "Cancelled", reason: "maps", week: WEEK, entrants: ["alice", "bob"] },
      ]);
      expect((yield* t.lastView)?.state).toBe("cancelled");
      yield* bot.stop;
    }),
  );

  it.scoped("tries the draw again each minute while Steam is down, telling ops once", () =>
    Effect.gen(function* () {
      const { t, bot } = yield* signedUp();
      yield* Ref.set(t.steamDown, true);
      yield* TestClock.adjust(THURSDAY_NOON - MONDAY + 10 * MINUTE);
      expect(yield* Ref.get(t.shortlists)).toEqual([]);
      expect(yield* Ref.get(t.alerts)).toEqual([
        `Multiballs couldn't draw the Weekly Cup's Shortlist for ${WEEK} in ${GUILD}: no reply`,
      ]);
      yield* Ref.set(t.steamDown, false);
      yield* TestClock.adjust(MINUTE);
      expect((yield* Ref.get(t.shortlists)).map((s) => s.at)).toEqual([
        THURSDAY_NOON + 11 * MINUTE,
      ]);
      yield* bot.stop;
    }),
  );

  it.scoped("takes up to 3 votes from each Entrant, changeable until Friday 09:00", () =>
    Effect.gen(function* () {
      const { t, bot } = yield* signedUp();
      expect(yield* bot.vote("alice", ["pf1"])).toBe(
        `The Shortlist isn't drawn yet: it comes <t:${THURSDAY_NOON / 1000}:F>.`,
      );
      yield* TestClock.adjust(THURSDAY_NOON - MONDAY);
      const [a, b, c, d] = yield* pfidsOf(t);
      expect(yield* bot.vote("carol", [a ?? ""])).toBe(
        "Only Entrants can vote. Sign up on the Cup's post first.",
      );
      expect(yield* bot.vote("alice", [a, b, c, d].map(String))).toBe("Pick up to 3 Maps.");
      expect(yield* bot.vote("alice", ["pf99"])).toBe("That Map isn't on this week's Shortlist.");
      expect(yield* bot.vote("alice", [a, b].map(String))).toContain("Your vote:");
      expect(yield* bot.vote("alice", [c].map(String))).toBe(
        `Your vote: **Map ${(c ?? "").slice(2)}**. You can change it until <t:${FRIDAY_NINE / 1000}:F>.`,
      );
      yield* TestClock.adjust(FRIDAY_NINE - THURSDAY_NOON);
      expect(yield* bot.vote("alice", [a].map(String))).toBe("The vote has closed.");
      yield* bot.stop;
    }),
  );

  it.scoped(
    "makes the 3 most-voted the Cup Maps at Friday 09:00, announced with a ping for Entrants",
    () =>
      Effect.gen(function* () {
        const { t, bot } = yield* signedUp();
        yield* TestClock.adjust(THURSDAY_NOON - MONDAY + HOUR);
        const [m0, m1, m2, m3, m4, m5] = (yield* pfidsOf(t)).map(String);
        yield* bot.signUp("carol");
        yield* bot.signUp("dave");
        yield* bot.vote("alice", [m0, m1, m2].map(String));
        yield* bot.vote("alice", [m0, m1].map(String));
        yield* bot.vote("bob", [m0, m1, m3].map(String));
        yield* bot.vote("carol", [m0, m4].map(String));
        // A vote from someone who withdrew no longer counts.
        yield* bot.vote("dave", [m5, m3, m4].map(String));
        yield* bot.withdraw("dave");
        yield* TestClock.adjust(FRIDAY_NINE - THURSDAY_NOON - HOUR);
        const notices = yield* Ref.get(t.notices);
        expect(notices.map((n) => n.at)).toEqual([FRIDAY_NINE]);
        const notice = notices[0]?.notice;
        if (notice?._tag !== "CupMaps") throw new Error("no Cup Maps announced");
        expect(notice.entrants).toEqual(["alice", "bob", "carol"]);
        expect(notice.maps.map((m) => [m.map.pfid, m.votes]).slice(0, 2)).toEqual([
          [m0, 3],
          [m1, 2],
        ]);
        expect([m3, m4]).toContain(notice.maps[2]?.map.pfid);
        expect(notice.maps[2]?.votes).toBe(1);
        for (const m of notice.maps) expect(typeof m.map.boardId).toBe("number");
        expect((yield* t.lastView)?.state).toBe("racing");
        yield* bot.stop;
      }),
  );

  it.scoped("refuses a vote naming the same Map twice", () =>
    Effect.gen(function* () {
      const { t, bot } = yield* signedUp();
      yield* TestClock.adjust(THURSDAY_NOON - MONDAY);
      const [a] = yield* pfidsOf(t);
      expect(yield* bot.vote("alice", [a, a].map(String))).toBe("Pick each Map once.");
      yield* bot.stop;
    }),
  );

  it.scoped("keeps the Shortlist through a restart, drawing and posting it once", () =>
    Effect.gen(function* () {
      const { t, bot } = yield* signedUp();
      yield* TestClock.adjust(THURSDAY_NOON - MONDAY + HOUR);
      const drawn = yield* pfidsOf(t);
      yield* bot.vote("alice", [drawn[0] ?? ""]);
      yield* bot.stop;
      const again = yield* t.startWith(42);
      expect(yield* again.vote("alice", [drawn[1] ?? ""])).toContain("Your vote:");
      yield* TestClock.adjust(HOUR);
      expect(yield* Ref.get(t.shortlists)).toHaveLength(1);
      yield* again.stop;
    }),
  );

  it.scoped("records the Cup Maps, tie-break and all, so a restart never redraws them", () =>
    Effect.gen(function* () {
      /** Up to Friday 09:00 with no votes (every Map tied), the announcement refused. */
      const tallied = Effect.gen(function* () {
        const { t, bot } = yield* signedUp(7);
        yield* TestClock.adjust(FRIDAY_NINE - MONDAY - MINUTE);
        yield* Ref.set(t.channelDown, true);
        yield* TestClock.adjust(10 * MINUTE);
        yield* bot.stop;
        expect(yield* Ref.get(t.alerts)).toContain(
          `Multiballs couldn't announce the Weekly Cup's Cup Maps for ${WEEK} in ${GUILD}: Missing Permissions`,
        );
        yield* Ref.set(t.channelDown, false);
        return t;
      });
      const announced = (seed: number) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(MONDAY);
          const t = yield* tallied;
          yield* t.runFor(5 * MINUTE, seed);
          const notices = (yield* Ref.get(t.notices)).map((n) => n.notice);
          expect(notices.map((n) => n._tag)).toEqual(["CupMaps"]);
          return notices[0]?._tag === "CupMaps" ? notices[0].maps.map((m) => m.map.pfid) : [];
        });
      const first = yield* announced(99);
      expect(first).toHaveLength(3);
      expect(yield* announced(5)).toEqual(first);
    }),
  );

  it.scoped(
    "tells ops when the vote can't close on a deleted Shortlist, and posts it no more",
    () =>
      Effect.gen(function* () {
        const { t, bot } = yield* signedUp();
        yield* TestClock.adjust(THURSDAY_NOON - MONDAY + HOUR);
        t.deleted.add("s1");
        yield* TestClock.adjust(FRIDAY_NINE - THURSDAY_NOON);
        expect(yield* Ref.get(t.shortlists)).toHaveLength(1);
        expect(yield* Ref.get(t.alerts)).toContain(
          `Multiballs couldn't close the vote on the Weekly Cup's Shortlist for ${WEEK} in ${GUILD}: Unknown Message`,
        );
        yield* bot.stop;
      }),
  );

  it.scoped("closes the Shortlist's vote on its post at Friday 09:00", () =>
    Effect.gen(function* () {
      const { t, bot } = yield* signedUp();
      yield* TestClock.adjust(FRIDAY_NINE - MONDAY);
      const closed = yield* Ref.get(t.shortlistEdits);
      expect(closed.map((e) => [e.at, e.messageId, e.view.closed])).toEqual([
        [FRIDAY_NINE, "s1", true],
      ]);
      expect(closed[0]?.view.maps).toHaveLength(10);
      yield* bot.stop;
    }),
  );
});

describe("the Weekly Cup's racing and results", () => {
  /** Seconds as the board's ticks. */
  const tk = (s: number) => Math.round(s * 100_000);
  /**
   * A world at Friday 09:00 with alice and bob signed up from Monday and the Cup Maps announced:
   * their board ids, in rank order.
   */
  type World = Effect.Effect.Success<typeof setup>;
  type Bot = Effect.Effect.Success<World["start"]>;
  const racing = (before?: (t: World, bot: Bot) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* TestClock.setTime(MONDAY);
      const bot = yield* t.start;
      yield* bot.signUp("alice");
      yield* bot.signUp("bob");
      yield* TestClock.adjust(THURSDAY_NOON - MONDAY);
      if (before !== undefined) yield* before(t, bot);
      yield* TestClock.setTime(FRIDAY_NINE);
      const notice = (yield* Ref.get(t.notices)).find((n) => n.notice._tag === "CupMaps")?.notice;
      const boards = notice?._tag === "CupMaps" ? notice.maps.map((m) => m.map.boardId) : [];
      return { t, bot, boards: [boards[0] ?? 0, boards[1] ?? 0, boards[2] ?? 0] as const };
    });
  /**
   * Stop the bot and start it again at Sunday 19:58, where it reads at once and next at 20:00:
   * the weekend's 5-minute reads are slow on the TestClock.
   */
  const lastMinutes = (t: World, bot: Bot) =>
    Effect.gen(function* () {
      yield* bot.stop;
      yield* TestClock.setTime(SUNDAY_EIGHT - 2 * MINUTE);
      return yield* t.start;
    });
  /** What the standings message shows now: each Map's rows as [who, ticks, points]. */

  const shown = (t: Effect.Effect.Success<typeof setup>) =>
    Effect.map(Ref.get(t.standings), (all) => {
      const view = all.at(-1)?.view;
      return {
        maps: view?.standings.maps.map((m) => m.rows.map((r) => [r.discordId, r.ticks, r.points])),
        overall: view?.standings.overall.map((o) => [o.discordId, o.total]),
      };
    });

  it.scoped("posts the standings afresh when their message was deleted", () =>
    Effect.gen(function* () {
      const { t, bot, boards } = yield* racing();
      t.deleted.add("st1");
      yield* t.steam.setTime(boards[0], steamIdOf("alice"), 12);
      yield* TestClock.adjust(5 * MINUTE);
      yield* t.steam.setTime(boards[0], steamIdOf("bob"), 13);
      yield* TestClock.adjust(5 * MINUTE);
      expect((yield* Ref.get(t.standings)).map((s) => [s.at, s.messageId])).toEqual([
        [FRIDAY_NINE, "st1"],
        [FRIDAY_NINE + 5 * MINUTE, "st2"],
        [FRIDAY_NINE + 10 * MINUTE, "st2"],
      ]);
      yield* bot.stop;
    }),
  );

  it.scoped("reads each Cup Map every 5 minutes, one read each, for the Entrants", () =>
    Effect.gen(function* () {
      const { t, bot } = yield* racing();
      const before = yield* t.steam.reads;
      yield* TestClock.adjust(30 * MINUTE);
      expect((yield* t.steam.reads) - before).toBe(6 * 3);
      yield* bot.stop;
    }),
  );

  it.scoped("keeps one standings message, edited only when a read changes it", () =>
    Effect.gen(function* () {
      const { t, bot, boards } = yield* racing();
      yield* TestClock.adjust(20 * MINUTE);
      expect((yield* Ref.get(t.standings)).map((s) => [s.at, s.messageId])).toEqual([
        [FRIDAY_NINE, "st1"],
      ]);
      yield* t.steam.setTime(boards[0], steamIdOf("bob"), 14);
      yield* t.steam.setTime(boards[0], steamIdOf("alice"), 12);
      yield* TestClock.adjust(5 * MINUTE);
      const all = yield* Ref.get(t.standings);
      expect(all.map((s) => [s.at, s.messageId])).toEqual([
        [FRIDAY_NINE, "st1"],
        [FRIDAY_NINE + 25 * MINUTE, "st1"],
      ]);
      expect((yield* shown(t)).maps?.[0]).toEqual([
        ["alice", tk(12), 40000],
        ["bob", tk(14), 20000],
      ]);
      expect((yield* shown(t)).overall).toEqual([
        ["alice", 40000],
        ["bob", 20000],
      ]);
      yield* bot.stop;
    }),
  );

  it.scoped("counts a late Entrant's time held before signing up only once they beat it", () =>
    Effect.gen(function* () {
      const { t, bot, boards } = yield* racing();
      yield* TestClock.adjust(HOUR);
      yield* t.steam.setTime(boards[0], steamIdOf("carol"), 20);
      expect(yield* bot.signUp("carol")).toContain("You're signed up");
      yield* TestClock.adjust(10 * MINUTE);
      expect((yield* shown(t)).maps?.[0]).toContainEqual(["carol", null, 0]);
      yield* t.steam.setTime(boards[0], steamIdOf("carol"), 19);
      yield* TestClock.adjust(5 * MINUTE);
      expect((yield* shown(t)).maps?.[0]).toContainEqual(["carol", tk(19), 40000]);
      yield* bot.stop;
    }),
  );

  it.scoped("takes the PB at Friday 09:00 as the bar for one who signed up after the draw", () =>
    Effect.gen(function* () {
      const { t, bot, boards } = yield* racing((t, bot) =>
        Effect.gen(function* () {
          yield* TestClock.adjust(HOUR);
          // dave signs up after the draw and plays every Shortlist Map before Friday.
          expect(yield* bot.signUp("dave")).toContain("You're signed up");
          const listed = (yield* Ref.get(t.shortlists)).at(-1)?.view.maps ?? [];
          for (const { map } of listed) yield* t.steam.setTime(map.boardId, steamIdOf("dave"), 20);
        }),
      );
      yield* TestClock.adjust(10 * MINUTE);
      expect((yield* shown(t)).maps?.[0]).toContainEqual(["dave", null, 0]);
      yield* t.steam.setTime(boards[0], steamIdOf("dave"), 18);
      yield* TestClock.adjust(5 * MINUTE);
      expect((yield* shown(t)).maps?.[0]).toContainEqual(["dave", tk(18), 40000]);
      yield* bot.stop;
    }),
  );

  it.scoped(
    "takes every Entrant's PB at Friday 09:00 as their bar: practice in the vote counts not",
    () =>
      Effect.gen(function* () {
        const { t, bot, boards } = yield* racing((t) =>
          Effect.gen(function* () {
            // alice, signed up from Monday, plays every Shortlist Map during the vote.
            const listed = (yield* Ref.get(t.shortlists)).at(-1)?.view.maps ?? [];
            for (const { map } of listed)
              yield* t.steam.setTime(map.boardId, steamIdOf("alice"), 20);
          }),
        );
        yield* TestClock.adjust(10 * MINUTE);
        expect((yield* shown(t)).maps?.[0]).toContainEqual(["alice", null, 0]);
        yield* t.steam.setTime(boards[0], steamIdOf("alice"), 19);
        yield* TestClock.adjust(5 * MINUTE);
        expect((yield* shown(t)).maps?.[0]).toContainEqual(["alice", tk(19), 40000]);
        yield* bot.stop;
      }),
  );

  it.scoped("closes sign-up and withdrawal at Sunday 20:00, while the final read still waits", () =>
    Effect.gen(function* () {
      const { t, bot } = yield* racing();
      const again = yield* lastMinutes(t, bot);
      yield* t.steam.failNextReads(1_000_000);
      yield* TestClock.adjust(7 * MINUTE); // 20:05
      expect(yield* Ref.get(t.results)).toEqual([]);
      expect(yield* again.signUp("carol")).toBe("This week's Weekly Cup is over.");
      expect(yield* again.withdraw("alice")).toBe("This week's Weekly Cup is over.");
      yield* again.stop;
    }),
  );

  it.scoped("flags a PB seen over 30 minutes after a first time on that Map, once", () =>
    Effect.gen(function* () {
      const { t, bot, boards } = yield* racing();
      const pb = (s: number) => t.steam.setTime(boards[1], steamIdOf("alice"), s);
      yield* pb(30); // first seen at 09:05
      yield* TestClock.adjust(20 * MINUTE);
      yield* pb(29); // seen at 09:25, 20 minutes on
      yield* TestClock.adjust(15 * MINUTE);
      expect(yield* Ref.get(t.alerts)).toEqual([]);
      yield* pb(28); // seen at 09:40, 35 minutes on: a Flag
      yield* TestClock.adjust(10 * MINUTE);
      yield* pb(27); // seen at 09:50: no second Flag
      yield* TestClock.adjust(10 * MINUTE);
      const flags = (yield* Ref.get(t.alerts)).filter((a) => a.includes("Flag"));
      expect(flags).toHaveLength(1);
      expect(flags[0]).toContain("<@alice>");
      expect(flags[0]).toContain("0:28.000");
      // No Ghosts to date the runs by: the gap is the reads', and says so.
      expect(flags[0]).toContain("about 35 minutes after their first time on it");
      expect(flags[0]).toContain("by the bot's reads");
      // It still counts.
      expect((yield* shown(t)).maps?.[1]?.[0]).toEqual(["alice", tk(27), 40000]);
      yield* bot.stop;
    }),
  );

  /** Alice's time on the second Cup Map, its Ghost stamped `at` past Friday 09:00. */
  const run = (t: World, board: number, seconds: number, at: number) =>
    t.steam.setTime(board, steamIdOf("alice"), seconds, FRIDAY_NINE + at);
  const flagsOf = (t: World) =>
    Effect.map(Ref.get(t.alerts), (a) => a.filter((x) => x.includes("Flag")));

  it.scoped("times a Flag between the two runs' Ghosts, to the second", () =>
    Effect.gen(function* () {
      const { t, bot, boards } = yield* racing();
      yield* run(t, boards[1], 30, 1 * MINUTE); // set 09:01, seen 09:05
      yield* TestClock.adjust(30 * MINUTE);
      yield* run(t, boards[1], 29, 31 * MINUTE + 30_000); // set 09:31:30, seen 09:35
      yield* TestClock.adjust(5 * MINUTE);
      // The reads are 30 minutes apart, not over, but the runs are 30 min 30 s apart.
      const flags = yield* flagsOf(t);
      expect(flags).toEqual([
        `Weekly Cup Flag for ${WEEK} in ${GUILD}: <@alice> set 0:29.000 on Map 2, 30 min 30 s after their first time on it, by their Ghosts. It still counts.`.replace(
          "Map 2",
          `Map ${boards[1]}`,
        ),
      ]);
      yield* bot.stop;
    }),
  );

  it.scoped(
    "doesn't Flag a PB the Ghosts set within 30 minutes, though the reads are further",
    () =>
      Effect.gen(function* () {
        const { t, bot, boards } = yield* racing();
        yield* run(t, boards[1], 30, 4 * MINUTE + 50_000); // set 09:04:50, seen 09:05
        yield* TestClock.adjust(30 * MINUTE);
        yield* run(t, boards[1], 29, 34 * MINUTE + 40_000); // set 09:34:40
        yield* t.steam.failNextReads(3); // the 09:35 read drops: seen 09:40
        yield* TestClock.adjust(10 * MINUTE);
        expect((yield* shown(t)).maps?.[1]?.[0]).toEqual(["alice", tk(29), 40000]);
        expect(yield* flagsOf(t)).toEqual([]);
        yield* bot.stop;
      }),
  );

  it.scoped("falls back to the reads when a Ghost can't be read, or isn't that run's", () =>
    Effect.gen(function* () {
      const { t, bot, boards } = yield* racing();
      yield* run(t, boards[1], 30, 1 * MINUTE); // dated 09:01, seen 09:05
      yield* run(t, boards[0], 20, 10 * HOUR); // dated after it was seen: not this run's
      yield* TestClock.adjust(5 * MINUTE);
      yield* t.steam.failGhosts(true);
      yield* run(t, boards[2], 40, 6 * MINUTE); // seen 09:10, its Ghost unread
      yield* TestClock.adjust(5 * MINUTE);
      yield* t.steam.failGhosts(false);
      yield* TestClock.adjust(25 * MINUTE);
      // Dated before the time it beat was seen (09:05): the old run's Ghost, still attached.
      yield* run(t, boards[1], 29, -10 * MINUTE);
      yield* run(t, boards[0], 19, 20 * MINUTE); // dated fine, but its first time wasn't
      yield* TestClock.adjust(5 * MINUTE); // both seen 09:40
      yield* run(t, boards[2], 39, 41 * MINUTE);
      yield* TestClock.adjust(5 * MINUTE); // seen 09:45
      const flags = yield* flagsOf(t);
      expect(flags).toHaveLength(3);
      for (const [i, board] of boards.entries()) {
        const flag = flags.find((f) => f.includes(`on Map ${board},`));
        expect(flag, `board ${i}`).toContain("about 35 minutes after their first time on it");
        expect(flag).toContain("by the bot's reads");
      }
      yield* bot.stop;
    }),
  );

  it.scoped("takes a Ghost dated before the last read for the old run's, still attached", () =>
    Effect.gen(function* () {
      const { t, bot, boards } = yield* racing();
      yield* run(t, boards[1], 30, 4 * MINUTE + 50_000); // set 09:04:50, seen 09:05
      yield* TestClock.adjust(3 * HOUR);
      // A PB at 12:01, read at 12:05 with the 09:04:50 Ghost still on it.
      yield* run(t, boards[1], 29, 4 * MINUTE + 50_000);
      yield* TestClock.adjust(5 * MINUTE);
      const flags = yield* flagsOf(t);
      expect(flags).toHaveLength(1);
      expect(flags[0]).toContain("about 180 minutes after their first time on it");
      yield* bot.stop;
    }),
  );

  it.scoped("reads a PB's Ghost only when it could make a Flag", () =>
    Effect.gen(function* () {
      const { t, bot, boards } = yield* racing();
      yield* run(t, boards[1], 30, 1 * MINUTE); // seen 09:05: its Ghost read
      yield* TestClock.adjust(5 * MINUTE);
      yield* run(t, boards[1], 29, 6 * MINUTE); // seen 09:10, set by then: under 30 minutes
      yield* TestClock.adjust(5 * MINUTE);
      expect(t.steam.ghostReads()).toBe(1);
      yield* bot.stop;
    }),
  );

  it.scoped("gives up on a Ghost read that never answers, and reads on", () =>
    Effect.gen(function* () {
      const { t, bot, boards } = yield* racing();
      yield* t.steam.failGhosts("hang");
      yield* run(t, boards[1], 30, 1 * MINUTE);
      yield* TestClock.adjust(5 * MINUTE);
      yield* TestClock.adjust(1 * MINUTE);
      expect((yield* shown(t)).maps?.[1]?.[0]).toEqual(["alice", tk(30), 40000]);
      yield* bot.stop;
    }),
  );

  it.scoped("keeps the last standings through a failed read, and picks the time up next", () =>
    Effect.gen(function* () {
      const { t, bot, boards } = yield* racing();
      yield* t.steam.setTime(boards[2], steamIdOf("bob"), 40);
      yield* t.steam.failNextReads(3);
      yield* TestClock.adjust(5 * MINUTE);
      expect((yield* shown(t)).maps?.[2]).toContainEqual(["bob", null, 0]);
      expect(yield* Ref.get(t.alerts)).toEqual([
        `Multiballs couldn't read a Weekly Cup Map for ${WEEK} in ${GUILD}: reply dropped`,
      ]);
      yield* TestClock.adjust(5 * MINUTE);
      expect((yield* shown(t)).maps?.[2]).toContainEqual(["bob", tk(40), 40000]);
      yield* bot.stop;
    }),
  );

  it.scoped("closes the live standings once the results are up, pointing to them", () =>
    Effect.gen(function* () {
      const { t, bot } = yield* racing();
      const again = yield* lastMinutes(t, bot);
      yield* TestClock.adjust(2 * MINUTE);
      expect((yield* Ref.get(t.results)).map((r) => r.at)).toEqual([SUNDAY_EIGHT]);
      const all = yield* Ref.get(t.standings);
      const last = all[all.length - 1];
      expect(last).toMatchObject({ at: SUNDAY_EIGHT, messageId: "st1" });
      expect(last?.view.final).toBe(true);
      // Only the live standings before it were shown live.
      expect(all.slice(0, -1).every((s) => !s.view.final)).toBe(true);
      yield* again.stop;
    }),
  );

  it.scoped("posts the results once at Sunday 20:00, from a final read, through a restart", () =>
    Effect.gen(function* () {
      const { t, bot, boards } = yield* racing();
      yield* t.steam.setTime(boards[0], steamIdOf("alice"), 12);
      const again = yield* lastMinutes(t, bot);
      // Set after the last live read: only the final read sees it.
      yield* t.steam.setTime(boards[1], steamIdOf("bob"), 22);
      yield* TestClock.adjust(2 * MINUTE);
      const results = yield* Ref.get(t.results);
      expect(results.map((r) => r.at)).toEqual([SUNDAY_EIGHT]);
      expect(results[0]?.view.final).toBe(true);
      expect(
        results[0]?.view.standings.overall.map((o) => [o.discordId, o.total, o.place]),
      ).toEqual([
        ["alice", 40000, 1],
        ["bob", 40000, 1],
      ]);
      expect((yield* t.lastView)?.state).toBe("final");
      yield* again.stop;
      yield* t.runFor(HOUR);
      expect(yield* Ref.get(t.results)).toHaveLength(1);
    }),
  );

  it.scoped("waits up to 30 minutes for Steam at the end, then stands on the last reads", () =>
    Effect.gen(function* () {
      const { t, bot, boards } = yield* racing();
      yield* t.steam.setTime(boards[0], steamIdOf("alice"), 12);
      const again = yield* lastMinutes(t, bot);
      yield* t.steam.setTime(boards[0], steamIdOf("bob"), 11);
      yield* t.steam.failNextReads(1_000_000);
      yield* TestClock.adjust(31 * MINUTE); // 20:29
      expect(yield* Ref.get(t.results)).toEqual([]);
      yield* TestClock.adjust(2 * MINUTE);
      const results = yield* Ref.get(t.results);
      expect(results.map((r) => r.at)).toEqual([SUNDAY_EIGHT + 30 * MINUTE]);
      // bob's last-minute time was never read, and the results say no Map was.
      expect(results[0]?.view.standings.overall[0]).toMatchObject({ discordId: "alice" });
      expect(results[0]?.view.lateReads.map((r) => r.at)).toEqual([null, null, null]);

      yield* again.stop;
    }),
  );

  it.scoped("retries only the Maps the final read missed, and says which were read late", () =>
    Effect.gen(function* () {
      const { t, bot, boards } = yield* racing();
      const again = yield* lastMinutes(t, bot);
      // The first of the three reads at 20:00 (the first Cup Map's) is dropped.
      yield* t.steam.failNextReads(1);
      yield* TestClock.adjust(2 * MINUTE); // 20:00
      expect(yield* Ref.get(t.results)).toEqual([]);
      const before = yield* t.steam.reads;
      yield* t.steam.setTime(boards[0], steamIdOf("bob"), 11);
      yield* t.steam.setTime(boards[1], steamIdOf("bob"), 11); // too late: that Map was read
      yield* TestClock.adjust(MINUTE);
      expect((yield* t.steam.reads) - before).toBe(1);
      const results = yield* Ref.get(t.results);
      expect(results.map((r) => r.at)).toEqual([SUNDAY_EIGHT + MINUTE]);
      const view = results[0]?.view;
      expect(view?.lateReads).toEqual([{ pfid: view?.maps[0]?.pfid, at: SUNDAY_EIGHT + MINUTE }]);
      expect(view?.standings.maps[0]?.rows[0]).toMatchObject({ discordId: "bob", points: 40000 });
      expect(view?.standings.maps[1]?.rows[0]).toMatchObject({ ticks: null });
      yield* again.stop;
    }),
  );

  it.scoped("finishes a week left racing while the bot was down from Sunday 19:50 to Monday", () =>
    Effect.gen(function* () {
      const { t, bot, boards } = yield* racing();
      yield* t.steam.setTime(boards[0], steamIdOf("alice"), 12);
      yield* bot.stop;
      yield* TestClock.setTime(SUNDAY_EIGHT - 10 * MINUTE);
      yield* t.runFor(MINUTE); // reads at 19:50, then goes down
      yield* TestClock.setTime(NEXT_MONDAY + 10 * MINUTE);
      yield* t.runFor(MINUTE);
      const results = yield* Ref.get(t.results);
      expect(results.map((r) => [r.at, r.view.week.week])).toEqual([
        [NEXT_MONDAY + 10 * MINUTE, WEEK],
      ]);
      expect(results[0]?.view.standings.overall[0]).toMatchObject({ discordId: "alice" });
      // Read at Monday 00:10: all three late, and the results say so.
      expect(results[0]?.view.lateReads.map((r) => r.at)).toEqual(
        Array(3).fill(NEXT_MONDAY + 10 * MINUTE),
      );
      const finals = (yield* Ref.get(t.edits)).filter(
        (e) => e.view.week.week === WEEK && e.view.state === "final",
      );
      expect(finals.map((e) => e.at)).toEqual([NEXT_MONDAY + 10 * MINUTE]);
      // And the new week's Cup goes up as well.
      expect((yield* Ref.get(t.posts)).map((p) => p.view.week.week)).toEqual([WEEK, "2026-11-02"]);
    }),
  );

  it.scoped("posts the results as soon as Steam answers within the 30 minutes", () =>
    Effect.gen(function* () {
      const { t, bot, boards } = yield* racing();
      const again = yield* lastMinutes(t, bot);
      yield* t.steam.setTime(boards[0], steamIdOf("bob"), 11);
      yield* t.steam.failNextReads(1_000_000);
      yield* TestClock.adjust(12 * MINUTE); // 20:10
      yield* t.steam.failNextReads(0);
      yield* TestClock.adjust(MINUTE);
      const results = yield* Ref.get(t.results);
      expect(results.map((r) => r.at)).toEqual([SUNDAY_EIGHT + 11 * MINUTE]);
      expect(results[0]?.view.standings.overall[0]).toMatchObject({ discordId: "bob" });
      yield* again.stop;
    }),
  );
});
