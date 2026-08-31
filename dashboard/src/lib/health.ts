import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { readArmsConfig } from "./arms-config";
import { reconcileArmPorts } from "./arm-ports";
import { isRunning as calibrateRunning } from "./calibrate";
import { isRunning as recorderRunning } from "./daemon";
import { binary, isRunning as procRunning, repoRoot, serialPorts } from "./procs";

/** Where scripts/health_server.py listens. */
export const HEALTH_PORT = 8612;

export type HealthCamera = { name: string; index: number };

type HealthProc = {
  child: ChildProcess | null;
  configKey: string;
  startedAt: number;
  log: string[];
  /**
   * Raised while teleop or the recorder is being spawned, before its child
   * process exists to be seen by `portsBlocked`. Without it a status poll
   * landing in that gap reads "nothing holds the ports" and starts the health
   * daemon back up, straight into the process that is claiming them.
   */
  claimed: boolean;
};

const store = globalThis as unknown as { __sudsHealth?: HealthProc };
const health: HealthProc = (store.__sudsHealth ??= {
  child: null,
  configKey: "",
  startedAt: 0,
  log: [],
  claimed: false,
});

function configKey(teleopPort: string, robotPort: string, cameras: HealthCamera[]): string {
  const cams = [...cameras].sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify({ teleopPort, robotPort, cameras: cams });
}

export function isHealthRunning(): boolean {
  return health.child !== null && health.child.exitCode === null && !health.child.killed;
}

/**
 * True when something else holds an arm serial port, or is about to.
 *
 * Calibration is in here for the same reason teleop is: `lerobot-calibrate`
 * owns the port for the whole interactive session, which is minutes, and a
 * two-second health scan landing in the middle of it kills one of the two.
 * Asking the session whether it is running -- rather than holding a flag for
 * that long -- means a crashed calibration cannot suppress health forever.
 */
export function portsBlocked(): boolean {
  return health.claimed || recorderRunning() || procRunning("teleop") || calibrateRunning();
}

/**
 * Hand the arm ports to teleop or the recorder: stop the health daemon and keep
 * it stopped until the caller's process is up and visible to `portsBlocked`.
 *
 * Always pair with `releaseArmPorts` in a `finally`, or a failed start would
 * leave the health daemon permanently suppressed.
 */
export async function claimArmPorts(): Promise<void> {
  health.claimed = true;
  await stopHealth();
}

export function releaseArmPorts(): void {
  health.claimed = false;
}

/** Pull leader/follower ports from config/arms.json and reconcile with USB scan. */
export function resolveHealthPorts() {
  const configured = readArmsConfig();
  const scanned = serialPorts();
  return reconcileArmPorts(scanned, configured).ports;
}

function validatePorts(ports: { teleopPort: string | null; robotPort: string | null }): string | null {
  if (!ports.teleopPort || !ports.robotPort) return "leader and follower ports are not configured — edit config/arms.json";
  if (ports.teleopPort === ports.robotPort) return "leader and follower cannot be the same port";
  for (const [label, port] of [
    ["leader", ports.teleopPort],
    ["follower", ports.robotPort],
  ] as const) {
    if (!/^\/dev\/tty\.[\w.-]+$/.test(port)) return `${label} port must be a /dev/tty.* device`;
    if (!fs.existsSync(port)) return `${label} port ${port} is not plugged in`;
  }
  return null;
}

function startHealth(
  ports: { teleopPort: string; robotPort: string },
  cameras: HealthCamera[],
): { ok: boolean; error?: string } {
  const args = [
    path.join(repoRoot(), "scripts", "health_server.py"),
    "--teleop-port",
    ports.teleopPort,
    "--robot-port",
    ports.robotPort,
    "--port",
    String(HEALTH_PORT),
    "--rate",
    "0.5",
    ...cameras.flatMap((c) => ["--camera", `${c.name}=${c.index}`]),
  ];

  const child = spawn(binary("python"), args, {
    cwd: repoRoot(),
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  health.child = child;
  health.startedAt = Date.now();
  health.configKey = configKey(ports.teleopPort, ports.robotPort, cameras);
  health.log = [`$ ${binary("python")} ${args.join(" ")}`];

  const append = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) if (line.trim()) health.log.push(line);
    if (health.log.length > 80) health.log = health.log.slice(-80);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("exit", (code, signal) => {
    health.log.push(`— exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`);
    health.child = null;
    health.configKey = "";
  });
  child.on("error", (err) => health.log.push(`— could not start: ${err.message}`));

  return { ok: true };
}

/**
 * Cut the health daemon loose before something else claims the arm ports.
 *
 * It scans every two seconds, and a scan *opens* both serial devices. Starting
 * teleop or the recorder while it is still running means two processes on one
 * /dev/tty.* within a couple of seconds -- which is the "device disconnected or
 * multiple access on port?" crash, a few seconds after pressing start. Callers
 * must await this before spawning anything that holds the arms.
 */
export async function stopHealth(): Promise<void> {
  if (!isHealthRunning()) return;
  const child = health.child!;
  const exited = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  child.kill("SIGINT");
  if (!(await exited)) child.kill("SIGKILL");
  health.child = null;
  health.configKey = "";
}

/**
 * Start (or restart) the health daemon with synced arm ports.
 * Skips when the recorder or teleop holds the serial ports — those publish hardware live.
 */
export async function ensureHealth(cameras: HealthCamera[] = []): Promise<{
  ok: boolean;
  error?: string;
  skipped?: boolean;
  restarted?: boolean;
}> {
  if (portsBlocked()) {
    return { ok: false, skipped: true, error: "recorder or teleop holds the arm ports" };
  }

  const ports = resolveHealthPorts();
  const invalid = validatePorts(ports);
  if (invalid) return { ok: false, error: invalid };

  const key = configKey(ports.teleopPort!, ports.robotPort!, cameras);
  if (isHealthRunning() && health.configKey === key) return { ok: true };

  const restarted = isHealthRunning();
  if (restarted) await stopHealth();

  const started = startHealth({ teleopPort: ports.teleopPort!, robotPort: ports.robotPort! }, cameras);
  return started.ok ? { ok: true, restarted } : started;
}

export function healthStatus() {
  return {
    running: isHealthRunning(),
    pid: isHealthRunning() ? health.child!.pid : null,
    uptime_s: isHealthRunning() ? (Date.now() - health.startedAt) / 1000 : 0,
    configKey: health.configKey,
    ports: resolveHealthPorts(),
    blocked: portsBlocked(),
    log: health.log.slice(-20),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until health_server has finished its first arm probe (LeRobot import is slow). */
export async function waitForHealthPayload(timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${HEALTH_PORT}/status`, {
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { teleop?: unknown; message?: string };
      if (body.teleop) return true;
      if (body.message && body.message !== "starting") return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}
