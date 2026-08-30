import { NextResponse } from "next/server";

import { appendLabel, VERDICTS, type Label, type Verdict } from "@/lib/labels";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json()) as Partial<Label> & { repo_id?: string };
  const { repo_id: repoId, episode_index: index, verdict } = body;

  if (!repoId || typeof index !== "number") {
    return NextResponse.json({ error: "repo_id and episode_index are required" }, { status: 400 });
  }
  if (!VERDICTS.includes(verdict as Verdict)) {
    return NextResponse.json({ error: `verdict must be one of ${VERDICTS.join(", ")}` }, { status: 400 });
  }

  const label: Label = {
    episode_index: index,
    verdict: verdict as Verdict,
    failure_mode: body.failure_mode ?? null,
    notes: body.notes ?? null,
    labeled_at: new Date().toISOString(),
  };
  await appendLabel(repoId, label);
  return NextResponse.json(label);
}
