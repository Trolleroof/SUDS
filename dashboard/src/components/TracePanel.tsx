"use client";

import { useEffect, useState } from "react";

import type { DatasetPayload, EpisodeRow, TracePayload } from "@/lib/api-types";

/**
 * One small chart per joint, with the commanded action drawn over the measured
 * state on a shared scale. The gap between the two lines is follower tracking
 * error -- the thing that quietly poisons a dataset, and the thing a single
 * overlaid 6-line plot hides completely.
 */
export default function TracePanel({
  repoId,
  episode,
  data,
}: {
  repoId: string;
  episode: EpisodeRow;
  data: DatasetPayload;
}) {
  const [traces, setTraces] = useState<TracePayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTraces(null);
    void fetch(
      `/api/traces?repo_id=${encodeURIComponent(repoId)}&episode=${episode.episode_index}`,
    )
      .then((r) => r.json())
      .then((body) => {
        if (!cancelled && !body.error) setTraces(body as TracePayload);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, episode.episode_index]);

  const names = data.state_names.length ? data.state_names : data.action_names;
  const quality = episode.quality;

  return (
    <section className="panel">
      <h2>joint traces — state vs action</h2>
      <div className="inner">
        {!traces && <div className="hint">loading…</div>}
        {traces && (
          <>
            <div className="grid-2">
              {names.map((name, joint) => (
                <JointChart
                  key={name}
                  name={name}
                  t={traces.t}
                  state={traces.state[joint] ?? []}
                  action={traces.action[joint] ?? []}
                />
              ))}
            </div>
            <div className="label-bar" style={{ marginTop: 12 }}>
              <span className="hint">
                {traces.frames} frames · every {traces.stride}
                {quality && Number.isFinite(quality.mean_jerk)
                  ? ` · mean step ${quality.mean_jerk.toFixed(2)} · max ${quality.max_jerk.toFixed(2)}`
                  : ""}
                {quality && quality.dropped_frames > 0 ? ` · ${quality.dropped_frames} dropped` : ""}
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

const W = 420;
const H = 84;
const PAD = { top: 10, right: 6, bottom: 14, left: 34 };

function JointChart({
  name,
  t,
  state,
  action,
}: {
  name: string;
  t: number[];
  state: number[];
  action: number[];
}) {
  const values = [...state, ...action].filter(Number.isFinite);
  if (!values.length || t.length < 2) return null;

  let lo = Math.min(...values);
  let hi = Math.max(...values);
  // A joint that never moves would otherwise divide by zero and vanish.
  if (hi - lo < 1e-6) {
    lo -= 1;
    hi += 1;
  }

  const t0 = t[0];
  const t1 = t[t.length - 1];
  const x = (i: number) =>
    PAD.left + ((t[i] - t0) / (t1 - t0 || 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) =>
    PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);

  const line = (series: number[]) =>
    series.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");

  return (
    <div>
      <div className="cam">{name.replace(/\.pos$/, "")}</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${name} trace`}>
        <rect x={PAD.left} y={PAD.top} width={W - PAD.left - PAD.right} height={H - PAD.top - PAD.bottom} fill="#191d23" />
        <text x={PAD.left - 4} y={PAD.top + 4} textAnchor="end">{hi.toFixed(0)}</text>
        <text x={PAD.left - 4} y={H - PAD.bottom} textAnchor="end">{lo.toFixed(0)}</text>
        <text x={W - PAD.right} y={H - 3} textAnchor="end">{(t1 - t0).toFixed(1)}s</text>
        {action.length > 0 && (
          <path d={line(action)} fill="none" stroke="#5eb0ef" strokeWidth="1" opacity="0.85" />
        )}
        {state.length > 0 && (
          <path d={line(state)} fill="none" stroke="#4ec9a0" strokeWidth="1.2" />
        )}
      </svg>
    </div>
  );
}
