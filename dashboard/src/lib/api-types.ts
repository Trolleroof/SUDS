/** Shapes returned by /api/*, shared with the client. No node imports here. */

export type Verdict = "pass" | "fail" | "discard";

export type Label = {
  episode_index: number;
  verdict: Verdict;
  failure_mode?: string | null;
  notes?: string | null;
  labeled_at: string;
};

export type Quality = {
  episode_index: number;
  mean_jerk: number;
  max_jerk: number;
  dropped_frames: number;
  state_range: [number, number][];
};

export type EpisodeRow = {
  episode_index: number;
  length: number;
  duration_s: number;
  task: string | null;
  data_file: string;
  videos: Record<string, { file: string; from: number; to: number }>;
  label: Label | null;
  quality: Quality | null;
};

export type DatasetPayload = {
  repo_id: string;
  info: {
    fps: number;
    robot_type: string | null;
    codebase_version: string;
    total_episodes: number;
    total_frames: number;
  };
  video_keys: string[];
  state_names: string[];
  action_names: string[];
  episodes: EpisodeRow[];
};

export type TracePayload = {
  t: number[];
  state: number[][];
  action: number[][];
  stride: number;
  frames: number;
};

export const FAILURE_MODES = [
  "missed_grasp",
  "dropped",
  "wrong_object",
  "teleop_jerk",
  "occlusion",
  "out_of_frame",
  "collision",
  "timeout",
  "other",
] as const;
