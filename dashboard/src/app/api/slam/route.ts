import fs from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { resolveDataset } from "@/lib/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const repoId = url.searchParams.get("repo_id");
  const episode = Number(url.searchParams.get("episode_index"));
  if (!repoId || !Number.isInteger(episode) || episode < 0) {
    return NextResponse.json({ error: "repo_id and a non-negative episode_index are required" }, { status: 400 });
  }

  const file = path.join(resolveDataset(repoId), "meta", "slam", `episode-${String(episode).padStart(6, "0")}.csv`);
  try {
    const rows = (await fs.readFile(file, "utf8")).trim().split(/\r?\n/);
    const columns = rows.shift()?.split(",") ?? [];
    const indexes = Object.fromEntries(columns.map((name, index) => [name, index]));
    for (const name of ["x", "y", "z", "tracked"]) {
      if (indexes[name] == null) throw new Error(`SLAM sidecar is missing ${name}`);
    }
    const all = rows.map((row) => row.split(","));
    const tracked = all
      .filter((row) => row[indexes.tracked] !== "0")
      .map((row) => ({ x: Number(row[indexes.x]), y: Number(row[indexes.y]), z: Number(row[indexes.z]) }))
      .filter((point) => Object.values(point).every(Number.isFinite));
    const stride = Math.max(1, Math.ceil(tracked.length / 600));
    return NextResponse.json({
      points: tracked.filter((_, index) => index % stride === 0),
      frames: all.length,
      tracked_frames: tracked.length,
      lost_frames: all.length - tracked.length,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "no SLAM sidecar" }, { status: 404 });
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 422 });
  }
}
