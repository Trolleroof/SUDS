import { NextResponse } from "next/server";

import { findCameras, isRunning, serialPorts, start, status, stop, type DaemonConfig } from "@/lib/daemon";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Start and stop `scripts/record_server.py` from the dashboard.
 *
 * This spawns a process on the machine serving the page, so it is bound to
 * localhost by the same assumption as the rest of the app: the dashboard, the
 * daemon and the arms are all on the operator's desk. `lib/daemon` validates
 * every argument and never goes through a shell.
 */
type Params = { params: Promise<{ action: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { action } = await params;

  if (action === "status") return NextResponse.json(status());

  if (action === "scan") {
    // Enumerating cameras means opening them; the recorder already has them.
    const cameras = isRunning() ? [] : await findCameras();
    return NextResponse.json({
      ports: serialPorts(),
      cameras,
      scanned_cameras: !isRunning(),
    });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 404 });
}

export async function POST(request: Request, { params }: Params) {
  const { action } = await params;

  if (action === "stop") {
    const result = await stop();
    return NextResponse.json({ ...result, ...status() }, { status: result.ok ? 200 : 409 });
  }

  if (action === "start") {
    let config: DaemonConfig;
    try {
      config = (await request.json()) as DaemonConfig;
    } catch {
      return NextResponse.json({ ok: false, error: "invalid config" }, { status: 400 });
    }
    const result = start(config);
    return NextResponse.json({ ...result, ...status() }, { status: result.ok ? 200 : 409 });
  }

  if (action === "restart") {
    const previous = status().config;
    if (!previous) return NextResponse.json({ ok: false, error: "nothing to restart" }, { status: 409 });
    if (isRunning()) await stop();
    const result = start(previous);
    return NextResponse.json({ ...result, ...status() }, { status: result.ok ? 200 : 409 });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 404 });
}
