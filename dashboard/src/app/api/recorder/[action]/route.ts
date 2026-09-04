import { NextResponse } from "next/server";

import { markRecorderActive } from "@/lib/health";

export const dynamic = "force-dynamic";

/** Where scripts/record_server.py is listening. */
const RECORDER = process.env.SUDS_RECORDER_URL ?? "http://127.0.0.1:8611";

const ACTIONS = new Set([
  "status",
  "record",
  "stop",
  "discard",
  "save",
  "task",
  "estop",
  "rearm",
  "calibrate_start",
  "calibrate_home",
  "calibrate_finish",
  "calibrate_cancel",
  "engage",
  "disengage",
]);

type Params = { params: Promise<{ action: string }> };

export async function GET(request: Request, { params }: Params) {
  const action = (await params).action;

  // The browser opens the daemon's websocket directly -- Next's app router
  // cannot proxy an upgrade -- so it has to be told where that is, since
  // SUDS_RECORDER_URL is only visible on the server.
  if (action === "wsurl") {
    const hostHeader = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    const clientHost = hostHeader ? hostHeader.split(":")[0] : "127.0.0.1";
    let wsUrl: string;
    try {
      const u = new URL(RECORDER);
      const port = u.port || "8611";
      if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
        wsUrl = `ws://${clientHost}:${port}/ws`;
      } else {
        wsUrl = `${RECORDER.replace(/^http/, "ws")}/ws`;
      }
    } catch {
      wsUrl = `${RECORDER.replace(/^http/, "ws")}/ws`;
    }
    return NextResponse.json({ url: wsUrl });
  }
  return proxy(action, "GET");
}

export async function POST(request: Request, { params }: Params) {
  const body = await request.text();
  return proxy((await params).action, "POST", body);
}

async function proxy(action: string, method: string, body?: string) {
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: "unknown action" }, { status: 404 });
  }
  try {
    const upstream = await fetch(`${RECORDER}/${action}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "POST" ? body || "{}" : undefined,
      cache: "no-store",
    });
    if (upstream.ok || upstream.status < 500) {
      markRecorderActive();
    }
    return NextResponse.json(await upstream.json(), { status: upstream.status });
  } catch {
    // The daemon is optional, and the rest of the dashboard works fine without it.
    return NextResponse.json({ ok: false, offline: true, error: `no recorder at ${RECORDER}` }, { status: 200 });
  }
}
