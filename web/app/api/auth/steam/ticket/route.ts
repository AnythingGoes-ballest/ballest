// POST /api/auth/steam/ticket: the game signs its player in with a Steam ticket (lib/auth.ts,
// ADR 0016), each address so many times an hour (db/game-sign-in.ts). Never cached.
import { connection } from "next/server";

import { gameSignInDeps } from "../../../../../db/data";
import { signInFromGame } from "../../../../../lib/auth";

export async function POST(request: Request) {
  await connection();
  return signInFromGame(request, gameSignInDeps());
}
