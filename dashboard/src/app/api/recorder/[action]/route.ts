import { NextResponse } from "next/server";

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
]);

type Params = { params: Promise<{ action: string }> };

export async function GET(_request: Request, { params }: Params) {
  return proxy((await params).action, "GET");
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
    return NextResponse.json(await upstream.json(), { status: upstream.status });
  } catch {
    // Not an error worth shouting about -- the daemon is optional, and the rest
    // of the dashboard works fine without it.
    return NextResponse.json({ offline: true, error: `no recorder at ${RECORDER}` }, { status: 503 });
  }
}
