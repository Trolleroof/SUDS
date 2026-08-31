import { NextResponse } from "next/server";

import { readCamerasConfig, readCamerasConfigFile } from "@/lib/cameras-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const file = readCamerasConfigFile();
  const cameras = readCamerasConfig();
  return NextResponse.json({
    cameras,
    source: file ? "config/cameras.json" : "defaults",
  });
}
