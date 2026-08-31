import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Supervises `scripts/record_server.py` so the dashboard can start and stop it
 * from buttons instead of a terminal.
 *
 * The daemon is a long-lived child of the Next server, which means it has to
 * survive dev-mode hot reloads -- module state does not, so the handle lives on
 * `globalThis`. Arguments are passed as an argv array and never through a shell,
 * and every field is validated below, because these values arrive over HTTP.
 */

export type CameraSpec = { name: string; index: number };

export type DaemonConfig = {
  repoId: string;
  task: string;
  fps: number;
  mock: boolean;
  robotPort: string | null;
  teleopPort: string | null;
  cameras: CameraSpec[];
  deltaLimit: number;
  autoEstop: boolean;
  commitSeconds: number;
};

type Daemon = {
  child: ChildProcess | null;
  config: DaemonConfig | null;
  startedAt: number;
  log: string[];
  exit: { code: number | null; signal: string | null; at: number } | null;
};

const store = globalThis as unknown as { __sudsDaemon?: Daemon };
const daemon: Daemon = (store.__sudsDaemon ??= {
  child: null,
  config: null,
  startedAt: 0,
  log: [],
  exit: null,
});

/** Last N lines of the daemon's own output, so failures are visible in the UI. */
const LOG_LINES = 200;

export function repoRoot(): string {
  return process.env.SUDS_ROOT ?? path.resolve(process.cwd(), "..");
}

function python(): string {
  if (process.env.SUDS_PYTHON) return process.env.SUDS_PYTHON;
  const venv = path.join(repoRoot(), ".venv", "bin", "python");
  return fs.existsSync(venv) ? venv : "python3";
}

const REPO_ID = /^[\w.-]+\/[\w.-]+$/;
const CAMERA_NAME = /^[a-z][a-z0-9_]*$/i;

/** Rejects anything that would turn a config field into an arbitrary argument. */
export function validate(config: DaemonConfig): string | null {
  if (!REPO_ID.test(config.repoId)) return "repo id must look like namespace/name";
  if (!Number.isInteger(config.fps) || config.fps < 1 || config.fps > 120) return "fps must be 1–120";
  if (!(config.deltaLimit > 0) || config.deltaLimit > 200) return "delta limit must be 0–200";
  if (!(config.commitSeconds >= 0) || config.commitSeconds > 120) return "commit seconds must be 0–120";
  if (config.task.length > 200) return "task is too long";
  if (/[\n\r]/.test(config.task)) return "task cannot contain newlines";

  for (const camera of config.cameras) {
    if (!CAMERA_NAME.test(camera.name)) return `camera name "${camera.name}" must be letters, digits and _`;
    if (!Number.isInteger(camera.index) || camera.index < 0 || camera.index > 64) {
      return `camera ${camera.name} needs an index 0–64`;
    }
  }
  const names = config.cameras.map((c) => c.name);
  if (new Set(names).size !== names.length) return "camera names must be unique";

  if (!config.mock) {
    for (const [label, port] of [
      ["follower", config.robotPort],
      ["leader", config.teleopPort],
    ] as const) {
      if (!port) return `${label} port is required unless mock is on`;
      // Serial devices only, and only ones that actually exist: the whole point
      // is that a typo fails here rather than as a confusing daemon crash.
      if (!/^\/dev\/tty\.[\w.-]+$/.test(port)) return `${label} port must be a /dev/tty.* device`;
      if (!fs.existsSync(port)) return `${label} port ${port} is not plugged in`;
    }
  }
  return null;
}

export function buildArgs(config: DaemonConfig): string[] {
  const args = [
    path.join(repoRoot(), "scripts", "record_server.py"),
    "--repo-id",
    config.repoId,
    "--task",
    config.task,
    "--fps",
    String(config.fps),
    "--commit-seconds",
    String(config.commitSeconds),
    "--delta-limit",
    String(config.deltaLimit),
  ];
  if (config.autoEstop) args.push("--auto-estop");
  if (config.mock) {
    args.push("--mock");
  } else {
    args.push("--robot-port", config.robotPort!, "--teleop-port", config.teleopPort!);
  }
  for (const camera of config.cameras) args.push("--camera", `${camera.name}=${camera.index}`);
  return args;
}

export function isRunning(): boolean {
  return daemon.child !== null && daemon.child.exitCode === null && !daemon.child.killed;
}

export function status() {
  return {
    running: isRunning(),
    pid: isRunning() ? daemon.child!.pid : null,
    uptime_s: isRunning() ? (Date.now() - daemon.startedAt) / 1000 : 0,
    config: daemon.config,
    log: daemon.log.slice(-60),
    exit: daemon.exit,
  };
}

export function start(config: DaemonConfig): { ok: boolean; error?: string } {
  if (isRunning()) return { ok: false, error: "the recorder is already running" };

  const invalid = validate(config);
  if (invalid) return { ok: false, error: invalid };

  const args = buildArgs(config);
  const child = spawn(python(), args, {
    cwd: repoRoot(),
    // Unbuffered, or the log panel stays empty until the process dies.
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  daemon.child = child;
  daemon.config = config;
  daemon.startedAt = Date.now();
  daemon.exit = null;
  daemon.log = [`$ ${python()} ${args.join(" ")}`];

  const append = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) daemon.log.push(line);
    }
    if (daemon.log.length > LOG_LINES) daemon.log = daemon.log.slice(-LOG_LINES);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  child.on("exit", (code, signal) => {
    daemon.exit = { code, signal, at: Date.now() };
    daemon.log.push(`— exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`);
  });
  child.on("error", (err) => daemon.log.push(`— could not start: ${err.message}`));

  return { ok: true };
}

export async function stop(): Promise<{ ok: boolean; error?: string }> {
  if (!isRunning()) return { ok: false, error: "the recorder is not running" };
  const child = daemon.child!;

  // SIGINT, not SIGTERM: the daemon's KeyboardInterrupt handler commits an
  // in-flight take and finalizes the dataset, and a take is worth more than a
  // fast shutdown. SIGKILL only if it will not go.
  const exited = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 20_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  child.kill("SIGINT");

  if (!(await exited)) {
    child.kill("SIGKILL");
    daemon.log.push("— did not stop in 20s; killed");
  }
  return { ok: true };
}

/** USB serial devices, which is where the arms show up on macOS. */
export function serialPorts(): string[] {
  try {
    return fs
      .readdirSync("/dev")
      .filter((name) => name.startsWith("tty.usbmodem") || name.startsWith("tty.usbserial"))
      .map((name) => `/dev/${name}`)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Ask LeRobot which camera indices OpenCV can see.
 *
 * Only safe while the daemon is stopped: opening a capture device that the
 * recorder already holds fails, and on macOS can wedge it.
 */
export function findCameras(timeoutMs = 30_000): Promise<{ index: number; name: string }[]> {
  const code = [
    "import json",
    "from lerobot.cameras.opencv.camera_opencv import OpenCVCamera",
    "print(json.dumps([{'index': int(c['id']), 'name': str(c.get('name') or '')} for c in OpenCVCamera.find_cameras()]))",
  ].join("\n");

  return new Promise((resolve) => {
    const child = spawn(python(), ["-c", code], { cwd: repoRoot() });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve([]);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (out += chunk.toString()));
    child.on("exit", () => {
      clearTimeout(timer);
      // The import prints libavdevice warnings on macOS; the payload is the
      // last line that parses as JSON.
      for (const line of out.trim().split("\n").reverse()) {
        try {
          const parsed = JSON.parse(line);
          if (Array.isArray(parsed)) return resolve(parsed);
        } catch {
          /* not the payload line */
        }
      }
      resolve([]);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}
