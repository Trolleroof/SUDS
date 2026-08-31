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

export type HardwareStatus = "ok" | "warn" | "fail" | "offline";

export type ArmPower = {
  role: string;
  status: HardwareStatus;
  port: string | null;
  usb: boolean;
  powered: boolean;
  motors_ok: number;
  motors_total: number;
  message?: string;
};

export type CameraPower = {
  name: string;
  status: HardwareStatus;
  index: number | null;
  usb: boolean;
  streaming: boolean;
  message?: string;
};

export type HardwarePayload = {
  source: "health" | "recorder";
  mock?: boolean;
  status: HardwareStatus;
  teleop: ArmPower;
  follower: ArmPower;
  cameras: Record<string, CameraPower>;
  ports_seen?: string[];
  updated_at?: string;
  offline?: boolean;
  error?: string;
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

/* ---- recorder daemon (scripts/record_server.py) ---------------------- */

export type RecorderState = "idle" | "recording" | "pending" | "saving" | "calibrating" | "estopped";

/** One joint's leader-vs-follower disagreement, in normalised units. */
export type JointDelta = { leader: number; follower: number; delta: number };

export type DeltaPayload = {
  joints: Record<string, JointDelta>;
  max: number;
  max_joint: string | null;
  limit: number;
  over: boolean;
  over_ticks: number;
};

export type EstopPayload = {
  engaged: boolean;
  reason: string;
  since_s: number;
  /** Whether the daemon was started with --auto-estop. */
  auto: boolean;
};

export type CalibrationPhase = "home" | "range";

export type CalibrationPayload = {
  arm: "teleop" | "follower";
  phase: CalibrationPhase;
  /** Raw encoder counts, so the operator can see each joint actually move. */
  joints: Record<string, { pos: number; min: number; max: number; swept: boolean }>;
  unswept: string[];
  can_finish: boolean;
};

export type RecorderStatus = {
  state: RecorderState;
  repo_id: string;
  fps: number;
  task: string;
  frames: number;
  elapsed_s: number;
  commit_in_s: number;
  commit_seconds: number;
  saved_episodes: number;
  message: string;
  cameras: string[];
  hardware?: HardwarePayload;
  estop: EstopPayload;
  delta: DeltaPayload;
  calibration: CalibrationPayload | null;
  offline?: boolean;
  error?: string;
};

export type RecorderAction =
  | "record"
  | "stop"
  | "discard"
  | "save"
  | "task"
  | "estop"
  | "rearm"
  | "calibrate_start"
  | "calibrate_home"
  | "calibrate_finish"
  | "calibrate_cancel";
