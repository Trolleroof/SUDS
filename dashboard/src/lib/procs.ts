import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isRunning as recorderRunning } from "./daemon";

/**
 * Two commands you can run with one button, independent of the recorder.
 *
 * The recording daemon needs an arm, a dataset and a matching camera schema
 * before it will start. Most of the time the question is much smaller than
 * that: *are the arms talking to each other*, and *is the camera pointing at
 * the right thing*. These run exactly those, and nothing else.
 *
 *   teleop  — LeRobot's own `lerobot-teleoperate`. No dataset, nothing written.
 *   cameras — `scripts/camera_server.py`, MJPEG only. No arms.
 */

export type ProcName = "teleop" | "cameras";

export type ProcConfig = {
  robotPort: string | null;
  teleopPort: string | null;
  robotId: string;
  teleopId: string;
  cameras: { name: string; index: number }[];
};

type Proc = {
  child: ChildProcess | null;
  startedAt: number;
  log: string[];
  exit: { code: number | null; signal: string | null } | null;
};

const store = globalThis as unknown as { __sudsProcs?: Record<string, Proc> };
const procs: Record<string, Proc> = (store.__sudsProcs ??= {});

function slot(name: ProcName): Proc {
  return (procs[name] ??= { child: null, startedAt: 0, log: [], exit: null });
}

export function repoRoot(): string {
  return process.env.SUDS_ROOT ?? path.resolve(process.cwd(), "..");
}

export function binary(name: string): string {
  const venv = path.join(repoRoot(), ".venv", "bin", name);
  return fs.existsSync(venv) ? venv : name;
}

/** Where camera_server.py listens, so the dashboard can proxy its stream. */
export const CAMERA_PORT = 8614;

export function isRunning(name: ProcName): boolean {
  const proc = slot(name);
  return proc.child !== null && proc.child.exitCode === null && !proc.child.killed;
}

export function status(name: ProcName) {
  const proc = slot(name);
  return {
    name,
    running: isRunning(name),
    pid: isRunning(name) ? proc.child!.pid : null,
    uptime_s: isRunning(name) ? (Date.now() - proc.startedAt) / 1000 : 0,
    log: proc.log.slice(-40),
    exit: proc.exit,
  };
}

function command(name: ProcName, config: ProcConfig): { bin: string; args: string[] } | string {
  if (name === "teleop") {
    if (!config.teleopPort || !config.robotPort) return "pick both arm ports first";
    if (config.teleopPort === config.robotPort) return "the leader and follower cannot be the same port";
    for (const port of [config.teleopPort, config.robotPort]) {
      if (!/^\/dev\/tty\.[\w.-]+$/.test(port) || !fs.existsSync(port)) return `${port} is not plugged in`;
    }
    // scripts/teleop_run.py, not LeRobot's own `lerobot-teleoperate`: this one
    // eases into record_server.py's hand-posed START_POSE/REST_POSE on start
    // and stop, so the quick check matches what recording does.
    return {
      bin: binary("python"),
      args: [
        path.join(repoRoot(), "scripts", "teleop_run.py"),
        "--robot-port",
        config.robotPort,
        "--robot-id",
        config.robotId,
        "--teleop-port",
        config.teleopPort,
        "--teleop-id",
        config.teleopId,
      ],
    };
  }

  if (!config.cameras.length) return "add at least one camera first";
  for (const camera of config.cameras) {
    if (!/^[a-z][a-z0-9_]*$/i.test(camera.name)) return `camera name "${camera.name}" is not valid`;
    if (!Number.isInteger(camera.index) || camera.index < 0 || camera.index > 64) {
      return `camera ${camera.name} needs an index 0-64`;
    }
  }
  return {
    bin: binary("python"),
    args: [
      path.join(repoRoot(), "scripts", "camera_server.py"),
      "--port",
      String(CAMERA_PORT),
      ...config.cameras.flatMap((c) => ["--camera", `${c.name}=${c.index}`]),
    ],
  };
}

export function start(name: ProcName, config: ProcConfig): { ok: boolean; error?: string } {
  if (isRunning(name)) return { ok: false, error: `${name} is already running` };
  // "teleop" and the recorder daemon both open the follower and leader ports
  // directly -- two processes on the same /dev/tty.* device is exactly what
  // produces "device disconnected or multiple access on port?" mid-session.
  if (name === "teleop" && recorderRunning()) {
    return { ok: false, error: "stop the recorder first — it holds both arm ports" };
  }

  const built = command(name, config);
  if (typeof built === "string") return { ok: false, error: built };

  const proc = slot(name);
  const child = spawn(built.bin, built.args, {
    cwd: repoRoot(),
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.child = child;
  proc.startedAt = Date.now();
  proc.exit = null;
  proc.log = [`$ ${built.bin} ${built.args.join(" ")}`];

  const append = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) if (line.trim()) proc.log.push(line);
    if (proc.log.length > 120) proc.log = proc.log.slice(-120);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("exit", (code, signal) => {
    proc.exit = { code, signal };
    proc.log.push(`- exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`);
  });
  child.on("error", (err) => proc.log.push(`- could not start: ${err.message}`));

  return { ok: true };
}

export async function stop(name: ProcName): Promise<{ ok: boolean; error?: string }> {
  if (!isRunning(name)) return { ok: false, error: `${name} is not running` };
  const child = slot(name).child!;

  // SIGINT so both shut down through their own KeyboardInterrupt path, which is
  // what releases the serial ports and the capture devices cleanly.
  const exited = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  child.kill("SIGINT");
  if (!(await exited)) child.kill("SIGKILL");
  return { ok: true };
}

export type IdentifyPort = {
  port: string;
  connected: boolean;
  motors: number;
  travel: number;
  joint: string | null;
  moved?: boolean;
  error?: string;
};

export type IdentifyResult = {
  ports: IdentifyPort[];
  moved_port: string | null;
  ambiguous: boolean;
};

/**
 * Watch both ports while the operator moves one arm, and report which saw it.
 *
 * Two identical SO-101 boards produce two indistinguishable `usbmodem` names.
 * This is the cheapest way to tell them apart that does not involve unplugging
 * a cable, and it never writes torque -- see scripts/identify_arms.py.
 */
export function identify(ports: string[], seconds = 6): Promise<IdentifyResult | string> {
  const usable = ports.filter((p) => /^\/dev\/tty\.[\w.-]+$/.test(p) && fs.existsSync(p));
  if (!usable.length) return Promise.resolve("no USB serial ports to check");
  // Only things that actually hold a *serial* port block this. The camera
  // server holds capture devices and has nothing to do with the arms -- lumping
  // them together made "Which is which?" unusable whenever the cameras were on,
  // which is most of the time.
  if (isRunning("teleop")) {
    return Promise.resolve("stop teleop first — it holds both arm ports");
  }
  if (recorderRunning()) {
    return Promise.resolve("stop the recorder first — it holds both arm ports");
  }

  return new Promise((resolve) => {
    const child = spawn(
      binary("python"),
      [
        path.join(repoRoot(), "scripts", "identify_arms.py"),
        "--seconds",
        String(seconds),
        ...usable.flatMap((p) => ["--port", p]),
      ],
      { cwd: repoRoot(), env: { ...process.env, PYTHONUNBUFFERED: "1" } },
    );

    let out = "";
    let err = "";
    // Generous: the import alone takes ~15s on this machine, before the window.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("identification timed out");
    }, (seconds + 60) * 1000);

    child.stdout.on("data", (chunk) => (out += chunk.toString()));
    child.stderr.on("data", (chunk) => (err += chunk.toString()));
    child.on("exit", () => {
      clearTimeout(timer);
      const at = out.lastIndexOf("RESULT:");
      if (at === -1) return resolve(err.trim().split("\n").slice(-1)[0] || "identification failed");
      try {
        resolve(JSON.parse(out.slice(at + "RESULT:".length)) as IdentifyResult);
      } catch {
        resolve("could not read the identification result");
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(error.message);
    });
  });
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
