import { loadEpisodeFrames, toVector, type DatasetInfo, type Episode } from "./dataset";
import { num } from "./parquet";

export type EpisodeQuality = {
  episode_index: number;
  /** Mean per-step L-infinity change in commanded action. High = jerky teleop. */
  mean_jerk: number;
  max_jerk: number;
  /** Frames whose timestamp gap exceeds 1.5x the nominal period. */
  dropped_frames: number;
  /** Per-joint [min, max] of observation.state, for coverage checks. */
  state_range: [number, number][];
};

const cache = new Map<string, { key: string; value: EpisodeQuality[] }>();

/**
 * Scanning every episode's action column is the expensive part of the page, so
 * results are memoized against the episode count and total frames -- both change
 * the moment `lerobot-record` adds an episode, and neither requires a stat() of
 * every parquet file.
 */
export async function episodeQuality(
  repoId: string,
  info: DatasetInfo,
  episodes: Episode[],
): Promise<EpisodeQuality[]> {
  const key = `${episodes.length}:${info.total_frames}`;
  const hit = cache.get(repoId);
  if (hit && hit.key === key) return hit.value;

  const value: EpisodeQuality[] = [];
  for (const ep of episodes) {
    try {
      value.push(await computeOne(repoId, info, ep, episodes));
    } catch {
      value.push({
        episode_index: ep.episode_index,
        mean_jerk: NaN,
        max_jerk: NaN,
        dropped_frames: 0,
        state_range: [],
      });
    }
  }
  cache.set(repoId, { key, value });
  return value;
}

async function computeOne(
  repoId: string,
  info: DatasetInfo,
  ep: Episode,
  episodes: Episode[],
): Promise<EpisodeQuality> {
  const columns = ["timestamp", "action", "observation.state"].filter((c) => c in info.features || c === "timestamp");
  const rows = await loadEpisodeFrames(repoId, ep, episodes, columns);

  const period = info.fps ? 1 / info.fps : 0;
  let dropped = 0;
  let jerkSum = 0;
  let jerkMax = 0;
  let jerkCount = 0;
  const lo: number[] = [];
  const hi: number[] = [];

  let prevAction: number[] | null = null;
  let prevTs = NaN;

  for (const row of rows) {
    const ts = num(row["timestamp"]);
    if (period && Number.isFinite(prevTs) && ts - prevTs > period * 1.5) {
      dropped += Math.round((ts - prevTs) / period) - 1;
    }
    prevTs = ts;

    const action = toVector(row["action"]);
    if (prevAction && prevAction.length === action.length) {
      let step = 0;
      for (let i = 0; i < action.length; i++) {
        step = Math.max(step, Math.abs(action[i] - prevAction[i]));
      }
      jerkSum += step;
      jerkMax = Math.max(jerkMax, step);
      jerkCount++;
    }
    prevAction = action;

    const state = toVector(row["observation.state"]);
    for (let i = 0; i < state.length; i++) {
      lo[i] = lo[i] === undefined ? state[i] : Math.min(lo[i], state[i]);
      hi[i] = hi[i] === undefined ? state[i] : Math.max(hi[i], state[i]);
    }
  }

  return {
    episode_index: ep.episode_index,
    mean_jerk: jerkCount ? jerkSum / jerkCount : NaN,
    max_jerk: jerkCount ? jerkMax : NaN,
    dropped_frames: dropped,
    state_range: lo.map((v, i) => [v, hi[i]] as [number, number]),
  };
}
