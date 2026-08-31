import { NextResponse } from "next/server";

import { claimArmPorts, releaseArmPorts } from "@/lib/health";
import { identify, serialPorts } from "@/lib/procs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The window itself is seconds long, plus LeRobot's import time.
export const maxDuration = 120;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { ports?: string[]; seconds?: number };
  const ports = body.ports?.length ? body.ports : serialPorts();
  // identify_arms.py opens every candidate port for the length of the window;
  // the health daemon reopens the same ones every two seconds. One has to go.
  await claimArmPorts();
  let result;
  try {
    result = await identify(ports, Math.min(15, Math.max(3, body.seconds ?? 6)));
  } finally {
    releaseArmPorts();
  }

  if (typeof result === "string") return NextResponse.json({ ok: false, error: result }, { status: 409 });
  return NextResponse.json({ ok: true, ...result });
}
