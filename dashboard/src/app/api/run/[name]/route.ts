import { NextResponse } from "next/server";

import { claimArmPorts, releaseArmPorts } from "@/lib/health";
import { CAMERA_PORT, start, status, stop, type ProcConfig, type ProcName } from "@/lib/procs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NAMES = new Set<ProcName>(["teleop", "cameras"]);

type Params = { params: Promise<{ name: string }> };

function parse(name: string): ProcName | null {
  return NAMES.has(name as ProcName) ? (name as ProcName) : null;
}

export async function GET(_request: Request, { params }: Params) {
  const name = parse((await params).name);
  if (!name) return NextResponse.json({ error: "unknown command" }, { status: 404 });

  const base = status(name);
  if (name !== "cameras" || !base.running) return NextResponse.json(base);

  // Running is not the same as working: a USB camera can stall while the
  // process is perfectly healthy, and the panel has to say which one did.
  try {
    const res = await fetch(`http://127.0.0.1:${CAMERA_PORT}/status`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return NextResponse.json({ ...base, ...(await res.json()) });
  } catch {
    /* just started, or shutting down */
  }
  return NextResponse.json(base);
}

export async function POST(request: Request, { params }: Params) {
  const name = parse((await params).name);
  if (!name) return NextResponse.json({ error: "unknown command" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { action?: string; config?: ProcConfig };
  if (body.action === "stop") {
    const result = await stop(name);
    return NextResponse.json({ ...result, ...status(name) }, { status: result.ok ? 200 : 409 });
  }

  // The health daemon polls both arm ports every two seconds; it has to be gone
  // before teleop opens them, or the two collide and one of them dies. The
  // camera server touches no serial device, so it does not need the ports.
  if (name !== "teleop") {
    const result = start(name, body.config as ProcConfig);
    return NextResponse.json({ ...result, ...status(name) }, { status: result.ok ? 200 : 409 });
  }

  await claimArmPorts();
  try {
    const result = start(name, body.config as ProcConfig);
    return NextResponse.json({ ...result, ...status(name) }, { status: result.ok ? 200 : 409 });
  } finally {
    releaseArmPorts();
  }
}
