import { NextResponse } from "next/server";

import { CAMERA_PORT } from "@/lib/procs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Pass through the MJPEG stream from scripts/camera_server.py. */
export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const url = `http://127.0.0.1:${CAMERA_PORT}/stream?camera=${encodeURIComponent(name)}`;
  try {
    const res = await fetch(url, { cache: "no-store", signal: request.signal });
    if (!res.ok || !res.body) {
      return NextResponse.json({ error: `camera ${name} is not streaming` }, { status: res.status || 502 });
    }
    // Piped, never awaited: an MJPEG response never ends.
    return new Response(res.body, {
      status: 200,
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "image/jpeg",
        "Cache-Control": "no-store, no-cache, private",
      },
    });
  } catch {
    return NextResponse.json({ error: "camera server is not running" }, { status: 503 });
  }
}
