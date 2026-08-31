import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Where scripts/record_server.py is listening. */
const RECORDER = process.env.SUDS_RECORDER_URL ?? "http://127.0.0.1:8611";

/**
 * Pass an MJPEG stream (or one JPEG, with `?mode=snapshot`) through from the
 * recorder daemon.
 *
 * The body is piped, never buffered: an MJPEG response never ends, so awaiting
 * it would hang the request forever. Pointing the <img> straight at port 8611
 * would work too, but only until someone opens the dashboard from another
 * machine — proxying keeps the daemon on localhost.
 */
export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const snapshot = new URL(request.url).searchParams.get("mode") === "snapshot";
  const upstream = `${RECORDER}/${snapshot ? "snapshot" : "stream"}?camera=${encodeURIComponent(name)}`;

  try {
    const res = await fetch(upstream, { cache: "no-store", signal: request.signal });
    if (!res.ok || !res.body) {
      return NextResponse.json({ error: `camera ${name} is not streaming` }, { status: res.status || 502 });
    }
    return new Response(res.body, {
      status: 200,
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "image/jpeg",
        "Cache-Control": "no-store, no-cache, private",
      },
    });
  } catch {
    return NextResponse.json({ error: `no recorder at ${RECORDER}` }, { status: 503 });
  }
}
