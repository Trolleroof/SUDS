import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isRunning as recorderRunning } from "./daemon";
import { binary, isRunning as procRunning, repoRoot } from "./procs";

/**
 * `lerobot-calibrate`, driven from the dashboard instead of from a terminal.
 *
 * This is LeRobot's own CLI, unmodified -- the exact command you would type --
 * spawned with its stdin on a pipe. Calibration is a blocking script built
 * around three console prompts:
 *
 *   1. "Press ENTER to use provided calibration file ... or type 'c'"  (only
 *      when a calibration file already exists for this id)
 *   2. "Move ... to the middle of its range of motion and press ENTER"
 *   3. "Move all joints ... through their entire ranges. Press ENTER to stop"
 *
 * Both reads are ordinary stdin reads -- `input()` for the prompts, and a
 * `select()` + `readline()` poll during the sweep -- so a pipe answers them
 * just as well as a keyboard does. Every prompt becomes a button below.
 *
 * Between prompts 2 and 3 the CLI prints a live NAME | MIN | POS | MAX table
 * about fifty times a second. We parse it rather than log it: it is what tells
 * you, while you are still holding the arm, that a joint has actually been
 * swept. A joint that never moves gets a zero-width range, which is what makes
 * a follower fly off when it is later driven -- LeRobot refuses to save that,
 * and so does the Finish button here.
 */

export type CalibrateRole = "leader" | "follower";

/**
 * idle     — nothing has been run in this session
 * starting — process spawned, imports still loading (~15s on this machine)
 * confirm  — an existing calibration file is being offered; we decline it
 * home     — waiting for "this is the middle of every joint's travel"
 * range    — sweeping; the live table is filling in
 * saving   — ENTER sent, the file is being written
 * done     — calibration written to disk
 * failed   — the CLI exited non-zero, or we could not start it
 */
export type CalibratePhase = "idle" | "starting" | "confirm" | "home" | "range" | "saving" | "done" | "failed";

export type CalibrateJoint = { name: string; min: number; pos: number; max: number };

export type CalibrateStatus = {
  running: boolean;
  role: CalibrateRole | null;
  phase: CalibratePhase;
  joints: CalibrateJoint[];
  /** Joints whose observed range is still too narrow to be a real sweep. */
  unswept: string[];
  canFinish: boolean;
  message: string;
  error: string | null;
  log: string[];
  command: string | null;
  savedTo: string | null;
};

/**
 * `wrist_roll` turns freely and is written as the full 0-4095 turn rather than
 * being swept, so the CLI excludes it from the live table entirely.
 */
const FULL_TURN_JOINT = "wrist_roll";

/**
 * A joint swept through its real travel covers a good part of a turn; the
 * SO-101 joints in this repo's own calibration files span 2200-2500 counts. A
 * few hundred counts means the joint was nudged, not swept, and a range that
 * small is what turns a small leader movement into a huge follower one.
 */
const MIN_SWEEP_COUNTS = 800;

type Session = {
  child: ChildProcess | null;
  role: CalibrateRole | null;
  phase: CalibratePhase;
  joints: Map<string, CalibrateJoint>;
  log: string[];
  error: string | null;
  command: string | null;
  savedTo: string | null;
  /** stdout that has not yet been resolved into a line or a prompt. */
  buffer: string;
  /** Motor ids the bus handshake reported missing, and the exception line. */
  missing: number[];
  readingMissing: boolean;
  fault: string | null;
  /** Set while start() is about to spawn a same-cause retry, so the exit
   *  handler routes into it instead of finalizing as failed. */
  retrying: boolean;
  retried: boolean;
  spawn: { role: CalibrateRole; port: string; id: string } | null;
};

const store = globalThis as unknown as { __sudsCalibrate?: Session };

function session(): Session {
  return (store.__sudsCalibrate ??= {
    child: null,
    role: null,
    phase: "idle",
    joints: new Map(),
    log: [],
    error: null,
    command: null,
    savedTo: null,
    buffer: "",
    missing: [],
    readingMissing: false,
    fault: null,
    retrying: false,
    retried: false,
    spawn: null,
  });
}

export function isRunning(): boolean {
  const state = session();
  return state.child !== null && state.child.exitCode === null && !state.child.killed;
}

/** Where LeRobot keeps calibration, keyed by the device class name and id. */
export function calibrationPath(role: CalibrateRole, id: string): string {
  const base =
    process.env.HF_LEROBOT_CALIBRATION ??
    path.join(os.homedir(), ".cache", "huggingface", "lerobot", "calibration");
  return role === "follower"
    ? path.join(base, "robots", "so_follower", `${id}.json`)
    : path.join(base, "teleoperators", "so_leader", `${id}.json`);
}

export type SavedJoint = {
  name: string;
  homing_offset: number;
  range_min: number;
  range_max: number;
  /** Narrow enough that driving this joint will amplify every command. */
  suspect: boolean;
};

export type SavedCalibration = {
  role: CalibrateRole;
  id: string;
  path: string;
  exists: boolean;
  modified: number | null;
  joints: SavedJoint[];
  suspect: string[];
};

/**
 * Read back what is actually on disk for an arm.
 *
 * The reason to show this next to the button: a follower whose joints "go
 * everywhere" is almost always one whose saved ranges are too narrow, and that
 * is visible here before you power anything on.
 */
export function readCalibration(role: CalibrateRole, id: string): SavedCalibration {
  const file = calibrationPath(role, id);
  const empty: SavedCalibration = {
    role,
    id,
    path: file,
    exists: false,
    modified: null,
    joints: [],
    suspect: [],
  };

  let parsed: Record<string, { homing_offset?: number; range_min?: number; range_max?: number }>;
  let modified: number;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    modified = fs.statSync(file).mtimeMs;
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;

  const joints = Object.entries(parsed).map(([name, motor]) => {
    const min = Number(motor?.range_min ?? 0);
    const max = Number(motor?.range_max ?? 0);
    return {
      name,
      homing_offset: Number(motor?.homing_offset ?? 0),
      range_min: min,
      range_max: max,
      suspect: name !== FULL_TURN_JOINT && max - min < MIN_SWEEP_COUNTS,
    };
  });

  return {
    role,
    id,
    path: file,
    exists: true,
    modified,
    joints,
    suspect: joints.filter((joint) => joint.suspect).map((joint) => joint.name),
  };
}

function unswept(state: Session): string[] {
  return [...state.joints.values()]
    .filter((joint) => joint.max - joint.min < MIN_SWEEP_COUNTS)
    .map((joint) => joint.name);
}

const MESSAGES: Record<CalibratePhase, string> = {
  idle: "no calibration has been run",
  starting: "starting lerobot-calibrate — loading the drivers takes a moment",
  confirm: "declining the saved calibration file",
  home: "torque is off — move the arm to the middle of every joint's travel",
  range: "sweep every joint through its full travel, then finish",
  saving: "writing the calibration file",
  done: "calibration saved",
  failed: "calibration failed",
};

export function status(): CalibrateStatus {
  const state = session();
  const pending = unswept(state);
  return {
    running: isRunning(),
    role: state.role,
    phase: state.phase,
    joints: [...state.joints.values()],
    unswept: pending,
    canFinish: state.phase === "range" && state.joints.size > 0 && pending.length === 0,
    message: state.error ?? MESSAGES[state.phase],
    error: state.error,
    log: state.log.slice(-40),
    command: state.command,
    savedTo: state.savedTo,
  };
}

/** The live table is redrawn with cursor-up escapes; strip them before parsing. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- ESC is exactly what we strip
  return text.replace(/\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * SO-101 motors are daisy-chained in this order, and the bus reports a fault by
 * motor id. Naming the joint is the difference between "motor 5 is missing" and
 * "the wrist_roll cable is loose".
 */
const JOINT_BY_ID: Record<number, string> = {
  1: "shoulder_pan",
  2: "shoulder_lift",
  3: "elbow_flex",
  4: "wrist_flex",
  5: "wrist_roll",
  6: "gripper",
};

/**
 * Pull the reason out of a Python traceback on its way past.
 *
 * `connect()` handshakes with every motor before calibration starts, so the
 * common failure is not a calibration problem at all -- it is a motor that did
 * not answer, which exits 1 with the explanation buried thirty lines up a
 * traceback. Keep the explanation, not the exit code.
 */
function diagnose(state: Session, line: string): void {
  if (/^Missing motor IDs:/i.test(line)) {
    state.readingMissing = true;
    state.missing = [];
    return;
  }
  if (state.readingMissing) {
    const found = /^-\s*(\d+)\s*\(expected model/.exec(line);
    if (found) {
      state.missing.push(Number(found[1]));
      return;
    }
    state.readingMissing = false;
  }
  // The last `SomeError: message` line of a traceback is the useful one.
  const raised = /^([A-Za-z_][\w.]*(?:Error|Exception)): (.+)$/.exec(line);
  if (raised) state.fault = raised[2].trim();
}

function note(state: Session, line: string): void {
  diagnose(state, line);
  state.log.push(line);
  if (state.log.length > 120) state.log = state.log.slice(-120);
}

/** `shoulder_pan    |    824 |   1900 |   3364` */
const TABLE_ROW = /^([a-z][a-z0-9_]*)\s*\|\s*(-?\d+)\s*\|\s*(-?\d+)\s*\|\s*(-?\d+)\s*$/;

function consume(state: Session, chunk: string): void {
  state.buffer += stripAnsi(chunk);

  // Prompts arrive without a trailing newline, so they are matched against the
  // unterminated tail rather than against completed lines.
  if (/type 'c' and press ENTER to run calibration/i.test(state.buffer)) {
    state.buffer = "";
    if (state.phase === "starting") {
      state.phase = "confirm";
      note(state, "- a calibration file already exists; running a fresh calibration");
      // "Recalibrate" is unambiguous, so decline the saved file without asking
      // again -- keeping it is what the button you did not press does.
      state.child?.stdin?.write("c\n");
    }
    return;
  }
  if (/middle of its range of motion and press ENTER/i.test(state.buffer)) {
    state.buffer = "";
    if (state.phase !== "home") {
      state.phase = "home";
      state.joints.clear();
      note(state, "- waiting for the home position");
    }
    return;
  }

  const lines = state.buffer.split("\n");
  state.buffer = lines.pop() ?? "";

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const row = TABLE_ROW.exec(line);
    if (row) {
      // The table is reprinted ~50x/s. Parsed into state, never logged.
      if (state.phase !== "saving" && state.phase !== "done") state.phase = "range";
      state.joints.set(row[1], {
        name: row[1],
        min: Number(row[2]),
        pos: Number(row[3]),
        max: Number(row[4]),
      });
      continue;
    }
    if (/^NAME\s*\|/.test(line) || /^-{5,}$/.test(line)) continue;

    if (/Recording positions/i.test(line) && state.phase !== "saving") state.phase = "range";
    if (/Calibration saved to/i.test(line)) {
      state.phase = "done";
      state.savedTo = line.replace(/^.*Calibration saved to\s*/i, "").trim() || null;
    }
    if (/same min and max values/i.test(line)) {
      state.error = "a joint was never moved — LeRobot refused to save. Sweep every joint and try again.";
    }
    note(state, line);
  }
}

export function start(
  role: CalibrateRole,
  ports: { leader: string | null; follower: string | null },
  ids: { leader: string; follower: string },
): { ok: boolean; error?: string } {
  if (isRunning()) return { ok: false, error: "a calibration is already running" };
  // Everything that holds a serial port has to be down first: the CLI opens the
  // arm itself, and a second opener gets a garbled bus rather than an error.
  if (procRunning("teleop")) return { ok: false, error: "stop teleop first — it holds both arm ports" };
  if (recorderRunning()) return { ok: false, error: "stop the recorder first — it holds both arm ports" };

  const port = role === "leader" ? ports.leader : ports.follower;
  if (!port) return { ok: false, error: `assign the ${role} port first` };
  if (!/^\/dev\/tty\.[\w.-]+$/.test(port) || !fs.existsSync(port)) {
    return { ok: false, error: `${port} is not plugged in` };
  }

  const id = role === "leader" ? ids.leader : ids.follower;
  if (!/^[a-z][a-z0-9_-]*$/i.test(id)) return { ok: false, error: `"${id}" is not a valid arm id` };

  const state = session();
  state.retried = false;
  state.log = [];
  spawnCalibrate(state, role, port, id);
  return { ok: true };
}

/**
 * Spawn `lerobot-calibrate` and wire up its output. Split out from `start()`
 * so a same-cause retry (see `spawnRetry`) can reuse it without repeating the
 * validation `start()` already did.
 */
function spawnCalibrate(state: Session, role: CalibrateRole, port: string, id: string): void {
  // LeRobot's own CLI, unmodified. `--teleop.*` for the leader, `--robot.*` for
  // the follower -- CalibrateConfig rejects being given both.
  const prefix = role === "leader" ? "teleop" : "robot";
  const type = role === "leader" ? "so101_leader" : "so101_follower";
  const bin = binary("lerobot-calibrate");
  const args = [`--${prefix}.type=${type}`, `--${prefix}.port=${port}`, `--${prefix}.id=${id}`];

  const child = spawn(bin, args, {
    cwd: repoRoot(),
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  state.child = child;
  state.role = role;
  state.spawn = { role, port, id };
  state.phase = "starting";
  state.joints = new Map();
  state.error = null;
  state.savedTo = null;
  state.buffer = "";
  state.missing = [];
  state.readingMissing = false;
  state.fault = null;
  state.command = `${bin} ${args.join(" ")}`;
  state.log.push(`$ ${state.command}`);

  child.stdout?.on("data", (chunk: Buffer) => consume(state, chunk.toString()));
  // The prompts and the table go to stdout; logging and tracebacks to stderr.
  child.stderr?.on("data", (chunk: Buffer) => {
    for (const line of stripAnsi(chunk.toString()).split("\n")) if (line.trim()) note(state, line.trim());
  });
  child.on("error", (err) => {
    state.phase = "failed";
    state.error = `could not start lerobot-calibrate: ${err.message}`;
    note(state, `- ${state.error}`);
  });
  child.on("exit", (code, signal) => {
    note(state, `- exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`);
    if (state.phase === "done") return;

    // A missing motor at the bus handshake is the fault broadcast-ping is
    // prone to on its own: every motor replies to one packet at once on a
    // shared half-duplex line, and those replies can collide and read as one
    // of them never having answered. A retry re-handshakes from a clean
    // connection and either clears -- collision -- or reproduces -- a motor
    // that is actually not there. One retry is enough to tell the two apart
    // without turning a real fault into an infinite loop.
    if (!signal && !state.retried && state.missing.length > 0) {
      state.retried = true;
      note(state, "- missing-motor handshake can be broadcast-ping collision noise; retrying once");
      const again = state.spawn!;
      spawnCalibrate(state, again.role, again.port, again.id);
      return;
    }

    state.phase = "failed";
    state.error ??= signal ? `calibration was stopped (${signal})` : explain(state, code);
  });
}

/**
 * Why the run ended, in the terms the person holding the arm can act on.
 *
 * A missing motor is not a calibration failure -- calibration never began --
 * and it is nearly always the daisy-chain cable at that joint rather than the
 * servo, so say which joint and where to look.
 */
function explain(state: Session, code: number | null): string {
  if (state.missing.length) {
    const named = state.missing.map((id) => `${JOINT_BY_ID[id] ?? `motor ${id}`} (id ${id})`);
    const first = state.missing[0];
    const upstream = JOINT_BY_ID[first - 1];
    return (
      `the ${state.role}'s ${named.join(" and ")} did not answer on the bus, so the arm never ` +
      "connected and calibration did not start. Check the daisy-chain cable" +
      (upstream ? ` between ${upstream} and ${JOINT_BY_ID[first]}` : "") +
      " and that the arm is powered, then try again."
    );
  }
  if (state.fault) return state.fault;
  return `lerobot-calibrate exited with code ${code ?? "null"}`;
}

/** Answer the prompt the CLI is currently blocked on. */
export function advance(): { ok: boolean; error?: string } {
  const state = session();
  if (!isRunning()) return { ok: false, error: "no calibration is running" };

  if (state.phase === "home") {
    state.child!.stdin?.write("\n");
    state.phase = "range";
    note(state, "- home position set; sweeping");
    return { ok: true };
  }
  if (state.phase === "range") {
    const pending = unswept(state);
    if (pending.length) return { ok: false, error: `still to sweep: ${pending.join(", ")}` };
    state.child!.stdin?.write("\n");
    state.phase = "saving";
    note(state, "- finishing; writing the calibration file");
    return { ok: true };
  }
  return { ok: false, error: `nothing to confirm while ${state.phase}` };
}

export async function cancel(): Promise<{ ok: boolean; error?: string }> {
  const state = session();
  if (!isRunning()) return { ok: false, error: "no calibration is running" };
  const child = state.child!;

  // SIGINT, so the CLI's `finally: device.disconnect()` runs and releases the
  // serial port. A cancelled run writes nothing, so the previous calibration
  // file survives untouched.
  state.error = "calibration cancelled — the previous calibration is still in use";
  const exited = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  child.kill("SIGINT");
  if (!(await exited)) child.kill("SIGKILL");
  return { ok: true };
}
