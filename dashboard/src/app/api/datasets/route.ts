import { NextResponse } from "next/server";

import { listDatasets } from "@/lib/dataset";
import { datasetRoot } from "@/lib/paths";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ root: datasetRoot(), datasets: await listDatasets() });
}
