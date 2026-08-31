import { NextResponse } from "next/server";

import {
  findCameras,
  isRunning,
  previewCamera,
  serialPorts,
  start,
  status,
  stop,
  type DaemonConfig,
} from "@/lib/daemon";
import { claimArmPorts, releaseArmPorts } from "@/lib/health";

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
    // Enumerating cameras means opening them; avoid on macOS or when recorder is already running
    const isMac = process.platform === "darwin";
    const cameras = isMac || isRunning() ? [] : await findCameras();
    return NextResponse.json({
      ports: serialPorts(),
      cameras,
      scanned_cameras: !isMac && !isRunning(),
    });
  }

  if (action === "preview") {
    const index = Number(new URL(_request.url).searchParams.get("index"));
    if (isRunning()) {
      // The daemon owns the cameras; its own stream is the live one to use.
      return NextResponse.json({ error: "stop the recorder to preview by index" }, { status: 409 });
    }
    const jpeg = await previewCamera(index);
    if (!jpeg) return NextResponse.json({ error: `no frame from index ${index}` }, { status: 404 });
    return new Response(new Uint8Array(jpeg), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
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
    // The health daemon polls both arm ports every two seconds; it has to be
    // gone before the recorder opens them, or the two collide and one dies.
    await claimArmPorts();
    try {
      const result = start(config);
      return NextResponse.json({ ...result, ...status() }, { status: result.ok ? 200 : 409 });
    } finally {
      releaseArmPorts();
    }
  }

  if (action === "restart") {
    const previous = status().config;
    if (!previous) return NextResponse.json({ ok: false, error: "nothing to restart" }, { status: 409 });
    if (isRunning()) await stop();
    await claimArmPorts();
    try {
      const result = start(previous);
      return NextResponse.json({ ...result, ...status() }, { status: result.ok ? 200 : 409 });
    } finally {
      releaseArmPorts();
    }
  }

  return NextResponse.json({ error: "unknown action" }, { status: 404 });
}
