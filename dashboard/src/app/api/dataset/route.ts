import { NextResponse } from "next/server";

import { jointNames, loadEpisodes, loadInfo, videoKeys } from "@/lib/dataset";
import { readLabels } from "@/lib/labels";
import { episodeQuality } from "@/lib/quality";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const repoId = new URL(request.url).searchParams.get("repo_id");
  if (!repoId) return NextResponse.json({ error: "repo_id is required" }, { status: 400 });

  try {
    const info = await loadInfo(repoId);
    const episodes = await loadEpisodes(repoId, info);
    const [labels, quality] = await Promise.all([
      readLabels(repoId),
      episodeQuality(repoId, info, episodes),
    ]);
    const qualityByIndex = new Map(quality.map((q) => [q.episode_index, q]));

    return NextResponse.json({
      repo_id: repoId,
      info: {
        fps: info.fps,
        robot_type: info.robot_type ?? null,
        codebase_version: info.codebase_version,
        total_episodes: info.total_episodes,
        total_frames: info.total_frames,
      },
      video_keys: videoKeys(info),
      state_names: jointNames(info, "observation.state"),
      action_names: jointNames(info, "action"),
      episodes: episodes.map((ep) => ({
        ...ep,
        label: labels.get(ep.episode_index) ?? null,
        quality: qualityByIndex.get(ep.episode_index) ?? null,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 404 });
  }
}
