"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { DatasetPayload, EpisodeRow, Label, Verdict } from "@/lib/api-types";
import { useRecorder } from "@/lib/use-recorder";

import CalibrationPanel from "./CalibrationPanel";
import CommandBar from "./CommandBar";
import DashboardTabs from "./DashboardTabs";
import DaemonPanel from "./DaemonPanel";
import EpisodeList from "./EpisodeList";
import HealthPanel from "./HealthPanel";
import LabelBar from "./LabelBar";
import LiveCameras from "./LiveCameras";
import RecordBar from "./RecordBar";
import SafetyBar from "./SafetyBar";
import SlamPanel from "./SlamPanel";
import StatsStrip from "./StatsStrip";
import TracePanel from "./TracePanel";
import VideoPanel from "./VideoPanel";

type Filter = "all" | "unlabeled" | "pass" | "discard";

/**
 * Two jobs, two screens.
 *
 * "Live" is what you look at with a leader arm in your hand: the arms, the
 * cameras pointing at them right now, and the stop. "Review" is what you look at
 * afterwards, with both hands free. Sharing one scroll made the live cameras sit
 * above a *recording* of a camera, which is the one confusion worth designing
 * out -- when the arm is moving you must never wonder whether the picture is
 * from now.
 */
type View = "live" | "review";

export default function Dashboard({
  datasets: initial,
  root,
  initialView = "live",
}: {
  datasets: string[];
  root: string;
  initialView?: View;
}) {
  const [datasets, setDatasets] = useState(initial);
  const [repoId, setRepoId] = useState(initial[0] ?? "");
  // The daemon may be recording into a dataset that did not exist when the page
  // was served; follow it rather than making the user find it in the picker.
  const [followed, setFollowed] = useState(false);
  const [data, setData] = useState<DatasetPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [view, setView] = useState<View>(initialView);

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

  const saveLabel = useCallback(
    async (episode: EpisodeRow, verdict: Verdict, patch: { notes?: string | null } = {}) => {
      const previous = episode.label;
      const res = await fetch("/api/label", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo_id: repoId,
          episode_index: episode.episode_index,
          verdict,
          // Relabelling should not silently drop the notes already written.
          notes: patch.notes !== undefined ? patch.notes : previous?.notes ?? null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "failed to save label");
    },
    [repoId],
  );

  // Labelling is an append-only write. Update this screen immediately instead
  // of blocking the next video on the expensive full-dataset refresh.
  const labelEpisode = useCallback(
    (episode: EpisodeRow, verdict: Verdict, patch: { notes?: string | null } = {}) => {
      const label: Label = {
        episode_index: episode.episode_index,
        verdict,
        notes: patch.notes !== undefined ? patch.notes : episode.label?.notes ?? null,
        labeled_at: new Date().toISOString(),
      };
      setData((previous) =>
        previous
          ? { ...previous, episodes: previous.episodes.map((row) => (row.episode_index === label.episode_index ? { ...row, label } : row)) }
          : previous,
      );
      void saveLabel(episode, verdict, patch).catch((error: unknown) => {
        setError((error as Error).message);
        void refresh();
      });
    },
    [refresh, saveLabel],
  );

  const label = useCallback(
    async (verdict: Verdict, patch: { notes?: string | null } = {}) => {
      if (!current) return;
      const at = visible.findIndex((episode) => episode.episode_index === current.episode_index);
      const next = visible[at + 1] ?? visible[at - 1];
      labelEpisode(current, verdict, patch);
      if (next) setSelected(next.episode_index);
    },
    [current, labelEpisode, visible],
  );

  // A discard is excluded from the "all" list and from anything the finetune
  // pipeline reads, but nothing on disk is touched -- reversible from "discarded".
  const deleteEpisode = useCallback(
    (index: number) => {
      const episode = episodes.find((e) => e.episode_index === index);
      if (episode) labelEpisode(episode, "discard");
    },
    [episodes, labelEpisode],
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

  const recorderUp = Boolean(recorder.status && !recorder.status.offline);
  const recording = recorder.status?.state === "recording";

  return (
    <div className="app">
      <header className="header">
        <span className="brand">SUDS</span>
        <DashboardTabs
          current={view}
          liveDot={recorderUp ? (recording ? "fail" : "ok") : null}
          reviewCount={episodes.length}
          onLive={() => setView("live")}
          onReview={() => setView("review")}
        />
        <select className="picker" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
          {datasets.length === 0 && <option value="">no datasets</option>}
          {datasets.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <HealthPanel recorder={recorder} />
        <StatsStrip data={data} />
      </header>

      <div className="body">
        {view === "review" && (
        <aside className="sidebar">
          <div className="filters">
            {(["all", "unlabeled", "pass", "discard"] as Filter[]).map((f) => (
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
          <EpisodeList
            episodes={visible}
            selected={current?.episode_index ?? -1}
            onSelect={setSelected}
            onDelete={deleteEpisode}
          />
        </aside>
        )}

        <main className="main">
          {view === "live" ? (
            <>
              <CommandBar recorderRunning={recorderUp} />
              <DaemonPanel
                repoId={repoId}
                videoKeys={data?.video_keys ?? []}
                recorderOnline={recorderUp}
                onChanged={refresh}
              />

              <div className="toolbar">
                <SafetyBar recorder={recorder} />
                <RecordBar recorder={recorder} />
              </div>

              <LiveCameras recorder={recorder} />
              <CalibrationPanel recorderOnline={recorderUp} />
              {!recorderUp && (
                <p className="empty">
                  Press Record to start the recorder and sync the arms, or open Setup above to configure it first.
                </p>
              )}
            </>
          ) : (
            <>
              {!datasets.length && (
                <p className="empty">
                  No datasets under <code>{root}</code>.
                </p>
              )}
              {error && <p className="empty">{error}</p>}
              {current && data && (
                <>
                  <VideoPanel repoId={repoId} episode={current} videoKeys={data.video_keys} />
                  <SlamPanel repoId={repoId} episodeIndex={current.episode_index} />
                  <LabelBar episode={current} onLabel={label} />
                  <TracePanel repoId={repoId} episode={current} data={data} />
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function matches(episode: EpisodeRow, filter: Filter): boolean {
  if (filter === "all") return episode.label?.verdict !== "discard";
  if (filter === "unlabeled") return episode.label === null;
  return episode.label?.verdict === filter;
}
