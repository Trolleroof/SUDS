"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { DatasetPayload, EpisodeRow, Verdict } from "@/lib/api-types";
import { useRecorder } from "@/lib/use-recorder";

import CalibrationPanel from "./CalibrationPanel";
import DaemonPanel from "./DaemonPanel";
import EpisodeList from "./EpisodeList";
import HealthPanel from "./HealthPanel";
import LabelBar from "./LabelBar";
import LiveCameras from "./LiveCameras";
import RecordBar from "./RecordBar";
import SafetyBar from "./SafetyBar";
import StatsStrip from "./StatsStrip";
import TracePanel from "./TracePanel";
import VideoPanel from "./VideoPanel";

type Filter = "all" | "unlabeled" | "pass" | "fail";

export default function Dashboard({ datasets: initial, root }: { datasets: string[]; root: string }) {
  const [datasets, setDatasets] = useState(initial);
  const [repoId, setRepoId] = useState(initial[0] ?? "");
  // The daemon may be recording into a dataset that did not exist when the page
  // was served; follow it rather than making the user find it in the picker.
  const [followed, setFollowed] = useState(false);
  const [data, setData] = useState<DatasetPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");

  const refresh = useCallback(async () => {
    void fetch("/api/datasets", { cache: "no-store" })
      .then((r) => r.json())
      .then((body) => setDatasets(body.datasets ?? []));
    if (!repoId) return;
    const res = await fetch(`/api/dataset?repo_id=${encodeURIComponent(repoId)}`);
    const body = await res.json();
    if (!res.ok) {
      setError(body.error ?? "failed to load dataset");
      setData(null);
      return;
    }
    setError(null);
    setData(body as DatasetPayload);
  }, [repoId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const follow = useCallback(
    (id: string) => {
      if (followed) return;
      setFollowed(true);
      setRepoId(id);
    },
    [followed],
  );

  // One poll of the recorder daemon feeds the kill switch, the live cameras,
  // the calibration wizard, the record bar and the power panel.
  const recorder = useRecorder({ onEpisodeSaved: refresh, onRepoId: follow });

  const episodes = data?.episodes ?? [];
  const visible = useMemo(() => episodes.filter((e) => matches(e, filter)), [episodes, filter]);
  const current = visible.find((e) => e.episode_index === selected) ?? visible[0] ?? null;

  // Keep the selection inside the filtered set when the filter changes.
  useEffect(() => {
    if (visible.length && !visible.some((e) => e.episode_index === selected)) {
      setSelected(visible[0].episode_index);
    }
  }, [visible, selected]);

  const step = useCallback(
    (delta: number) => {
      if (!visible.length) return;
      const at = visible.findIndex((e) => e.episode_index === selected);
      const next = Math.min(visible.length - 1, Math.max(0, (at === -1 ? 0 : at) + delta));
      setSelected(visible[next].episode_index);
    },
    [visible, selected],
  );

  const label = useCallback(
    async (verdict: Verdict, patch: { failure_mode?: string | null; notes?: string | null } = {}) => {
      if (!current) return;
      const previous = current.label;
      await fetch("/api/label", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo_id: repoId,
          episode_index: current.episode_index,
          verdict,
          // Relabelling should not silently drop the notes already written.
          failure_mode: patch.failure_mode !== undefined ? patch.failure_mode : previous?.failure_mode ?? null,
          notes: patch.notes !== undefined ? patch.notes : previous?.notes ?? null,
        }),
      });
      await refresh();
    },
    [current, repoId, refresh],
  );

  // The point of the tool is labelling 50 episodes without touching the mouse.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const handlers: Record<string, () => void> = {
        j: () => step(1),
        k: () => step(-1),
        ArrowDown: () => step(1),
        ArrowUp: () => step(-1),
        p: () => void label("pass"),
        f: () => void label("fail"),
        d: () => void label("discard"),
      };
      const handler = handlers[event.key];
      if (!handler) return;
      event.preventDefault();
      handler();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, label]);

  return (
    <div className="app">
      <header className="header">
        <span className="brand">SUDS · episode review</span>
        <select className="picker" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
          {datasets.length === 0 && <option value="">no datasets found</option>}
          {datasets.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <StatsStrip data={data} />
      </header>

      <div className="body">
        <aside className="sidebar">
          <div className="filters">
            {(["all", "unlabeled", "pass", "fail"] as Filter[]).map((f) => (
              <button
                key={f}
                className="chip"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
          <EpisodeList episodes={visible} selected={current?.episode_index ?? -1} onSelect={setSelected} />
        </aside>

        <main className="main">
          <DaemonPanel
            repoId={repoId}
            videoKeys={data?.video_keys ?? []}
            recorderOnline={Boolean(recorder.status && !recorder.status.offline)}
            onChanged={refresh}
          />
          <SafetyBar recorder={recorder} />
          <LiveCameras recorder={recorder} />
          <RecordBar recorder={recorder} />
          <CalibrationPanel recorder={recorder} />
          <HealthPanel recorder={recorder} />
          {!datasets.length && (
            <p className="empty">
              No LeRobot datasets under <code>{root}</code>.<br />
              Record one, or point <code>SUDS_DATASET_ROOT</code> somewhere else.
            </p>
          )}
          {error && <p className="empty">{error}</p>}
          {current && data && (
            <>
              <VideoPanel repoId={repoId} episode={current} videoKeys={data.video_keys} />
              <LabelBar episode={current} onLabel={label} />
              <TracePanel repoId={repoId} episode={current} data={data} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function matches(episode: EpisodeRow, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "unlabeled") return episode.label === null;
  return episode.label?.verdict === filter;
}
