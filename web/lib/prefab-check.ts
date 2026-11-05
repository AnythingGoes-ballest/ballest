// The upload check, run in the browser for instant feedback and again on the server: the
// same rules the game's spawnprefab applies (read from its error messages). A BallestPrefab
// version 1 file of 2 to 4096 pieces, each a real level-editor piece and never the start
// piece, at most 4 MB.

import { PIECES as EDITOR_PIECES } from "./prefab-pieces";

export const MAX_BYTES = 4 * 1024 * 1024;

/* every piece the editor offers, by the class name it saves, drawn in the viewer or not */
const PIECES = new Set(EDITOR_PIECES);

export type Check = { ok: true; pieces: number } | { ok: false; problems: Array<string> };

export function checkPrefab(text: string): Check {
  if (new TextEncoder().encode(text).length > MAX_BYTES)
    return { ok: false, problems: ["The file is over 4 MB."] };
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["This isn't a JSON file."] };
  }
  const f = file as { format?: unknown; version?: unknown; group?: unknown; items?: unknown };
  const problems: Array<string> = [];
  if (f.format !== "BallestPrefab")
    problems.push('It isn\'t a prefab: "format" should be "BallestPrefab".');
  else if (f.version !== 1)
    problems.push("It's a prefab version this site doesn't know yet (only version 1).");
  if (typeof f.group !== "object" || f.group === null)
    problems.push("Its group transform is missing.");
  const items = Array.isArray(f.items) ? (f.items as Array<unknown>) : null;
  if (!items) problems.push("It has no pieces.");
  else {
    if (items.length < 2) problems.push("A prefab needs at least 2 pieces.");
    if (items.length > 4096)
      problems.push(`It has ${items.length} pieces; the game takes at most 4096.`);
    const unknown = new Set<string>();
    let start = false;
    let misshapen = 0;
    for (const item of items) {
      if (!laidOut(item)) misshapen++;
      if (typeof item !== "object" || item === null) continue;
      const it = item as { class?: unknown };
      const name =
        typeof it.class === "string"
          ? (it.class.split(/[./]/).at(-1) ?? "").replace(/_C$/, "")
          : "";
      if (name === "MP_PlayerStart") start = true;
      else if (!PIECES.has(name)) unknown.add(name || "(no class)");
    }
    if (misshapen)
      problems.push(
        `${misshapen === 1 ? "1 piece isn't" : `${String(misshapen)} pieces aren't`} laid out as the editor saves them (a position, rotation, scale and meshes each).`,
      );
    if (start) problems.push("It contains the start pad, which the game won't spawn in a prefab.");
    if (unknown.size)
      problems.push(
        `Pieces the editor doesn't have: ${[...unknown].slice(0, 3).join(", ")}${unknown.size > 3 ? "…" : ""}.`,
      );
  }
  return problems.length ? { ok: false, problems } : { ok: true, pieces: items?.length ?? 0 };
}

const vec3 = (v: unknown) =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/* whether an item has what the viewer places it by, as the editor saves every piece */
function laidOut(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const { transform: t, meshes } = item as { transform?: unknown; meshes?: unknown };
  if (typeof t !== "object" || t === null || !Array.isArray(meshes)) return false;
  const mesh = (m: unknown) =>
    typeof m === "object" &&
    m !== null &&
    typeof (m as { mesh?: unknown }).mesh === "string" &&
    Array.isArray((m as { materials?: unknown }).materials) &&
    (m as { materials: Array<unknown> }).materials.every((x) => typeof x === "string");
  if (!meshes.every(mesh)) return false;
  const { location, rotation, scale } = t as Record<string, unknown>;
  return vec3(location) && vec3(rotation) && vec3(scale);
}

/* the name the game spawns it by: letters, digits, _ and -, 1 to 64 */
export function fileNameOf(name: string) {
  const stem = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return (stem || "prefab") + ".json";
}
