"use client";

import { useEffect, useRef, useState } from "react";

import type { DaemonConfig } from "@/lib/daemon";
import type { RecorderState, RecorderStatus } from "@/lib/api-types";
import { DEFAULT_CAMERAS, resolveCameras, type CameraSpec } from "@/lib/camera-ports";
import type { Recorder } from "@/lib/use-recorder";

/**
 * Recording controls: one primary button plus whatever else applies right now.
 *
 *   offline    ● Record          -> start the daemon, engage teleop, start a take
 *   idle       ● Record          -> start a take
 *   recording  ■ Stop & save    -> encode joints + camera videos to the dataset
 *   pending    ⏎ Save now / ⌫ Delete take / ● Record next
 *
 * Nothing is written to disk until the commit window closes, so deleting a bad
 * take is instant and leaves no trace -- no parquet rewrite, no re-encode. Do
 * nothing and the take is kept, which is the right default for a button you are
 * hitting between attempts with a robot arm in your other hand.
 *
 * Every action is a button; the keys are a shortcut for the same commands, for
 * when both your hands are on the leader arm.
 */
export default function RecordBar({ recorder }: { recorder: Recorder }) {
  const { status, busy, send, reconnectNow } = recorder;
  const [phase, setPhase] = useState<Phase>("idle");
  const [waitHint, setWaitHint] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const running = useRef(false);
  const cancelled = useRef(false);

  // Start/stop is also a keypress: while teleoperating you have a leader arm in
  // one hand and no attention to spare for finding a cursor.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (busy) return;

      if (event.key === " " && running.current) {
        event.preventDefault();
        cancelled.current = true;
        return;
      }
      if (running.current) return;

      if (event.key === " " && (!status || status.offline || status.state === "idle" || status.state === "pending")) {
        event.preventDefault();
        void goLive();
        return;
      }
      if (!status || status.offline) return;
      const action = KEYS[event.key]?.(status.state);
      if (!action) return;
      event.preventDefault();
      void send(action as "stop" | "discard" | "save");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, busy]);

  /**
   * One button: start the daemon (teleop + cameras) if it is down, wait until
   * the arms agree, hand the follower to the leader, then start a take that
   * writes joint telemetry *and* camera frames together.
   */
  async function goLive() {
    if (running.current) {
      cancelled.current = true;
      return;
    }
    running.current = true;
    cancelled.current = false;
    setLocalError(null);
    setWaitHint(null);
    try {
      let s = (await fetchRecorderHttp()) ?? status;
      const config = await loadStartConfig();
      const wanted = cameraKey(config.cameras);

      const daemon = await fetchDaemon();
      const runningCams = cameraKey((daemon?.config?.cameras as CameraSpec[] | undefined) ?? []);
      const needRestart = Boolean(daemon?.running && wanted && runningCams !== wanted);

      if (needRestart) {
        setPhase("starting");
        setWaitHint("restarting with both cameras…");
        await postJson("/api/daemon/stop", {});
        s = { ...(s ?? OFFLINE_STATUS), offline: true };
      }

      if (!s || s.offline) {
        setPhase("starting");
        setWaitHint(`starting ${config.repoId} · ${config.cameras.map((c) => c.name).join(" + ")}…`);
        if (!daemon?.running) {
          await stopProc("cameras");
          await stopProc("teleop");
          const started = await postJson("/api/daemon/start", config);
          if (started?.ok === false && !String(started?.error ?? "").includes("already")) {
            throw new Error(started?.error ?? "failed to start recorder");
          }
        }
        reconnectNow();
        s = await waitForRecorderOnline(recorder, 90_000, () => cancelled.current);
      }

      throwIfCancelled();
      if (s.state === "estopped") throw new Error("arms are e-stopped — re-arm to record again");
      if (s.state === "calibrating") throw new Error("finish or cancel the calibration to record again");
      if (s.state === "recording" || s.state === "saving") return;

      if (!s.teleop?.engaged) {
        setPhase("waiting");
        s = await waitUntilReady(recorder, s, () => cancelled.current, setWaitHint);
        throwIfCancelled();
        setPhase("engaging");
        setWaitHint("handing the follower to the leader…");
        const engaged = await send("engage");
        if (!engaged) return;
        s = engaged;
      }

      if (s.teleop && s.teleop.record_ready === false) {
        setPhase("engaging");
        setWaitHint("waiting for the follower to settle…");
        const settled = await pollRecorderHttp(
          (next) => Boolean(next?.teleop?.record_ready),
          20_000,
          () => cancelled.current,
        );
        if (settled) s = settled;
      }

      throwIfCancelled();
      if (s.state === "idle" || s.state === "pending") {
        setPhase("recording");
        setWaitHint("recording telemetry and cameras…");
        const recorded = await send("record");
        if (!recorded) return;
      }
    } catch (err) {
      if ((err as Error).message !== "cancelled") setLocalError((err as Error).message);
    } finally {
      setPhase("idle");
      setWaitHint(null);
      running.current = false;
      cancelled.current = false;
    }
  }

  function throwIfCancelled() {
    if (cancelled.current) throw new Error("cancelled");
  }

  const error = localError ?? recorder.error;
  const dismiss = () => {
    setLocalError(null);
    recorder.dismissError();
  };

  if (!status || status.offline) {
    return (
      <section className="panel recorder">
        <div className="inner label-bar">
          <button
            className={`record-btn idle ${phase !== "idle" ? "busy" : ""}`}
            tabIndex={-1}
            onClick={() => {
              if (running.current) {
                cancelled.current = true;
                return;
              }
              void goLive();
            }}
          >
            <span className="glyph">●</span>
            {PHASE_LABEL[phase]}
          </button>
          <span className="hint">
            {waitHint ?? (phase === "idle" ? "starts teleop, waits for sync, then records joints and cameras" : "")}
          </span>
          {error && (
            <button className="safety-error" onClick={dismiss} title="dismiss">
              {error}
            </button>
          )}
        </div>
      </section>
    );
  }

  // Recording is not offered while the arms are dead or the geometry is being
  // rewritten underneath the dataset.
  if (status.state === "estopped" || status.state === "calibrating") {
    return (
      <section className={`panel recorder ${status.state}`}>
        <div className="inner label-bar">
          <span className="readout">recording paused</span>
          <span className="hint">
            {status.state === "estopped"
              ? "arms are e-stopped — re-arm to record again"
              : "finish or cancel the calibration to record again"}
          </span>
        </div>
      </section>
    );
  }

  const state = status.state;
  const recordReady = !status.teleop || status.teleop.record_ready !== false;
  const notEngaged = state === "idle" && status.teleop && !status.teleop.engaged;

  return (
    <section className={`panel recorder ${state}`}>
      <div className="inner label-bar">
        <button
          className={`record-btn ${notEngaged ? "idle" : state} ${phase !== "idle" ? "busy" : ""}`}
          disabled={busy || state === "saving"}
          tabIndex={-1}
          onClick={() => {
            if (running.current) {
              cancelled.current = true;
              return;
            }
            if (state === "recording") {
              void send("stop");
              return;
            }
            void goLive();
          }}
        >
          <span className="glyph">{GLYPH[state]}</span>
          {phase !== "idle" ? PHASE_LABEL[phase] : LABEL[state]}
        </button>

        {state === "pending" && (
          <button className="verdict pass" tabIndex={-1} disabled={busy} onClick={() => void send("save")}>
            Save now
          </button>
        )}
        {(state === "recording" || state === "pending") && (
          <button className="verdict danger" tabIndex={-1} disabled={busy} onClick={() => void send("discard")}>
            Delete
          </button>
        )}

        {state === "recording" ? (
          <RecordTimer elapsed={status.elapsed_s} frames={status.frames} />
        ) : (
          <span className="readout">
            {state === "pending" && (
              <>
                {status.frames} frames · saving in {status.commit_in_s.toFixed(1)}s
              </>
            )}
            {state !== "pending" &&
              (waitHint
                ? waitHint
                : notEngaged
                  ? status.teleop!.ready
                    ? "the follower is not being driven yet"
                    : `arms ${status.teleop!.worst.toFixed(1)} apart on ${status.teleop!.worst_joint} — line them up first`
                  : status.message)}
          </span>
        )}
        {!recordReady && <span className="hint">waiting for the follower to settle under leader control</span>}

        {state === "pending" && (
          <div className="commit-bar" aria-hidden>
            <div style={{ width: `${100 * (1 - status.commit_in_s / status.commit_seconds)}%` }} />
          </div>
        )}

        {error && (
          <button className="safety-error" onClick={dismiss} title="dismiss">
            {error}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The elapsed time since the daemon actually flipped into RECORDING -- which is
 * to say, since the leader and follower were already synced (recording is
 * refused otherwise) -- driven straight from the daemon's own clock rather than
 * a client-side `setInterval`, so it can never drift from what lands on disk.
 */
function RecordTimer({ elapsed, frames }: { elapsed: number; frames: number }) {
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed - minutes * 60;
  return (
    <span className="record-timer" role="timer" aria-label={`recording, ${elapsed.toFixed(1)} seconds`}>
      <span className="record-timer-dot" aria-hidden />
      <span className="record-timer-clock">
        {minutes > 0 && `${minutes}:${seconds < 10 ? "0" : ""}`}
        {seconds.toFixed(1)}
        {minutes === 0 && "s"}
      </span>
      <span className="hint">{frames} frames</span>
    </span>
  );
}

type Phase = "idle" | "starting" | "waiting" | "engaging" | "recording";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Record",
  starting: "Starting…",
  waiting: "Waiting for sync…",
  engaging: "Syncing arms…",
  recording: "Recording…",
};

/**
 * Space toggles record/stop. Backspace throws the current take away -- during
 * the recording *or* inside the commit window, so a demo you can already see
 * going wrong does not have to be finished first. Enter commits early instead
 * of waiting the window out.
 */
const KEYS: Record<string, (state: RecorderState) => string | null> = {
  Backspace: (state) => (state === "recording" || state === "pending" ? "discard" : null),
  Enter: (state) => (state === "pending" ? "save" : null),
};

const LABEL: Record<RecorderState, string> = {
  idle: "Record",
  recording: "Stop & save",
  pending: "Record next",
  saving: "Saving…",
  calibrating: "Calibrating",
  estopped: "Stopped",
};

const GLYPH: Record<RecorderState, string> = {
  idle: "●",
  recording: "■",
  pending: "●",
  saving: "◌",
  calibrating: "⚙",
  estopped: "⏻",
};

const OFFLINE_STATUS: RecorderStatus = {
  state: "idle",
  repo_id: "",
  fps: 0,
  task: "",
  frames: 0,
  elapsed_s: 0,
  commit_in_s: 0,
  commit_seconds: 0,
  saved_episodes: 0,
  message: "",
  cameras: [],
  estop: { engaged: false, reason: "", since_s: 0, auto: false },
  delta: { joints: {}, max: 0, max_joint: null, limit: 0, over: false, over_ticks: 0 },
  calibration: null,
  offline: true,
};

/* ---- daemon bring-up helpers ------------------------------------------ */

function readStoredConfig(): Partial<DaemonConfig> | null {
  try {
    const raw = window.localStorage.getItem("suds.setup");
    return raw ? (JSON.parse(raw) as DaemonConfig) : null;
  } catch {
    return null;
  }
}

function cameraKey(cameras: CameraSpec[]): string {
  return [...cameras]
    .map((c) => `${c.name}=${c.index}`)
    .sort()
    .join(",");
}

function cameraNames(cameras: CameraSpec[]): string {
  return [...cameras.map((c) => c.name)].sort().join(",");
}

/**
 * An existing LeRobot dataset freezes its camera names. `suds/live` was
 * recorded with overhead only; Record now always wants overhead + wrist, so
 * resume a compatible dataset if one exists, otherwise open `suds/live_2`.
 */
async function resolveRepoId(preferred: string, cameras: CameraSpec[]): Promise<string> {
  const wanted = cameraNames(cameras);
  let datasets: string[] = [];
  try {
    const res = await fetch("/api/datasets", { cache: "no-store" });
    if (res.ok) datasets = ((await res.json()) as { datasets?: string[] }).datasets ?? [];
  } catch {
    return preferred;
  }

  const matches = async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/dataset?repo_id=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!res.ok) return false;
      const body = (await res.json()) as { video_keys?: string[] };
      const names = (body.video_keys ?? [])
        .map((key) => key.replace(/^observation\.images\./, ""))
        .sort()
        .join(",");
      return names === wanted;
    } catch {
      return false;
    }
  };

  if (!datasets.includes(preferred)) return preferred;
  if (await matches(preferred)) return preferred;

  for (const id of datasets) {
    if (await matches(id)) return id;
  }

  const base = preferred.replace(/_\d+$/, "");
  let n = 2;
  while (datasets.includes(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

async function loadStartConfig(): Promise<DaemonConfig> {
  const stored = readStoredConfig() ?? {};
  let armPorts = { teleopPort: stored.teleopPort ?? null, robotPort: stored.robotPort ?? null };
  let configuredCams: CameraSpec[] = DEFAULT_CAMERAS;
  try {
    const [armsRes, camsRes] = await Promise.all([
      fetch("/api/config/arms", { cache: "no-store" }),
      fetch("/api/config/cameras", { cache: "no-store" }),
    ]);
    if (armsRes.ok) {
      const arms = (await armsRes.json()) as { teleopPort?: string; robotPort?: string };
      armPorts = {
        teleopPort: stored.teleopPort ?? arms.teleopPort ?? null,
        robotPort: stored.robotPort ?? arms.robotPort ?? null,
      };
    }
    if (camsRes.ok) {
      const body = (await camsRes.json()) as { cameras?: CameraSpec[] };
      if (body.cameras?.length) configuredCams = body.cameras;
    }
  } catch {
    /* use stored / defaults */
  }

  const cameras = configuredCams;
  const preferred = stored.repoId || "suds/live";
  const repoId = await resolveRepoId(preferred, cameras);
  const config: DaemonConfig = {
    repoId,
    task: stored.task || "pick up the sponge",
    fps: stored.fps || 30,
    robotPort: armPorts.robotPort,
    teleopPort: armPorts.teleopPort,
    cameras,
    deltaLimit: stored.deltaLimit ?? 25,
    autoEstop: stored.autoEstop ?? false,
    engageOnStart: false,
    commitSeconds: stored.commitSeconds ?? 6,
  };
  try {
    window.localStorage.setItem("suds.setup", JSON.stringify({ ...stored, ...config }));
  } catch {
    /* private browsing */
  }
  return config;
}

type JsonReply = { ok?: boolean; error?: string } & Record<string, unknown>;

async function postJson(url: string, body: unknown): Promise<JsonReply | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const payload = (await res.json().catch(() => ({}))) as JsonReply;
    if (!res.ok && payload.error === undefined) payload.error = `${url} failed`;
    return payload;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function stopProc(name: "cameras" | "teleop"): Promise<void> {
  await postJson(`/api/run/${name}`, { action: "stop" });
}

type DaemonStatus = {
  running: boolean;
  config?: DaemonConfig | null;
  exit: { code: number | null; signal: string | null } | null;
  log: string[];
};

async function fetchDaemon(): Promise<DaemonStatus | null> {
  try {
    const res = await fetch("/api/daemon/status", { cache: "no-store" });
    return res.ok ? ((await res.json()) as DaemonStatus) : null;
  } catch {
    return null;
  }
}

async function fetchRecorderHttp(): Promise<RecorderStatus | null> {
  try {
    const res = await fetch("/api/recorder/status", { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as RecorderStatus & { offline?: boolean };
    if (!body?.state || body.offline) return null;
    return body;
  } catch {
    return null;
  }
}

async function waitForRecorderOnline(
  recorder: Recorder,
  timeoutMs: number,
  cancelled: () => boolean,
): Promise<RecorderStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cancelled()) throw new Error("cancelled");

    const http = await fetchRecorderHttp();
    if (http) {
      recorder.reconnectNow();
      return http;
    }

    const daemon = await fetchDaemon();
    if (daemon && !daemon.running && daemon.exit) {
      const last = daemon.log.filter((l) => !l.startsWith("—")).slice(-1)[0];
      throw new Error(last ?? `recorder exited (code ${daemon.exit.code ?? "?"})`);
    }

    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("recorder did not come online — check the daemon log");
}

async function pollRecorderHttp(
  test: (status: RecorderStatus) => boolean,
  timeoutMs: number,
  cancelled: () => boolean,
  onTick?: (status: RecorderStatus) => void,
): Promise<RecorderStatus | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cancelled()) return null;
    const http = await fetchRecorderHttp();
    if (http) {
      onTick?.(http);
      if (test(http)) return http;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return fetchRecorderHttp();
}

async function waitUntilReady(
  _recorder: Recorder,
  current: RecorderStatus,
  cancelled: () => boolean,
  onHint: (hint: string) => void,
): Promise<RecorderStatus> {
  if (current.teleop?.ready) return current;
  const s = await pollRecorderHttp(
    (next) => {
      if (!next.teleop) return false;
      if (!next.teleop.ready) {
        const joint = next.teleop.worst_joint ?? "a joint";
        onHint(`line up the arms — ${joint} is ${next.teleop.worst.toFixed(1)} out`);
        return false;
      }
      return true;
    },
    10 * 60_000,
    cancelled,
  );
  if (cancelled()) throw new Error("cancelled");
  if (!s?.teleop?.ready) throw new Error("arms did not line up in time — match them by hand, then press Record");
  return s;
}
