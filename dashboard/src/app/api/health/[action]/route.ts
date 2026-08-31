import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Where scripts/health_server.py is listening. */
const HEALTH = process.env.SUDS_HEALTH_URL ?? "http://127.0.0.1:8612";

const ACTIONS = new Set(["status"]);

type Params = { params: Promise<{ action: string }> };

export async function GET(_request: Request, { params }: Params) {
  return proxy((await params).action, "GET");
}

async function proxy(action: string, method: string) {
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: "unknown action" }, { status: 404 });
  }
  try {
    const upstream = await fetch(`${HEALTH}/${action}`, { method, cache: "no-store" });
    return NextResponse.json(await upstream.json(), { status: upstream.status });
  } catch {
    return NextResponse.json({ offline: true, error: `no health daemon at ${HEALTH}` }, { status: 503 });
  }
}
