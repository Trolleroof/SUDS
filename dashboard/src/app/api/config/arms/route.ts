import { NextResponse } from "next/server";

import { readArmsConfig, readArmsConfigFile } from "@/lib/arms-config";

export const dynamic = "force-dynamic";

export async function GET() {
  const file = readArmsConfigFile();
  const ports = readArmsConfig();
  return NextResponse.json({
    ...ports,
    source: file ? "config/arms.json" : "defaults",
  });
}
