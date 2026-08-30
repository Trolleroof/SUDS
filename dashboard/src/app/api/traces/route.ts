import { NextResponse } from "next/server";

import { loadEpisodeFrames, loadEpisodes, loadInfo, toVector } from "@/lib/dataset";
import { num } from "@/lib/parquet";

export const dynamic = "force-dynamic";

/** Plot width in CSS pixels; sending more points than that is wasted bytes. */
const MAX_POINTS = 600;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const repoId = params.get("repo_id");
  const index = Number(params.get("episode"));
  if (!repoId || !Number.isFinite(index)) {
    return NextResponse.json({ error: "repo_id and episode are required" }, { status: 400 });
  }

  try {
    const info = await loadInfo(repoId);
    const episodes = await loadEpisodes(repoId, info);
    const episode = episodes.find((e) => e.episode_index === index);
    if (!episode) return NextResponse.json({ error: "no such episode" }, { status: 404 });

    const rows = await loadEpisodeFrames(repoId, episode, episodes, [
      "timestamp",
      "observation.state",
      "action",
    ]);

    const stride = Math.max(1, Math.ceil(rows.length / MAX_POINTS));
    const t: number[] = [];
    const state: number[][] = [];
    const action: number[][] = [];

    for (let i = 0; i < rows.length; i += stride) {
      t.push(num(rows[i]["timestamp"]));
      pushColumns(state, toVector(rows[i]["observation.state"]));
      pushColumns(action, toVector(rows[i]["action"]));
    }

    return NextResponse.json({ t, state, action, stride, frames: rows.length });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

/** Transpose row-of-joints into per-joint series as we go. */
function pushColumns(series: number[][], vector: number[]): void {
  for (let j = 0; j < vector.length; j++) {
    (series[j] ??= []).push(vector[j]);
  }
}
