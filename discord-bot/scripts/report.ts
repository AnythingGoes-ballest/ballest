// `pnpm report`: build the Daily Report now and post it as the dev app, into the sandbox channel
// (`pnpm devserver sandbox create`) or the channel given with --channel. It reads the database at
// DATABASE_URL, which must be a local Postgres (AGENTS.md has how to fill one): never production's.
// The Workshop standings come from the site at SITE_URL (default the live site), whose GET /api/standings
// counts its own database: point it at a local `pnpm dev` of web/ to draw them from the same one.
// It skips the schedule's checks (already posted today, stale data) and records nothing.
import { PlatformConfigProvider } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Clock, Effect, Layer } from "effect";
import { ChosenSkinsLive } from "../src/chosenSkins.js";
import { ReportChannelLive } from "../src/report/channel.js";
import { postReport } from "../src/report/daily.js";
import { GhostDatesLive } from "../src/steam/ghosts.js";
import { buildReport, DAY_MS } from "../src/report/report.js";
import { ReportSource, ReportSourceLive } from "../src/report/source.js";
import { StandingsSource, StandingsSourceLive } from "../src/report/standings.js";
import { Renderer } from "../src/render/renderer.js";
import { devEnvFile } from "./devEnv.js";
import { readSandbox } from "./sandbox/config.js";

const args = process.argv.slice(2);
const flag = args.indexOf("--channel");
const channel = flag >= 0 ? args[flag + 1] : readSandbox()?.channelId;
if (channel === undefined) {
  console.log(
    "error: no channel. Make the sandbox one with `pnpm devserver sandbox create`, or pass --channel <id>.",
  );
  process.exit(1);
}
const url = process.env.DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.log(
    "error: DATABASE_URL must be a local Postgres, e.g. postgres://postgres:postgres@localhost:5432/ballest_dev",
  );
  process.exit(1);
}
process.env.STATS_CHANNEL_ID = channel;

const program = Effect.gen(function* () {
  const at = yield* Clock.currentTimeMillis;
  const data = yield* (yield* ReportSource).read(at);
  const standings = yield* (yield* StandingsSource).read(at - DAY_MS);
  const report = buildReport(data, standings, at);
  yield* Effect.logInfo(
    `report: ${report.maps} Maps, ${report.players} players, ${report.circuitChanges.length + report.workshopChanges.length} changes; last Refresh ${report.refreshedAt === null ? "never" : new Date(report.refreshedAt).toISOString()}`,
  );
  const messageId = yield* postReport(report);
  yield* Effect.logInfo(`report: posted ${messageId} in ${channel}`);
});

program.pipe(
  Effect.provide(
    Layer.mergeAll(
      ReportSourceLive,
      StandingsSourceLive,
      GhostDatesLive,
      ReportChannelLive,
      Renderer.Default,
      ChosenSkinsLive,
    ),
  ),
  Effect.provide(
    PlatformConfigProvider.layerDotEnvAdd(devEnvFile()).pipe(Layer.provide(NodeContext.layer)),
  ),
  NodeRuntime.runMain,
);
