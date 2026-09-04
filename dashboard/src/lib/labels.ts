import fs from "node:fs/promises";
import path from "node:path";

import { labelsFile } from "./paths";

export const VERDICTS = ["pass", "discard"] as const;
export type Verdict = (typeof VERDICTS)[number];

export type Label = {
  episode_index: number;
  verdict: Verdict;
  notes?: string | null;
  labeled_at: string;
};

/**
 * Append-only JSONL: last line for an episode wins. Nothing is ever rewritten,
 * so a relabel is a single `write()` with no read-modify-write race, and the
 * file doubles as a history of how your judgement changed.
 */
export async function readLabels(repoId: string): Promise<Map<number, Label>> {
  const out = new Map<number, Label>();
  let text: string;
  try {
    text = await fs.readFile(labelsFile(repoId), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as { episode_index: number; verdict: string; notes?: string | null; labeled_at: string };
      let verdict: Verdict;
      if (raw.verdict === "pass") verdict = "pass";
      else if (raw.verdict === "discard" || raw.verdict === "fail") verdict = "discard";
      else continue;
      const label: Label = {
        episode_index: raw.episode_index,
        verdict,
        notes: raw.notes ?? null,
        labeled_at: raw.labeled_at,
      };
      out.set(label.episode_index, label);
    } catch {
      // A torn final line (killed mid-write) should not blank the dashboard.
    }
  }
  return out;
}

export async function appendLabel(repoId: string, label: Label): Promise<void> {
  const file = labelsFile(repoId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(label) + "\n", "utf8");
}
