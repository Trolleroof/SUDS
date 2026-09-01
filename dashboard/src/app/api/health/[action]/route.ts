import { NextResponse } from "next/server";

import {
  ensureHealth,
  HEALTH_PORT,
  healthStatus,
  portsBlocked,
  waitForHealthPayload,
  type HealthCamera,
} from "@/lib/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Override when health_server is started outside the dashboard. */
const HEALTH = process.env.SUDS_HEALTH_URL ?? `http://127.0.0.1:${HEALTH_PORT}`;

const ACTIONS = new Set(["status", "sync"]);

type Params = { params: Promise<{ action: string }> };

export async function GET(_request: Request, { params }: Params) {
  return proxy((await params).action, "GET");
}

export async function POST(request: Request, { params }: Params) {
  const action = (await params).action;
  if (action !== "sync") {
    return NextResponse.json({ error: "unknown action" }, { status: 404 });
  }

  let cameras: HealthCamera[] = [];
  try {
    const body = (await request.json()) as { cameras?: HealthCamera[] };
    cameras = body.cameras ?? [];
  } catch {
    /* no body */
  }

  const ensured = await ensureHealth(cameras);
  if (ensured.skipped) {
    return NextResponse.json({ ok: true, skipped: true, ...healthStatus() });
  }
  if (!ensured.ok) {
    return NextResponse.json({ ok: false, error: ensured.error, ...healthStatus() }, { status: 409 });
  }
  await waitForHealthPayload(ensured.restarted ? 45_000 : 15_000);
  return NextResponse.json({ ok: true, ...healthStatus() });
}

async function proxy(action: string, method: string) {
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: "unknown action" }, { status: 404 });
  }

  // Pull ports from config/arms.json, reconcile USB scan, and start health_server if needed.
  if (!process.env.SUDS_HEALTH_URL && action === "status" && !portsBlocked()) {
    const ensured = await ensureHealth();
    if (ensured.ok && ensured.restarted) await waitForHealthPayload();
  }

  try {
    const upstream = await fetch(`${HEALTH}/${action === "sync" ? "status" : action}`, {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const body = await upstream.json();
    if (upstream.ok && body.teleop) return NextResponse.json(body, { status: upstream.status });

    // Daemon is up but still on its first probe — wait once, then retry.
    if (upstream.ok && body.message === "starting") {
      await waitForHealthPayload(30_000);
      const retry = await fetch(`${HEALTH}/status`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (retry.ok) return NextResponse.json(await retry.json(), { status: retry.status });
    }

    return NextResponse.json(body, { status: upstream.status });
  } catch {
    const meta = healthStatus();
    return NextResponse.json(
      {
        ok: false,
        offline: true,
        error: meta.running ? "health daemon did not answer in time" : `no health daemon at ${HEALTH}`,
        ...meta,
      },
      { status: 200 },
    );
  }
}
