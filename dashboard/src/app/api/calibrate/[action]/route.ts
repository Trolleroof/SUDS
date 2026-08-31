import { NextResponse } from "next/server";

import {
  advance,
  cancel,
  readCalibration,
  start,
  status,
  type CalibrateRole,
} from "@/lib/calibrate";
import { claimArmPorts, releaseArmPorts } from "@/lib/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ action: string }> };

type Body = {
  role?: string;
  ports?: { leader?: string | null; follower?: string | null };
  ids?: { leader?: string; follower?: string };
};

function role(value: unknown): CalibrateRole | null {
  return value === "leader" || value === "follower" ? value : null;
}

/**
 * `GET /api/calibrate/status` returns both halves of the picture: the run in
 * progress, and what is already saved on disk for each arm. The saved side is
 * the one you read *before* pressing anything -- a follower with a narrow range
 * on disk is a follower that will fling itself when teleop starts.
 */
export async function GET(request: Request, { params }: Params) {
  if ((await params).action !== "status") {
    return NextResponse.json({ error: "unknown action" }, { status: 404 });
  }
  const query = new URL(request.url).searchParams;
  const leaderId = query.get("leaderId") || "leader";
  const followerId = query.get("followerId") || "follower";

  return NextResponse.json({
    ...status(),
    saved: {
      leader: readCalibration("leader", leaderId),
      follower: readCalibration("follower", followerId),
    },
  });
}

export async function POST(request: Request, { params }: Params) {
  const action = (await params).action;
  const body = (await request.json().catch(() => ({}))) as Body;

  if (action === "start") {
    const which = role(body.role);
    if (!which) return NextResponse.json({ ok: false, error: "pick leader or follower" }, { status: 400 });
    // `lerobot-calibrate` owns the arm port for the whole session; the health
    // daemon reopens it every two seconds. Stop it before the CLI is spawned —
    // once the session is up, `portsBlocked` keeps it from coming back.
    await claimArmPorts();
    try {
      const result = start(
        which,
        { leader: body.ports?.leader ?? null, follower: body.ports?.follower ?? null },
        { leader: body.ids?.leader ?? "leader", follower: body.ids?.follower ?? "follower" },
      );
      return NextResponse.json({ ...result, ...status() }, { status: result.ok ? 200 : 409 });
    } finally {
      releaseArmPorts();
    }
  }

  // One button per prompt, but only one prompt is ever open, so the CLI is told
  // "continue" and works out which of its two reads that answers.
  if (action === "advance") {
    const result = advance();
    return NextResponse.json({ ...result, ...status() }, { status: result.ok ? 200 : 409 });
  }

  if (action === "cancel") {
    const result = await cancel();
    return NextResponse.json({ ...result, ...status() }, { status: result.ok ? 200 : 409 });
  }

  return NextResponse.json({ ok: false, error: "unknown action" }, { status: 404 });
}
