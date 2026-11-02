// What each image looks like, as element trees for Satori (flexbox and CSS, no browser). The
// settled design is the prototype on branch claude/prototype-discord-bot-surfaces; check any
// change by eye with `pnpm render:samples`.
import {
  formatTime,
  MATCH_TYPE_NAME,
  type MedalKind,
  type Medals,
  type PbEvent,
  progress,
  SCORE_TICKS_PER_SECOND,
} from "../domain.js";
import { dailyTime } from "../dailyPost/card.js";
import { HOUR } from "../dailyPost/date.js";
import { joinedLead, type Lead } from "../dailyPost/lead.js";
import type { CardView, ChosenSkin, Improvement, ProfilePreview } from "../ports.js";
import { boardRows, formatGap, mapTitle, matchDetails } from "../present.js";
import {
  hueFor,
  MEDAL_BAR,
  marbleSvg,
  medalHeight,
  medalSvg,
  type SkinPictureUris,
  svgUri,
} from "./art.js";

// ---------------------------------------------------------------- elements

type Style = Readonly<Record<string, string | number>>;
type Child = El | string | null;
export interface El {
  readonly type: string;
  readonly props: {
    readonly style?: Style;
    readonly children?: ReadonlyArray<Child>;
    readonly src?: string;
    readonly width?: number;
    readonly height?: number;
  };
}

/** A box; Satori needs every box with children to be flex. */
const box = (style: Style, ...children: ReadonlyArray<Child>): El => ({
  type: "div",
  props: { style: { display: "flex", ...style }, children: children.filter((c) => c !== null) },
});
const img = (src: string, width: number, height: number, style: Style = {}): El => ({
  type: "img",
  props: { src, width, height, style: { width, height, ...style } },
});
const marble = (hue: number, size: number, style: Style = {}) =>
  img(svgUri(marbleSvg(hue, size)), size, size, style);
/**
 * A player's marble: their Chosen Skin's picture (already round), else their hue marble. Where
 * the marble's hue is a key (the progression graph's lines), `ring` circles a picture in it.
 */
const playerMarble = (
  pictures: SkinPictureUris,
  skin: ChosenSkin,
  steamId: string,
  size: number,
  style: Style = {},
  ring: string | null = null,
) => {
  const picture = skin === null ? undefined : pictures.get(skin);
  if (picture === undefined) return marble(hueFor(steamId), size, style);
  return ring === null
    ? img(picture, size, size, style)
    : box(
        {
          ...style,
          width: size,
          height: size,
          borderRadius: size / 2,
          border: `1.5px solid ${ring}`,
        },
        img(picture, size - 3, size - 3),
      );
};
const medal = (kind: MedalKind, size: number) =>
  img(svgUri(medalSvg(kind, size)), size, medalHeight(size));

// ---------------------------------------------------------------- the site's theme

const C = {
  bg: "#0a1020",
  surface: "rgba(255,255,255,0.05)",
  solid: "#111a2c",
  line: "rgba(150,175,245,0.18)",
  line2: "rgba(255,255,255,0.055)",
  text: "#eaf0ff",
  dim: "#93a2c8",
  faint: "#63719a",
  accent: "#8be03c",
  down: "#ff6b6b",
  upTint: "rgba(139,224,60,0.16)",
  downTint: "rgba(255,107,107,0.18)",
  fresh: "#58a8ff",
  accentInk: "#0d2000",
  gold: "#ffd447",
  silver: "#d3dcea",
  bronze: "#ef9a52",
} as const;

const F = { medal: "Nunito", hud: "Chakra Petch", body: "Archivo", marquee: "Bungee" } as const;

/** The game's black outline on white lettering. */
const OUTLINE = "-1px -1px 0 #111, 1px -1px 0 #111, -1px 1px 0 #111, 1px 1px 0 #111, 0 2px 0 #111";

const backdrop = (style: Style, ...children: ReadonlyArray<Child>) =>
  box(
    {
      flexDirection: "column",
      color: C.text,
      fontFamily: F.body,
      fontSize: 14,
      backgroundColor: C.bg,
      backgroundImage:
        "radial-gradient(circle at 85% -20%, rgba(88,168,255,0.18), transparent 45%), radial-gradient(circle at 0% 0%, rgba(139,224,60,0.10), transparent 40%)",
      borderRadius: 8,
      overflow: "hidden",
      ...style,
    },
    ...children,
  );

const label = (text: string, style: Style = {}) =>
  box(
    {
      fontFamily: F.hud,
      fontWeight: 600,
      fontSize: 10,
      letterSpacing: 1.6,
      textTransform: "uppercase",
      color: C.dim,
      ...style,
    },
    text,
  );

/** The site's two-tone name (`SITE_WORDMARK` in web/lib/rules.ts): BALLEST, then RECORDS in lime. */
const siteWordmark = (fontSize: number) =>
  box(
    { fontFamily: F.marquee, fontSize, letterSpacing: 0.3 },
    box({}, "BALLEST"),
    box({ color: C.accent }, "RECORDS"),
  );

/** The rack and the name; `byline` adds "by BALLESTRECORDS", where the bot presents itself. */
const logo = (byline = false) =>
  box(
    { alignItems: "center", gap: 8 },
    box(
      {},
      marble(212, 16),
      marble(332, 16, { marginLeft: -6 }),
      marble(96, 16, { marginLeft: -6 }),
    ),
    box({ fontFamily: F.marquee, fontSize: 12, letterSpacing: 0.3 }, "MULTIBALLS"),
    ...(byline
      ? [
          box(
            { alignItems: "baseline", gap: 5 },
            box({ fontFamily: F.hud, fontWeight: 600, fontSize: 11, color: C.faint }, "by"),
            siteWordmark(10),
          ),
        ]
      : []),
  );

const chip = (text: string, style: Style = {}, lead: El | null = null) =>
  box(
    {
      alignItems: "center",
      fontFamily: F.hud,
      fontWeight: 700,
      fontSize: 10,
      letterSpacing: 1.6,
      textTransform: "uppercase",
      borderRadius: 999,
      padding: "3px 9px",
      border: `1px solid ${C.line}`,
      color: C.dim,
      ...style,
    },
    lead,
    text,
  );

// ---------------------------------------------------------------- formatting

/** A medal target in seconds, as the medal bars show it: 14.200, or 1:02.500 past a minute. */
const formatTarget = (seconds: number) =>
  formatTime(seconds * SCORE_TICKS_PER_SECOND).replace(/^0:/, "");

const PLACE_COLOUR = [C.gold, C.silver, C.bronze];
const placeColour = (rank: number | null) =>
  rank === null ? C.dim : (PLACE_COLOUR[rank - 1] ?? C.dim);

// ---------------------------------------------------------------- the Match Card ("In-game Screen")

export const CARD_WIDTH = 520;

export interface CardImage {
  readonly view: CardView;
  /** Each Player's display name, by Discord id. */
  readonly names: ReadonlyMap<string, string>;
  /** The Workshop preview as a data URI, or null to draw the stand-in art. */
  readonly preview: string | null;
}

const check = () =>
  img(
    svgUri(
      `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 15 15"><circle cx="7.5" cy="7.5" r="7.5" fill="#111"/><path d="M4.2 7.8l2.2 2.2 4.4-4.6" fill="none" stroke="${C.gold}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    ),
    15,
    15,
  );

/** The game's four medal bars. */
const ladder = (medals: Medals) =>
  box(
    { flexDirection: "column", gap: 4 },
    ...(["bronze", "silver", "gold", "author"] as const).map((kind) =>
      box(
        { borderRadius: 3, overflow: "hidden", fontFamily: F.medal },
        box(
          {
            flexGrow: 1,
            alignItems: "center",
            gap: 6,
            padding: "2px 8px",
            backgroundImage: MEDAL_BAR[kind],
            color: "#fff",
            fontSize: 15,
            fontWeight: 900,
            textShadow: OUTLINE,
          },
          check(),
          kind,
        ),
        box(
          {
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "#1f1f22",
            color: "#fff",
            fontWeight: 800,
            fontSize: 14,
            padding: "2px 12px",
            minWidth: 76,
          },
          formatTarget(medals[kind]),
        ),
      ),
    ),
  );

const ART = "linear-gradient(170deg, #3b7dd8 0%, #7fb6f2 45%, #f5c58a 70%, #e0874a 100%)";

const picture = (card: CardImage, height: number) => {
  const fill: Style = { position: "absolute", left: 0, top: 0, width: CARD_WIDTH, height };
  if (card.view.state === "invite")
    return box(
      {
        ...fill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: C.solid,
        backgroundImage:
          "repeating-linear-gradient(45deg, rgba(255,255,255,0.03) 0px, rgba(255,255,255,0.03) 12px, rgba(255,255,255,0.06) 12px, rgba(255,255,255,0.06) 24px)",
        fontFamily: F.marquee,
        fontSize: 28,
        color: C.faint,
      },
      "?",
    );
  return card.preview === null
    ? box({ ...fill, backgroundImage: ART })
    : img(card.preview, CARD_WIDTH, height, { ...fill, objectFit: "cover" });
};

/** The Card's rows, from the shared Board Slab (present.ts). */
const rowsOf = (card: CardImage) => boardRows(card.view, (id) => card.names.get(id) ?? "Player");

const COLUMNS = { rank: 34, marble: 24 } as const;

const slab = (card: CardImage, pictures: SkinPictureUris) => {
  const invite = card.view.state === "invite";
  return box(
    {
      flexDirection: "column",
      border: `1px solid ${C.line}`,
      borderRadius: 11,
      overflow: "hidden",
      backgroundColor: C.solid,
    },
    box(
      {
        alignItems: "center",
        gap: 10,
        padding: "5px 12px",
        backgroundColor: "rgba(255,255,255,0.035)",
      },
      label(invite ? "Slot" : "Rank", { width: COLUMNS.rank }),
      box({ width: COLUMNS.marble }),
      label("Player", { flexGrow: 1 }),
      label(invite ? "" : "Time"),
    ),
    ...rowsOf(card).map((r) =>
      box(
        {
          alignItems: "center",
          gap: 10,
          padding: "0 12px",
          minHeight: 44,
          borderTop: `1px solid ${C.line2}`,
          color: r.faded ? C.faint : C.text,
        },
        box(
          {
            width: COLUMNS.rank,
            fontFamily: F.hud,
            fontWeight: 600,
            fontSize: 14,
            color: r.faded ? C.faint : placeColour(r.place),
          },
          r.rank,
        ),
        r.steamId === null
          ? marble(0, 24, r.faded ? { opacity: 0.25 } : {})
          : playerMarble(
              pictures,
              card.view.skins[r.steamId] ?? null,
              r.steamId,
              24,
              r.faded ? { opacity: 0.25 } : {},
            ),
        box(
          { flexGrow: 1, flexDirection: "column", minWidth: 0 },
          box(
            {
              fontWeight: 600,
              fontSize: 14.5,
              overflow: "hidden",
              whiteSpace: "nowrap",
              textOverflow: "ellipsis",
            },
            r.name,
          ),
          r.note === ""
            ? null
            : box({ fontFamily: F.hud, fontWeight: 500, fontSize: 10.5, color: C.faint }, r.note),
        ),
        box(
          { alignItems: "center", gap: 8, fontFamily: F.hud, fontWeight: 600, fontSize: 16 },
          r.score,
          r.worldRecord ? wrRibbon() : r.medal === null ? null : medal(r.medal, 16),
        ),
      ),
    ),
  );
};

const stateChip = (view: CardView) =>
  view.state === "invite"
    ? chip(`Invite · ${view.minutes}:00`)
    : view.state === "live" && view.waitingForSteam
      ? chip("Time's up")
      : view.state === "live"
        ? chip(
            "Live",
            {
              backgroundColor: C.accent,
              color: C.accentInk,
              border: "1px solid transparent",
              gap: 5,
            },
            box({ width: 6, height: 6, borderRadius: 3, backgroundColor: C.accentInk }),
          )
        : chip("Final", { color: C.gold, border: "1px solid rgba(255,212,71,0.4)" });

export const cardScene = (card: CardImage, pictures: SkinPictureUris): El => {
  const { view } = card;
  const height = view.state === "invite" ? 110 : 150;
  const title = mapTitle(view);
  const meta = matchDetails(view);
  return backdrop(
    { width: CARD_WIDTH },
    box(
      { position: "relative", width: CARD_WIDTH, height },
      picture(card, height),
      box({
        position: "absolute",
        left: 0,
        top: 0,
        width: CARD_WIDTH,
        height,
        backgroundImage: "linear-gradient(90deg, rgba(10,16,32,0.88), rgba(10,16,32,0.15) 65%)",
      }),
      box(
        {
          position: "absolute",
          left: 0,
          top: 0,
          width: Math.round(CARD_WIDTH * 0.56),
          height,
          padding: "14px 16px",
          flexDirection: "column",
          justifyContent: "space-between",
        },
        logo(),
        box(
          { flexDirection: "column", alignItems: "flex-start" },
          box(
            {
              fontFamily: F.medal,
              fontWeight: 900,
              fontSize: 24,
              lineHeight: 1.1,
              textShadow: OUTLINE,
            },
            title,
          ),
          box(
            { fontFamily: F.hud, fontWeight: 500, fontSize: 11.5, color: C.dim, marginTop: 2 },
            meta,
          ),
          box({ marginTop: 6 }, stateChip(view)),
        ),
      ),
      view.state === "invite" || view.map === null
        ? null
        : box(
            { position: "absolute", right: 10, top: 10, width: 200, flexDirection: "column" },
            ladder(view.map.medals),
          ),
    ),
    box(
      { flexDirection: "column", padding: "2px 16px 14px" },
      box({ marginTop: 10, flexDirection: "column" }, slab(card, pictures)),
    ),
  );
};

// ---------------------------------------------------------------- an Improvement row ("Gold Edge", Big Rank)

export const ROW_WIDTH = 420;

/** A WR in the game's gold: the medal bar's gradient and its outlined lettering. */
const wrRibbon = () =>
  box(
    {
      alignItems: "center",
      padding: "1px 6px",
      borderRadius: 3,
      border: "1.5px solid #111",
      backgroundImage: MEDAL_BAR.gold,
      fontFamily: F.medal,
      fontWeight: 900,
      fontSize: 12,
      color: "#fff",
      textShadow: OUTLINE,
    },
    "WR",
  );

/** "Gold Takeover": a PB that beat the world record, as the game's gold medal bar. */
const worldRecordScene = (
  improvement: Improvement,
  name: string,
  beaten: number,
  skin: ChosenSkin,
  pictures: SkinPictureUris,
): El =>
  box(
    {
      width: ROW_WIDTH,
      height: 56,
      alignItems: "center",
      borderRadius: 8,
      backgroundImage: MEDAL_BAR.gold,
      fontFamily: F.medal,
      fontWeight: 900,
      color: "#fff",
      textShadow: OUTLINE,
    },
    box({ width: 58, justifyContent: "center", fontSize: 24 }, "WR"),
    playerMarble(pictures, skin, improvement.player.steamId, 28),
    box(
      { flexGrow: 1, flexDirection: "column", marginLeft: 10, minWidth: 0 },
      box(
        { fontSize: 15, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" },
        name,
      ),
      box(
        { fontFamily: F.hud, fontWeight: 700, fontSize: 11, color: "#3a2a00", textShadow: "none" },
        `beat ${formatTime(beaten)} by ${formatGap(beaten - improvement.ticks)}`,
      ),
    ),
    box({ fontSize: 22, paddingRight: 16 }, formatTime(improvement.ticks)),
  );

/** An Improvement's row; `skin` is the Improver's Chosen Skin the post carries. */
export const improvementScene = (
  improvement: Improvement,
  name: string,
  skin: ChosenSkin,
  pictures: SkinPictureUris,
): El => {
  if (improvement.beatWorldRecord !== null)
    return worldRecordScene(improvement, name, improvement.beatWorldRecord, skin, pictures);
  const lead = improvement.rank === 1;
  const diff =
    improvement.previousTicks === null
      ? null
      : `-${formatGap(improvement.previousTicks - improvement.ticks)}`;
  return backdrop(
    {
      width: ROW_WIDTH,
      flexDirection: "row",
      alignItems: "center",
      minHeight: 44,
      borderLeft: `4px solid ${lead ? C.gold : C.line}`,
      ...(lead
        ? { backgroundImage: "linear-gradient(90deg, rgba(255,212,71,0.16), transparent 70%)" }
        : {}),
    },
    box(
      {
        width: 58,
        alignItems: "center",
        justifyContent: "center",
        fontFamily: F.hud,
        fontWeight: 700,
        fontSize: 22,
        color: lead ? C.gold : C.dim,
      },
      `P${improvement.rank}`,
    ),
    box(
      { flexGrow: 1, alignItems: "center", gap: 10, paddingRight: 12, minHeight: 44 },
      playerMarble(pictures, skin, improvement.player.steamId, 24),
      box(
        {
          flexGrow: 1,
          fontWeight: 600,
          fontSize: 14.5,
          overflow: "hidden",
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
        },
        name,
      ),
      box(
        { alignItems: "center", gap: 8, fontFamily: F.hud, fontWeight: 600, fontSize: 16 },
        formatTime(improvement.ticks),
        diff === null ? null : box({ fontSize: 13, color: C.accent }, diff),
        improvement.medal === null ? null : medal(improvement.medal, 16),
      ),
    ),
  );
};

// ---------------------------------------------------------------- the Footer ("How It Works")

export const FOOTER_WIDTH = 520;

const STEPS = [
  ["1", "Pick a mode", "Public 1v1, Challenge or Lobby"],
  ["2", "Map is drawn", "A Map no one here has finished"],
  ["3", "Fastest wins", "best time when the clock runs out"],
] as const;

export const footerScene = (): El =>
  backdrop(
    { width: FOOTER_WIDTH, padding: "14px 16px" },
    box({ alignItems: "center", justifyContent: "space-between" }, logo(true), chip("5–60 min")),
    box(
      { gap: 8, marginTop: 10 },
      ...STEPS.map(([n, title, detail]) =>
        box(
          {
            flexDirection: "column",
            flexGrow: 1,
            flexBasis: 0,
            backgroundColor: C.surface,
            border: `1px solid ${C.line}`,
            borderRadius: 9,
            padding: "7px 10px",
          },
          box({ fontFamily: F.hud, fontWeight: 600, fontSize: 18, color: C.accent }, n),
          box({ fontWeight: 700, fontSize: 13 }, title),
          box({ fontSize: 11, color: C.faint }, detail),
        ),
      ),
    ),
    box(
      {
        justifyContent: "center",
        marginTop: 10,
        fontFamily: F.hud,
        fontWeight: 500,
        fontSize: 11.5,
        color: C.faint,
      },
      "Unofficial community tool · not made or supported by the Ballest developers",
    ),
  );

// ---------------------------------------------------------------- the Link confirmation

export const LINK_WIDTH = 400;

/** The Link confirmation; `skin` is the account's Chosen Skin. */
export const linkScene = (
  preview: ProfilePreview,
  skin: ChosenSkin,
  pictures: SkinPictureUris,
): El =>
  backdrop(
    {
      width: LINK_WIDTH,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: "14px 16px",
    },
    playerMarble(pictures, skin, preview.steamId, 48),
    box(
      { flexDirection: "column", width: LINK_WIDTH - 32 - 48 - 12 },
      box({ fontFamily: F.hud, fontWeight: 700, fontSize: 17 }, preview.personaName),
      box(
        { fontFamily: F.hud, fontWeight: 500, fontSize: 11.5, color: C.faint, marginTop: 2 },
        `SteamID ${preview.steamId} · times on ${preview.campaignTracks} of ${preview.campaignTrackTotal} Circuit Tracks`,
      ),
    ),
  );

// ---------------------------------------------------------------- the progression graph ("Staircase")

export const PROGRESSION_WIDTH = 520;

export interface ProgressionImage {
  readonly view: CardView;
  readonly history: ReadonlyArray<PbEvent>;
  /** Each Player's display name, by Discord id. */
  readonly names: ReadonlyMap<string, string>;
}

const MEDAL_COLOUR: Record<MedalKind, string> = {
  bronze: C.bronze,
  silver: C.silver,
  gold: C.gold,
  author: "#b36be8",
};
const MEDAL_ORDER: ReadonlyArray<MedalKind> = ["bronze", "silver", "gold", "author"];

const starPath = (x: number, y: number, r: number) => {
  let d = "";
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    d += `${i ? "L" : "M"}${(x + rr * Math.cos(a)).toFixed(1)} ${(y + rr * Math.sin(a)).toFixed(1)}`;
  }
  return `<path d="${d}Z" fill="${C.gold}" stroke="#111" stroke-width="1.2"/>`;
};

/** A line of text placed like SVG text: `x` is where it starts, ends or centres, `y` its baseline. */
const textAt = (
  x: number,
  y: number,
  text: string,
  style: Style,
  anchor: "start" | "end" | "middle" = "start",
  width: number = PROGRESSION_WIDTH,
): El => {
  const size = typeof style.fontSize === "number" ? style.fontSize : 10;
  const place: Style =
    anchor === "start"
      ? { left: x }
      : anchor === "end"
        ? { right: width - x }
        : { left: x - 60, width: 120, justifyContent: "center" };
  return box(
    {
      position: "absolute",
      top: y - size * 0.82,
      lineHeight: 1,
      whiteSpace: "nowrap",
      ...style,
      ...place,
    },
    text,
  );
};

/**
 * Labels for points down the chart, kept at least `gap` apart: pushed down in order from no higher
 * than `top`, then back up from `bottom`. Each comes back with `labelY`, where it goes.
 */
const spread = <A extends { readonly y: number }>(
  labels: ReadonlyArray<A>,
  gap: number,
  top: number,
  bottom: number,
): Array<A & { labelY: number }> => {
  const placed = [...labels].sort((a, b) => a.y - b.y).map((l) => ({ ...l, labelY: l.y }));
  for (let i = 0; i < placed.length; i++) {
    const prev = placed[i - 1],
      cur = placed[i];
    if (cur !== undefined)
      cur.labelY = Math.max(cur.labelY, prev === undefined ? top : prev.labelY + gap);
  }
  for (let i = placed.length - 1; i >= 0; i--) {
    const cur = placed[i],
      next = placed[i + 1];
    if (cur !== undefined)
      cur.labelY = Math.min(cur.labelY, next === undefined ? bottom : next.labelY - gap);
  }
  return placed;
};

const clockLabel = (t: number) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;

/**
 * Every Player's PB over the Match clock as a step line, with the medals in range and the world
 * record from the start of the Match as dotted lines (each break of it a star), and any PB a
 * Player brought into the Match dotted in until they beat it.
 */
export const progressionScene = (
  { view, history, names }: ProgressionImage,
  pictures: SkinPictureUris,
): El => {
  const W = PROGRESSION_WIDTH,
    H = 470,
    L = 78,
    R = 150,
    T = 100,
    B = 58;
  const map = view.map;
  const secs = (ticks: number) => ticks / SCORE_TICKS_PER_SECOND;
  const label10 = (ticks: number) => formatGap(ticks);
  const duration = view.minutes * 60;
  const wr = map === null ? Infinity : secs(map.worldRecordTicks);
  const personalBests = map?.personalBests ?? {};
  const times = [...history.map((e) => secs(e.ticks)), ...Object.values(personalBests).map(secs)];
  // The scale covers every PB and the WR; medals outside it are listed above the chart.
  const pad = Math.max(0.3, (Math.max(...times) - Math.min(wr, ...times)) * 0.04);
  const hi = Math.max(...times) + pad;
  const x = (t: number) => L + (Math.min(t, duration) / duration) * (W - L - R);
  // Logarithmic from just under the fastest time: close finishes get room, a slow first run still fits.
  const bottom = Math.min(wr, ...times) - 0.15;
  const floor = bottom - Math.max(0.5, pad);
  const f = (s: number) => Math.log(Math.max(s, bottom) - floor);
  const y = (s: number) => T + ((f(hi) - f(Math.min(s, hi))) / (f(hi) - f(bottom))) * (H - T - B);
  const nameOf = (steamId: string) => {
    const p = view.players.find((pl) => pl.steamId === steamId);
    return p === undefined ? "Player" : (names.get(p.discordId) ?? "Player");
  };
  const colourOf = (steamId: string) => `hsl(${hueFor(steamId)},78%,60%)`;

  let lines = "";
  const overlays: Array<El> = [];
  const tick = duration >= 1200 ? 300 : 120;
  for (let t = 0; t <= duration; t += tick) {
    lines += `<line x1="${x(t)}" y1="${T}" x2="${x(t)}" y2="${H - B}" stroke="rgba(255,255,255,0.05)"/>`;
    overlays.push(
      textAt(
        x(t),
        H - B + 16,
        clockLabel(t),
        { fontFamily: F.hud, fontSize: 10, color: C.faint },
        "middle",
      ),
    );
  }

  const above: Array<string> = [];
  const leftLabels: Array<{ y: number; text: string; style: Style; medal: MedalKind | null }> = [];
  if (map !== null)
    for (const kind of MEDAL_ORDER) {
      const v = map.medals[kind];
      if (v > hi) {
        above.push(`${kind} ${label10(v * SCORE_TICKS_PER_SECOND)}`);
        continue;
      }
      lines += `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="${MEDAL_COLOUR[kind]}" stroke-opacity="0.55" stroke-width="1.2" stroke-dasharray="2 4"/>`;
      leftLabels.push({
        y: y(v),
        text: label10(v * SCORE_TICKS_PER_SECOND),
        style: { fontFamily: F.hud, fontSize: 10, color: MEDAL_COLOUR[kind] },
        medal: kind,
      });
    }
  if (above.length > 0)
    overlays.push(
      textAt(L, T - 10, `▲ above the chart: ${above.join(" · ")}`, {
        fontFamily: F.hud,
        fontSize: 10,
        color: C.faint,
      }),
    );

  // Each PB that beat the world record standing at the time.
  const breaks =
    map === null ? [] : progress(map, history).filter((e) => e.beatWorldRecord !== null);
  if (map !== null) {
    lines += `<line x1="${L}" y1="${y(wr)}" x2="${W - R}" y2="${y(wr)}" stroke="#fff" stroke-dasharray="2 4" stroke-width="1.3"/>`;
    leftLabels.push({
      y: y(wr),
      text: `WR ${label10(map.worldRecordTicks)}`,
      style: { fontFamily: F.hud, fontWeight: 700, fontSize: 10, color: "#fff" },
      medal: null,
    });
  }

  // Where each Player's line meets the right edge, for their name in the legend.
  const lineEnds = new Map<string, number>();
  for (const player of view.players) {
    const pts = history.filter((e) => e.steamId === player.steamId);
    const colour = colourOf(player.steamId);
    const pb = personalBests[player.steamId];
    const first = pts[0];
    const last = pts.at(-1)?.ticks ?? pb;
    if (last !== undefined) lineEnds.set(player.steamId, y(secs(last)));
    if (pb !== undefined)
      lines += `<line x1="${x(0)}" y1="${y(secs(pb))}" x2="${x(first === undefined ? duration : first.at / 1000)}" y2="${y(secs(pb))}" stroke="${colour}" stroke-width="1.6" stroke-dasharray="2 3"/>`;
    if (first === undefined) continue;
    let d = `M${x(first.at / 1000)} ${y(secs(first.ticks))}`;
    for (const e of pts.slice(1)) d += `H${x(e.at / 1000)}V${y(secs(e.ticks))}`;
    lines += `<path d="${d}H${x(duration)}" fill="none" stroke="${colour}" stroke-width="2.3" stroke-linejoin="round"/>`;
    for (const e of pts)
      lines += `<circle cx="${x(e.at / 1000)}" cy="${y(secs(e.ticks))}" r="2.8" fill="${colour}" stroke="${C.bg}" stroke-width="1"/>`;
  }
  for (const e of breaks)
    lines += `<circle cx="${x(e.at / 1000)}" cy="${y(secs(e.ticks))}" r="15" fill="${C.gold}" fill-opacity="0.18"/>${starPath(x(e.at / 1000), y(secs(e.ticks)), 10)}`;

  // At least a line apart.
  for (const l of spread(leftLabels, 13, -Infinity, H - B + 4)) {
    if (Math.abs(l.labelY - l.y) > 2)
      lines += `<path d="M${L - 6} ${l.labelY}L${L} ${l.y}" stroke="${String(l.style.color)}" stroke-opacity="0.6"/>`;
    if (l.medal !== null)
      overlays.push(
        img(svgUri(medalSvg(l.medal, 11)), 11, medalHeight(11), {
          position: "absolute",
          left: L - 19,
          top: l.labelY - 8,
        }),
      );
    overlays.push(textAt(L - 24, l.labelY + 3.5, l.text, l.style, "end"));
  }

  // Each line's Player named beside where it ends: slower times sit higher. Names with their
  // time a row below while they fit, else the name alone, packed as tight as it takes.
  const ends = view.standings.flatMap((s) => {
    const end = lineEnds.get(s.player.steamId) ?? (s.ticks === null ? undefined : y(secs(s.ticks)));
    return end === undefined ? [] : [{ y: end, standing: s }];
  });
  const ROW = 36,
    TIGHT_ROW = 18,
    legendBottom = H - B - 8;
  const roomy = (ends.length - 1) * ROW <= legendBottom - T;
  const legend = spread(
    ends,
    roomy ? ROW : Math.min(TIGHT_ROW, (legendBottom - T) / (ends.length - 1)),
    T,
    legendBottom,
  );
  for (const { y: end, labelY, standing } of legend)
    if (Math.abs(labelY - end) > 2)
      lines += `<path d="M${W - R} ${end}L${W - R + 10} ${labelY + 1}" stroke="${colourOf(standing.player.steamId)}" stroke-opacity="0.6"/>`;

  const chart = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${lines}</svg>`;
  const holder = breaks.at(-1)?.steamId;
  const untimed = view.standings.filter((s) => s.ticks === null && !lineEnds.has(s.player.steamId));

  return backdrop(
    { width: W, height: H, position: "relative" },
    img(svgUri(chart), W, H, { position: "absolute", left: 0, top: 0 }),
    ...overlays,
    box(
      { position: "absolute", left: 16, top: 12, width: W - 32, flexDirection: "column" },
      box({ justifyContent: "space-between", alignItems: "center" }, logo(), label("Progression")),
      box(
        { fontFamily: F.medal, fontWeight: 900, fontSize: 20, textShadow: OUTLINE, marginTop: 8 },
        map?.title ?? "Match",
      ),
      box(
        { fontFamily: F.hud, fontWeight: 500, fontSize: 10.5, color: C.dim },
        `${view.minutes}-minute ${MATCH_TYPE_NAME[view.type]} · WR at the start ${map === null ? "none" : label10(map.worldRecordTicks)} · every PB as it happened`,
      ),
    ),
    ...legend.map(({ labelY, standing: s }) => {
      const id = s.player.steamId;
      const time = `${s.ticks === null ? "no time" : formatTime(s.ticks)}${id === holder ? "  ★ new WR" : ""}`;
      return box(
        {
          position: "absolute",
          left: W - R + 12,
          top: labelY - (roomy ? 8 : 5),
          width: R - 24,
          gap: roomy ? 8 : 6,
          alignItems: roomy ? "flex-start" : "center",
        },
        playerMarble(
          pictures,
          view.skins[id] ?? null,
          id,
          roomy ? 16 : 11,
          roomy ? { marginTop: 1 } : {},
          colourOf(id),
        ),
        box(
          { flexDirection: "column", flexShrink: 1, minWidth: 0 },
          box(
            {
              fontWeight: 600,
              fontSize: roomy ? 11 : 10,
              ...(roomy ? {} : { lineHeight: 1, whiteSpace: "nowrap", overflow: "hidden" }),
              color: !roomy && id === holder ? C.gold : C.text,
            },
            nameOf(id),
          ),
          roomy
            ? box(
                {
                  fontFamily: F.hud,
                  fontWeight: 600,
                  fontSize: 10,
                  color: id === holder ? C.gold : C.dim,
                },
                time,
              )
            : null,
        ),
      );
    }),
    untimed.length === 0
      ? null
      : textAt(L, H - 12, `No time: ${untimed.map((s) => nameOf(s.player.steamId)).join(", ")}`, {
          fontFamily: F.hud,
          fontSize: 10,
          color: C.faint,
        }),
  );
};

// ---------------------------------------------------------------- the Activity's art
// The images uploaded to the Developer Portal (Activities -> Art Assets, and the app icon), written
// by `pnpm render:activity-art`. The settled design is the prototype on branch claude/prototype-activity-art:
// the logo's three marbles racked in a triangle, pink at the front. Scenes are laid out at half
// size; the renderer draws them at twice that.

export type ActivityArt = "icon" | "cover" | "background";

/** Layout sizes: a 1024 icon, and a 1920x1080 cover and grid-view background. */
export const ACTIVITY_ART_SIZE: Record<ActivityArt, readonly [width: number, height: number]> = {
  icon: [512, 512],
  cover: [960, 540],
  background: [960, 540],
};

const LOGO_HUES = { blue: 212, pink: 332, lime: 96 } as const;

/** Art drawn in a 1600x900 (or 1024 square) SVG, placed over the whole scene. */
const artSvg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
const placedMarble = (hue: number, cx: number, cy: number, r: number, id: string) =>
  `<g transform="translate(${cx - r} ${cy - r})">${marbleSvg(hue, r * 2, id)}</g>`;
const floorShadow = (cx: number, cy: number, rx: number) =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${rx * 0.22}" fill="#000" opacity=".5"/>`;
const glow = (
  id: string,
  cx: string,
  cy: string,
  r: string,
  color: string,
  opacity: number,
  w: number,
  h: number,
) =>
  `<defs><radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}"><stop offset="0" stop-color="${color}" stop-opacity="${opacity}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#${id})"/>`;

/** The cover: the rack under one soft light, on a lit floor. Everything sits inside the 13:11 centre crop (x 268..1332). */
const coverArt = () =>
  artSvg(
    1600,
    900,
    `<rect width="1600" height="900" fill="#070c18"/>` +
      glow("spot", "50%", "38%", "55%", "#3a5fa8", 0.55, 1600, 900) +
      `<ellipse cx="800" cy="610" rx="544" ry="63" fill="#8fb4ff" opacity=".10"/>` +
      floorShadow(640, 610, 130) +
      floorShadow(960, 610, 130) +
      floorShadow(800, 640, 140) +
      placedMarble(LOGO_HUES.blue, 640, 460, 140, "b") +
      placedMarble(LOGO_HUES.lime, 960, 460, 140, "l") +
      placedMarble(LOGO_HUES.pink, 800, 500, 150, "p"),
  );

/** The icon: the same triangle filling the circle Discord masks it to, on flat navy. */
const iconArt = () =>
  artSvg(
    1024,
    1024,
    `<rect width="1024" height="1024" fill="${C.bg}"/>` +
      placedMarble(LOGO_HUES.blue, 318, 380, 236, "b") +
      placedMarble(LOGO_HUES.lime, 706, 380, 236, "l") +
      placedMarble(LOGO_HUES.pink, 512, 700, 250, "p"),
  );

/** Grid view: the Activity page's navy glow, with a marble cropped into three corners and the centre clear for Discord's tiles. */
const backgroundArt = () =>
  artSvg(
    1600,
    900,
    `<rect width="1600" height="900" fill="${C.bg}"/>` +
      glow("blue", "80%", "-10%", "75%", "#58a8ff", 0.3, 1600, 900) +
      glow("lime", "4%", "4%", "65%", "#8be03c", 0.18, 1600, 900) +
      placedMarble(LOGO_HUES.blue, 60, 40, 260, "b") +
      placedMarble(LOGO_HUES.pink, 1580, 880, 300, "p") +
      placedMarble(LOGO_HUES.lime, 1560, 60, 170, "l"),
  );

/** "DEV", on the dev app's art so the two apps tell apart on the test server's shelf. */
const devTag = (fontSize: number) =>
  box(
    {
      fontFamily: F.hud,
      fontWeight: 700,
      fontSize,
      letterSpacing: fontSize * 0.14,
      color: C.accentInk,
      backgroundColor: C.accent,
      borderRadius: fontSize * 0.4,
      padding: `${fontSize * 0.12}px ${fontSize * 0.45}px`,
    },
    "DEV",
  );

export const activityArtScene = (art: ActivityArt, dev: boolean): El => {
  const [w, h] = ACTIVITY_ART_SIZE[art];
  const svg = art === "icon" ? iconArt() : art === "cover" ? coverArt() : backgroundArt();
  return box(
    { position: "relative", width: w, height: h, backgroundColor: C.bg },
    img(svgUri(svg), w, h, { position: "absolute", left: 0, top: 0 }),
    art === "cover"
      ? box(
          {
            position: "absolute",
            left: 0,
            top: 432,
            width: w,
            justifyContent: "center",
            fontFamily: F.marquee,
            fontSize: 47,
            letterSpacing: 1.4,
            color: C.text,
          },
          "MULTI",
          box({ color: C.accent }, "BALLS"),
        )
      : null,
    // The icon's tag sits bottom centre, where the circle mask keeps it; the cover's sits inside the 13:11 crop.
    dev && art === "icon"
      ? box(
          { position: "absolute", left: 0, bottom: 34, width: w, justifyContent: "center" },
          devTag(60),
        )
      : null,
    dev && art === "cover"
      ? box({ position: "absolute", right: 180, bottom: 22 }, devTag(26))
      : null,
  );
};

// ---------------------------------------------------------------- the Daily Report's standings

/** The standings image's padding, and the gap between the two boards side by side. */
const STANDINGS_PADDING = 28;
const STANDINGS_GAP = 24;
/** A row's marble, and the gap between the things on a row. */
const STANDINGS_MARBLE = 16;
const STANDINGS_ROW_GAP = 8;
/** A row's text part, beside its marble: its place, move pill, name and counts. */
const STANDINGS_TEXT = 270;
/** One board: its text, and a marble before each name. */
const STANDINGS_COLUMN = STANDINGS_TEXT + STANDINGS_MARBLE + STANDINGS_ROW_GAP;
export const STANDINGS_WIDTH = STANDINGS_PADDING * 2 + STANDINGS_COLUMN * 2 + STANDINGS_GAP;
/** Widest a name gets before it is clipped, so a row and its pills stay on one line. */
const STANDINGS_NAME = 17;

/** A row on one of the Daily Report's boards, and how it changed in the last 24 hours. */
export interface StandingsRow {
  readonly steamId: string;
  /** Their Chosen Skin when the report was built, or null for their hue marble. */
  readonly skin: ChosenSkin;
  readonly name: string;
  readonly n: number;
  /** The shared place: players on the same count show the same one. */
  readonly place: number;
  /** Places climbed (negative: fallen), or "new" to the board's top 10. */
  readonly move: number | "new";
  /** n now less n 24 hours before. */
  readonly gain: number;
}

/** A row of the overall standing: points from the player's places on the four standings. */
export interface OverallRow {
  readonly steamId: string;
  readonly skin: ChosenSkin;
  readonly name: string;
  readonly points: number;
  readonly place: number;
  readonly move: number | "new";
  /** Their place on each of the four boards, in the boards' order; null outside its top 10. */
  readonly places: ReadonlyArray<number | null>;
}

/** A row of yesterday's Daily: its place on the Daily's board, the player, and their time. */
export interface DailyRow {
  readonly steamId: string;
  readonly skin: ChosenSkin;
  readonly name: string;
  readonly place: number;
  /** Behind 1st, "+0.026", or null for 1st. */
  readonly gap: string | null;
  /** "9.604", "11.604", "1:11.500" */
  readonly time: string;
}

/** The latest Daily (round 2's B): its Map's banner and its top 10. */
export interface DailyBoard {
  /** "Yesterday's Daily", or "Latest Daily" for an older one. */
  readonly heading: string;
  readonly title: string;
  /** "Daily · Sat 31 Oct · 291 players", under the title. */
  readonly meta: string;
  /** The Map's preview as a data URI, or null for the stand-in art. */
  readonly preview: string | null;
  readonly rows: ReadonlyArray<DailyRow>;
}

/**
 * The Daily Report's boards (src/report/): yesterday's Daily first when one is final, Overall
 * across the full width, then the four two by two, ten rows each. Each of the four takes its
 * colour from its place in `boards`.
 */
export interface StandingsImage {
  readonly title: string;
  readonly subtitle: string;
  /** Yesterday's Daily, or null while no Daily is final (no board then). */
  readonly daily: DailyBoard | null;
  readonly boards: ReadonlyArray<{
    readonly title: string;
    readonly rows: ReadonlyArray<StandingsRow>;
    /** Who left the board's top 10 in the last 24 hours. */
    readonly out: ReadonlyArray<string>;
  }>;
  readonly overall: {
    readonly rows: ReadonlyArray<OverallRow>;
    /** Who left Overall's top 10 in the last 24 hours. */
    readonly out: ReadonlyArray<string>;
  };
}

const tone = (up: boolean) =>
  up ? { ink: C.accent, tint: C.upTint } : { ink: C.down, tint: C.downTint };

const triangle = (up: boolean) =>
  img(
    svgUri(
      `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="6" viewBox="0 0 10 10"><path d="${up ? "M5 1L9.5 9H0.5Z" : "M5 9L9.5 1H0.5Z"}" fill="${tone(up).ink}"/></svg>`,
    ),
    6,
    6,
  );

const pill = (up: boolean, ...children: ReadonlyArray<Child>) =>
  box(
    {
      alignItems: "center",
      gap: 2,
      padding: "1px 4px",
      borderRadius: 4,
      fontFamily: F.hud,
      fontWeight: 700,
      fontSize: 10,
      color: tone(up).ink,
      backgroundColor: tone(up).tint,
    },
    ...children,
  );

const movePill = (move: StandingsRow["move"]) =>
  move === "new"
    ? box(
        {
          fontFamily: F.hud,
          fontWeight: 700,
          fontSize: 8,
          letterSpacing: 0.6,
          padding: "1px 3px",
          borderRadius: 3,
          color: C.bg,
          backgroundColor: C.fresh,
        },
        "NEW",
      )
    : move === 0
      ? null
      : pill(move > 0, triangle(move > 0), String(Math.abs(move)));

const clipName = (name: string, longest = STANDINGS_NAME) =>
  name.length > longest ? `${name.slice(0, longest - 1)}…` : name;

/** The overall standing's rule, under its heading. */
export const OVERALL_RULE =
  "10 points for 1st on a standing down to 1 for 10th, added across all four";

const MEDAL_INK = [C.gold, C.silver, C.bronze];

/**
 * The four standings' marble hues, in the boards' order: Maps played teal, Author Medals purple,
 * world records pink, the fourth blue. A board's title leads with its marble, the image's key to
 * the places on Overall.
 */
const BOARD_HUE = [170, 275, 330, 220];
const boardHue = (i: number) => BOARD_HUE[i] ?? 0;

const PLACE_MARBLE = 20;

/**
 * A place on one of the four boards, on an Overall row: the place on a marble in the board's
 * colour, ringed in its medal's colour on the podium; an empty socket outside the top 10.
 */
const placeMarble = (place: number | null, i: number) => {
  const cell = {
    width: PLACE_MARBLE + 4,
    height: PLACE_MARBLE + 4,
    alignItems: "center",
    justifyContent: "center",
  } as const;
  if (place === null)
    return box(
      cell,
      box({
        width: PLACE_MARBLE - 6,
        height: PLACE_MARBLE - 6,
        borderRadius: PLACE_MARBLE,
        border: `1px dashed ${C.line}`,
      }),
    );
  const medal = MEDAL_INK[place - 1];
  return box(
    {
      ...cell,
      borderRadius: PLACE_MARBLE,
      border: medal === undefined ? "2px solid transparent" : `2px solid ${medal}`,
    },
    box(
      { ...cell, position: "relative", width: PLACE_MARBLE, height: PLACE_MARBLE },
      marble(boardHue(i), PLACE_MARBLE, { position: "absolute", top: 0, left: 0 }),
      box(
        { fontFamily: F.hud, fontWeight: 700, fontSize: 11, color: "#fff", textShadow: OUTLINE },
        String(place),
      ),
    ),
  );
};

/** A row on a board: its shared place, its move, the player, then what it counts. */
const standingsRow = (
  pictures: SkinPictureUris,
  first: boolean,
  row: Pick<StandingsRow, "steamId" | "skin" | "name" | "place" | "move">,
  ...counts: ReadonlyArray<Child>
) =>
  box(
    {
      alignItems: "center",
      gap: STANDINGS_ROW_GAP,
      fontSize: 15,
      padding: "3px 8px",
      borderRadius: 6,
      backgroundColor: first ? C.upTint : C.surface,
    },
    box(
      { width: 18, color: row.place <= 3 ? C.gold : C.faint, fontFamily: F.hud, fontWeight: 700 },
      String(row.place),
    ),
    box({ width: 30 }, movePill(row.move)),
    playerMarble(pictures, row.skin, row.steamId, STANDINGS_MARBLE),
    box({ flexGrow: 1, overflow: "hidden" }, clipName(row.name)),
    ...counts,
  );

/** A board: its heading, its rows, then who left its top 10, or "Nobody yet". */
const standingsBoard = (
  heading: Child,
  rows: ReadonlyArray<El>,
  out: ReadonlyArray<string>,
  style: Style = {},
) =>
  box(
    { flexDirection: "column", gap: 4, ...style },
    heading,
    ...rows,
    ...out.map((name) =>
      box(
        {
          alignItems: "center",
          gap: 8,
          fontSize: 15,
          padding: "2px 7px",
          borderRadius: 6,
          border: `1px dashed ${C.line}`,
          color: C.dim,
          opacity: 0.75,
        },
        box({ width: 18, color: C.faint, fontFamily: F.hud, fontWeight: 700 }, "–"),
        box({ width: 46 }, pill(false, triangle(false), "OUT")),
        box({ flexGrow: 1, overflow: "hidden" }, clipName(name)),
      ),
    ),
    rows.length + out.length === 0 ? box({ color: C.faint, fontSize: 14 }, "Nobody yet") : null,
  );

const boardTitle = (title: string) =>
  label(title, { fontSize: 13, letterSpacing: 1.4, marginBottom: 6 });

/** One of the four boards' titles, led by its marble. */
const keyedTitle = (title: string, i: number) =>
  box(
    { alignItems: "center", gap: 8, marginBottom: 6 },
    marble(boardHue(i), 14),
    label(title, { fontSize: 13, letterSpacing: 1.4 }),
  );

/** The full width of the image inside its padding, which Overall and yesterday's Daily span. */
const STANDINGS_FULL = STANDINGS_COLUMN * 2 + STANDINGS_GAP;
const DAILY_BANNER = 110;
/** Yesterday's Daily rows in each of its two columns. */
const DAILY_COLUMN_ROWS = 5;
/** A Daily row's time, wide enough for "1:11.500". */
const DAILY_TIME = 70;
/** Widest a name gets on a Daily row, beside its gap and time, before it is clipped. */
const DAILY_NAME = 12;

/** A row of yesterday's Daily: place (the podium in its medals' colours), marble, name, gap, time. */
const dailyRow = (pictures: SkinPictureUris, row: DailyRow) =>
  box(
    {
      alignItems: "center",
      gap: STANDINGS_ROW_GAP,
      fontSize: 15,
      padding: "3px 8px",
      borderRadius: 6,
      backgroundColor: row.place === 1 ? C.upTint : C.surface,
    },
    box(
      { width: 22, color: MEDAL_INK[row.place - 1] ?? C.faint, fontFamily: F.hud, fontWeight: 700 },
      String(row.place),
    ),
    playerMarble(pictures, row.skin, row.steamId, STANDINGS_MARBLE),
    box({ flexGrow: 1, overflow: "hidden" }, clipName(row.name, DAILY_NAME)),
    row.gap === null ? null : box({ color: C.faint, fontFamily: F.hud, fontSize: 11 }, row.gap),
    box(
      { width: DAILY_TIME, justifyContent: "flex-end", fontFamily: F.hud, fontWeight: 700 },
      row.time,
    ),
  );

/**
 * Yesterday's Daily: its Map's preview as a banner, darkened from the left under its title, then
 * its top 10 in two columns of five.
 */
const dailyBoard = (daily: DailyBoard, pictures: SkinPictureUris) => {
  const fill: Style = {
    position: "absolute",
    top: 0,
    left: 0,
    width: STANDINGS_FULL,
    height: DAILY_BANNER,
  };
  const column = (rows: ReadonlyArray<DailyRow>) =>
    box(
      { flexDirection: "column", gap: 4, width: STANDINGS_COLUMN },
      ...rows.map((row) => dailyRow(pictures, row)),
    );
  return box(
    { flexDirection: "column", gap: 8 },
    box(
      {
        position: "relative",
        width: STANDINGS_FULL,
        height: DAILY_BANNER,
        borderRadius: 8,
        overflow: "hidden",
        marginBottom: 4,
      },
      daily.preview === null
        ? box({ ...fill, backgroundImage: ART })
        : img(daily.preview, STANDINGS_FULL, DAILY_BANNER, { ...fill, objectFit: "cover" }),
      box({
        ...fill,
        backgroundImage:
          "linear-gradient(90deg, rgba(10,16,32,0.92) 0%, rgba(10,16,32,0.55) 55%, rgba(10,16,32,0.1) 100%)",
      }),
      box(
        { position: "absolute", left: 16, bottom: 12, flexDirection: "column", gap: 3 },
        label(daily.heading, { fontSize: 11, letterSpacing: 1.4, color: C.text }),
        box({ fontFamily: F.marquee, fontSize: 24, textShadow: OUTLINE }, daily.title),
        box({ color: C.dim, fontSize: 12 }, daily.meta),
      ),
    ),
    box(
      { gap: STANDINGS_GAP },
      column(daily.rows.slice(0, DAILY_COLUMN_ROWS)),
      column(daily.rows.slice(DAILY_COLUMN_ROWS, DAILY_COLUMN_ROWS * 2)),
    ),
  );
};

export const standingsScene = (
  { title, subtitle, daily, boards, overall }: StandingsImage,
  pictures: SkinPictureUris,
): El => {
  const column = (board: StandingsImage["boards"][number], i: number) =>
    standingsBoard(
      keyedTitle(board.title, i),
      board.rows.map((row, i) =>
        standingsRow(
          pictures,
          i === 0,
          row,
          row.gain === 0
            ? null
            : pill(row.gain > 0, `${row.gain > 0 ? "+" : "−"}${Math.abs(row.gain)}`),
          box({ fontFamily: F.hud, fontWeight: 700, color: C.text }, String(row.n)),
        ),
      ),
      board.out,
      { width: STANDINGS_COLUMN },
    );
  // Overall runs the full width above the four (spec #373: variant A of the prototype).
  const overallBoard = standingsBoard(
    box(
      { justifyContent: "space-between", alignItems: "flex-end" },
      boardTitle("Overall"),
      box({ color: C.faint, fontSize: 11, marginBottom: 6 }, OVERALL_RULE),
    ),
    overall.rows.map((row, i) =>
      standingsRow(
        pictures,
        i === 0,
        row,
        box({ gap: 4 }, ...row.places.map(placeMarble)),
        box(
          { width: 58, justifyContent: "flex-end", fontFamily: F.hud, fontWeight: 700 },
          String(row.points),
          box(
            { color: C.faint, fontSize: 11, marginLeft: 3, marginTop: 3 },
            row.points === 1 ? "pt" : "pts",
          ),
        ),
      ),
    ),
    overall.out,
  );
  const keyed = boards.map((board, i) => column(board, i));
  const pairs = [keyed.slice(0, 2), keyed.slice(2, 4)].filter((p) => p.length > 0);
  return backdrop(
    { padding: STANDINGS_PADDING, gap: 20 },
    box(
      { flexDirection: "column", gap: 4 },
      box({ fontFamily: F.marquee, fontSize: 28 }, title),
      box({ color: C.dim, fontSize: 14 }, subtitle),
    ),
    daily === null ? null : dailyBoard(daily, pictures),
    overallBoard,
    ...pairs.map((pair) => box({ gap: STANDINGS_GAP }, ...pair)),
  );
};

// ---------------------------------------------------------------- the Daily Post's lead graph
// Under the podium on a Daily Post (spec #268): the leading time through the Daily as a step
// line, faster times lower, each step coloured by its leader and named under it. The settled
// design is graph A (flipped) in the prototype on branch claude/prototype-daily-post. Laid out at
// half size; the renderer draws it at twice that.

export const LEAD_GRAPH_WIDTH = 500;

export interface LeadGraphImage {
  readonly opensAt: number;
  readonly closesAt: number;
  /** Each read that changed the lead, oldest first. */
  readonly leads: ReadonlyArray<Lead>;
  /** While the Daily is live, the moment marked "now"; null once it has closed. */
  readonly now: number | null;
}

/** The graph's own ground, and the dataviz palette's dark categorical slots validated on it. */
const G = { bg: "#121628", grid: "#262c46", dim: "#9aa3c7", text: "#eef0fb", faint: "#5b648a" };
const LEADER_COLOURS = ["#3987e5", "#d95926", "#199e70", "#c98500"];

/** A round step for the time axis's lines, about a third of `range` seconds. */
const niceStep = (range: number) => {
  const raw = range / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 5, 10].find((m) => m * power >= raw) ?? 10) * power;
};

/** Roughly how wide a line of Chakra Petch is: for keeping labels apart. */
const textWidth = (text: string, size: number) => text.length * size * 0.56;

const clip = (name: string) => (name.length > 16 ? `${name.slice(0, 15)}…` : name);

export const leadGraphScene = ({ opensAt, closesAt, leads, now }: LeadGraphImage): El => {
  const W = LEAD_GRAPH_WIDTH,
    H = 190,
    L = 45,
    R = 15,
    T = 30,
    B = 24;
  const span = Math.max(closesAt - opensAt, 1);
  const end = Math.min(now ?? closesAt, closesAt);
  const x = (at: number) => L + (Math.min(Math.max(at - opensAt, 0), span) / span) * (W - L - R);
  const secs = (ticks: number) => ticks / SCORE_TICKS_PER_SECOND;
  const times = leads.map((l) => secs(l.ticks));
  const fastest = times.length === 0 ? 0 : Math.min(...times);
  const slowest = times.length === 0 ? 1 : Math.max(...times);
  const range = Math.max(slowest - fastest, 0.05);
  const lo = fastest - range * 0.12,
    hi = slowest + range * 0.08;
  // Faster is lower: the slowest time sits at the top.
  const y = (s: number) => T + ((hi - s) / (hi - lo)) * (H - T - B);

  // Each leader's colour, in the order they first led; a fifth on reuses no hue.
  const order: Array<string> = [];
  for (const lead of leads) for (const n of lead.leaders) if (!order.includes(n)) order.push(n);
  const colourOf = (name: string) => LEADER_COLOURS[order.indexOf(name)] ?? G.dim;
  /** Whose Reign a step is: of a tie, whoever led first. */
  const holderOf = (lead: Lead) =>
    [...lead.leaders].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? "";

  const hud = (size: number, weight: number, color: string): Style => ({
    fontFamily: F.hud,
    fontWeight: weight,
    fontSize: size,
    color,
  });
  let lines = "";
  const overlays: Array<El> = [];

  const step = niceStep(hi - lo);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    lines += `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="${G.grid}" stroke-width="0.5"/>`;
    overlays.push(
      textAt(
        L - 5,
        y(v) + 3,
        dailyTime(Math.round(v * SCORE_TICKS_PER_SECOND)),
        hud(7.5, 500, G.dim),
        "end",
        W,
      ),
    );
  }

  const axisY = H - B + 12;
  const quarter = Math.round(span / 4 / HOUR);
  (
    [
      [0, "opened", "start"],
      [1, `+${quarter}h`, "middle"],
      [2, `+${quarter * 2}h`, "middle"],
      [3, `+${quarter * 3}h`, "middle"],
      [4, "closes", "end"],
    ] as const
  ).forEach(([q, text, anchor]) =>
    overlays.push(
      textAt(x(opensAt + (span * q) / 4), axisY, text, hud(7.5, 500, G.dim), anchor, W),
    ),
  );

  if (now !== null) {
    lines += `<line x1="${x(end)}" y1="${T - 5}" x2="${x(end)}" y2="${H - B}" stroke="${G.faint}" stroke-width="0.5" stroke-dasharray="2 2"/>`;
    lines += `<line x1="${x(end)}" y1="${H - B + 1}" x2="${x(end)}" y2="${H - B + 4}" stroke="${G.text}" stroke-width="1"/>`;
    overlays.push(textAt(x(end) + 3, T - 1, "now", hud(7, 600, G.dim), "start", W));
  }

  // The steps, then a dot where each began, and who led it named under it.
  const labels: Array<{ x: number; y: number; text: string; width: number }> = [];
  const steps: Array<{ from: number; to: number; y: number }> = [];
  leads.forEach((lead, i) => {
    const next = leads[i + 1];
    const prev = leads[i - 1];
    const colour = colourOf(holderOf(lead));
    const [x0, x1, ly] = [x(lead.at), x(next?.at ?? end), y(secs(lead.ticks))];
    lines += `<line x1="${x0}" y1="${ly}" x2="${x1}" y2="${ly}" stroke="${colour}" stroke-width="1.5"/>`;
    steps.push({ from: x0, to: x1, y: ly });
    if (next !== undefined)
      lines += `<line x1="${x1}" y1="${ly}" x2="${x1}" y2="${y(secs(next.ticks))}" stroke="${colour}" stroke-width="1"/>`;
    const joined = prev === undefined ? [] : joinedLead(prev, lead);
    const dot = joined[0] ?? holderOf(lead);
    lines += `<circle cx="${x0}" cy="${ly}" r="2.5" fill="${colourOf(dot)}" stroke="${G.bg}" stroke-width="1"/>`;
    // A name starts at its dot, or ends at the plot's right edge when it would run past it (a
    // late steal, or a lead first seen at the close).
    const label = (text: string, ty: number) => {
      const width = textWidth(text, 8);
      labels.push({ x: Math.min(x0 + 2, W - R - width), y: ty, text, width });
    };
    if (joined.length > 0)
      label(`${joined.map(clip).join(" & ")} ${joined.length === 1 ? "ties" : "tie"}`, ly - 5);
    else if (prev === undefined || holderOf(prev) !== holderOf(lead))
      label(clip(holderOf(lead)), ly + 11);
  });
  // The latest labels win where two would overlap.
  const kept: typeof labels = [];
  for (const l of [...labels].reverse())
    if (!kept.some((k) => Math.abs(k.y - l.y) < 9 && l.x < k.x + k.width && k.x < l.x + l.width))
      kept.push(l);
  for (const l of kept.reverse())
    overlays.push(textAt(l.x, l.y, l.text, hud(8, 600, G.text), "start", W));

  // The leading time now, at the end of the line: beside it, else above or below it, wherever it
  // clears the names; ending against the right edge once the line reaches it.
  const last = leads.at(-1);
  if (last !== undefined) {
    const text = dailyTime(last.ticks);
    const ly = y(secs(last.ticks));
    const width = textWidth(text, 9);
    const right = x(end) + 5 + width <= W - 2;
    const left = right ? x(end) + 5 : x(end) - width;
    // Each label's box runs from a line's height above its baseline down to the baseline. The
    // time clears the names, and the steps it would sit on (a late steal's last step is short).
    const clear = (baseline: number) =>
      !kept.some(
        (k) =>
          k.y - 8 < baseline + 1 &&
          baseline - 9 < k.y + 1 &&
          k.x < left + width &&
          left < k.x + k.width,
      ) &&
      !steps.some(
        (st) =>
          baseline - 8 < st.y && st.y < baseline + 2 && st.from < left + width && left < st.to,
      );
    const baseline = [right ? ly + 3.5 : ly - 6, ly - 6, ly + 13, ly - 16].find(clear) ?? ly - 6;
    overlays.push(
      right
        ? textAt(left, baseline, text, hud(9, 700, G.text), "start", W)
        : textAt(x(end), baseline, text, hud(9, 700, G.text), "end", W),
    );
  }

  const chart = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${lines}</svg>`;
  return box(
    { width: W, height: H, position: "relative", backgroundColor: G.bg, color: G.text },
    img(svgUri(chart), W, H, { position: "absolute", left: 0, top: 0 }),
    ...overlays,
    textAt(
      12,
      15,
      "THE LEAD THROUGH THE DAY",
      { ...hud(8.5, 600, G.dim), letterSpacing: 0.4 },
      "start",
      W,
    ),
  );
};

// ---------------------------------------------------------------- the Weekly Cup's standings
// A row per Entrant with their place, points and wins, and each Cup Map's place: live, the place
// alone (times stay secret until the Cup ends), in the results with the time beside it.

export const CUP_STANDINGS_WIDTH = 720;

export interface CupStandingsImage {
  readonly title: string;
  readonly subtitle: string;
  /** The Cup Maps' names, in order. */
  readonly maps: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<{
    readonly place: number;
    readonly name: string;
    readonly total: number;
    readonly wins: number;
    /**
     * Each Cup Map's place, with its time once the Cup is over (null while live: times stay
     * secret until the end), or null for no time.
     */
    readonly cells: ReadonlyArray<{ readonly time: string | null; readonly rank: number } | null>;
  }>;
}

export const cupStandingsScene = ({ title, subtitle, maps, rows }: CupStandingsImage): El => {
  const COL = { place: 26, name: 140, total: 80, map: 120 } as const;
  const headCell = (text: string, width: number, align = "flex-start") =>
    box(
      { width, flexShrink: 0, overflow: "hidden", justifyContent: align },
      label(text, { fontSize: 10, letterSpacing: 0.8 }),
    );
  const rankBadge = (rank: number) =>
    box(
      {
        fontFamily: F.hud,
        fontWeight: 700,
        fontSize: 10,
        padding: "0 5px",
        borderRadius: 4,
        color: rank <= 3 ? C.bg : C.dim,
        backgroundColor: rank <= 3 ? placeColour(rank) : C.line2,
      },
      String(rank),
    );
  return backdrop(
    { padding: 24, gap: 14, width: CUP_STANDINGS_WIDTH },
    box(
      { justifyContent: "space-between", alignItems: "flex-end" },
      box(
        { flexDirection: "column", gap: 2 },
        box({ fontFamily: F.marquee, fontSize: 26 }, title),
        box({ color: C.dim, fontSize: 13 }, subtitle),
      ),
      logo(),
    ),
    box(
      { flexDirection: "column", gap: 4 },
      box(
        { padding: "0 10px", gap: 8 },
        headCell("#", COL.place),
        headCell("Player", COL.name),
        headCell("Points", COL.total, "flex-end"),
        ...maps.map((m) => headCell(m.length > 13 ? `${m.slice(0, 12)}…` : m, COL.map, "flex-end")),
      ),
      ...rows.map((r, i) =>
        box(
          {
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            borderRadius: 6,
            fontSize: 15,
            backgroundColor: i === 0 ? C.upTint : C.surface,
          },
          box(
            {
              width: COL.place,
              fontFamily: F.hud,
              fontWeight: 700,
              color: r.place <= 3 ? placeColour(r.place) : C.faint,
            },
            String(r.place),
          ),
          box(
            { width: COL.name, flexDirection: "column" },
            box({ fontWeight: 600 }, r.name.length > 16 ? `${r.name.slice(0, 15)}…` : r.name),
            r.wins > 0
              ? box({ fontSize: 11, color: C.gold }, `${r.wins} ${r.wins === 1 ? "win" : "wins"}`)
              : null,
          ),
          box(
            { width: COL.total, justifyContent: "flex-end", fontFamily: F.hud, fontWeight: 700 },
            r.total.toLocaleString("en-US"),
          ),
          ...r.cells.map((c) =>
            box(
              { width: COL.map, justifyContent: "flex-end", alignItems: "center", gap: 6 },
              c === null
                ? box({ color: C.faint }, "—")
                : c.time === null
                  ? box(
                      {
                        fontFamily: F.hud,
                        fontWeight: 700,
                        fontSize: 16,
                        color: c.rank <= 3 ? placeColour(c.rank) : C.text,
                      },
                      `#${c.rank}`,
                    )
                  : box(
                      { alignItems: "center", gap: 6 },
                      box({ fontFamily: F.hud, fontWeight: 600, color: C.text }, c.time),
                      rankBadge(c.rank),
                    ),
            ),
          ),
        ),
      ),
    ),
  );
};
