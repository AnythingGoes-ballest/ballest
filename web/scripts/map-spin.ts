// tsx scripts/map-spin.ts <pfid> [--site <url>] [--out <file.gif>] [--no-db]: draws a Map's
// spinning GIF for its Daily Post (spec #268) and stores it in map_spins at DATABASE_URL.
// daily-spin.yml runs it when Multiballs asks. It opens the Map's 3D view on the site (the
// "See it in 3D" dialog) in Chromium with software WebGL, hides the bar and the hint, turns the
// Map one full turn a frame at a time (the viewer's turn event, which stops its own loop, so
// the page draws each frame once: in software a big Map's frame takes seconds), and encodes
// the frames with ffmpeg as a
// ~360 px GIF at 12.8 frames a second, one turn in about 12.5 s. The version stored is the
// map_files version the site draws; a Map with no file is refused. `--no-db` only writes --out,
// for a look without a database.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { eq, sql } from "drizzle-orm";
import { chromium } from "playwright-core";

import { TURN_EVENT } from "../components/prefabs/scene";
import { connect } from "../db/client";
import { mapFiles, mapSpins } from "../db/schema";

/* one turn in FRAMES frames at FPS: 12.5 s, the pace Will settled on (grill-design round 1) */
const FRAMES = 160;
const FPS = 12.8;
const SIZE = 640; // the page's viewport, square
const GIF_WIDTH = 360;

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const pfid = args.find((a) => /^\d+$/.test(a));
const site = option("--site") ?? "https://ballestrecords.com";
const out = option("--out");
const noDb = args.includes("--no-db");
if (!pfid) {
  console.error(
    "usage: tsx scripts/map-spin.ts <pfid> [--site <url>] [--out <file.gif>] [--no-db]",
  );
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!noDb && !url) {
  console.error("DATABASE_URL is not set (pass --no-db to only write --out)");
  process.exit(1);
}

const db = noDb || !url ? null : connect(url);
let version: string | null = null;
if (db) {
  const file = (
    await db.select({ version: mapFiles.version }).from(mapFiles).where(eq(mapFiles.pfid, pfid))
  ).at(0);
  if (!file) {
    console.error(`no map_files row for ${pfid}: the Map has no 3D view to draw`);
    await db.$client.end();
    process.exit(1);
  }
  version = file.version;
}

const frames = mkdtempSync(join(tmpdir(), "map-spin-"));
try {
  const gif = await draw(pfid, frames);
  console.log(`${pfid}: ${FRAMES} frames, GIF ${(gif.length / 1e6).toFixed(1)} MB`);
  if (out) writeFileSync(out, gif);
  if (db && version !== null) {
    await db
      .insert(mapSpins)
      .values({ pfid, version, gif, drawnAt: sql`now()` })
      .onConflictDoUpdate({
        target: mapSpins.pfid,
        set: { version, gif, drawnAt: sql`now()` },
      });
    console.log(`${pfid}: stored in map_spins (map file ${version})`);
  }
} finally {
  rmSync(frames, { recursive: true, force: true });
  await db?.$client.end();
}

async function draw(pfid: string, dir: string): Promise<Buffer> {
  // the cloud image's Chromium; elsewhere, the one `playwright-core install chromium` fetched
  const cloud = "/opt/pw-browsers/chromium";
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? (existsSync(cloud) ? cloud : undefined),
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: SIZE, height: SIZE },
      deviceScaleFactor: 1,
    });
    await page.goto(`${site}/map/${pfid}`, { waitUntil: "load" });
    await page.getByRole("button", { name: "See it in 3D" }).click();
    const view = page.locator("dialog.m3d .m3d-view");
    await view.locator("canvas").waitFor();
    await page.waitForSelector("dialog.m3d .m3d-view[data-ready]", { timeout: 120_000 });
    await page.addStyleTag({ content: ".m3d-top,.m3d-hint{display:none!important}" });
    // as text: tsx would name an arrow function with a helper the page doesn't have
    const turn = (by: number) =>
      page.evaluate(
        `document.querySelector("dialog.m3d .m3d-view").dispatchEvent(new CustomEvent(${JSON.stringify(TURN_EVENT)}, { detail: ${by} }))`,
      );
    await turn(0);
    if ((await view.getAttribute("data-turns")) !== "1")
      throw new Error(
        `${site}'s 3D view doesn't take ${TURN_EVENT}: is it older than map-spin.ts?`,
      );
    const start = Date.now();
    for (let i = 0; i < FRAMES; i++) {
      await page.screenshot({ path: join(dir, `f${String(i).padStart(3, "0")}.png`) });
      await turn((2 * Math.PI) / FRAMES);
      if ((i + 1) % 40 === 0)
        console.log(
          `${pfid}: frame ${i + 1} of ${FRAMES}, ${((Date.now() - start) / 1000).toFixed(0)} s`,
        );
    }
    const turns = await view.getAttribute("data-turns");
    if (turns !== String(FRAMES + 1)) throw new Error(`the view turned ${turns} times`);
  } finally {
    await browser.close();
  }
  const gif = join(dir, "spin.gif");
  execFileSync(
    "ffmpeg",
    [
      ...["-loglevel", "error", "-y", "-framerate", String(FPS)],
      ...["-i", join(dir, "f%03d.png")],
      "-vf",
      `scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
      ...["-loop", "0", gif],
    ],
    { stdio: "inherit" },
  );
  return readFileSync(gif);
}
