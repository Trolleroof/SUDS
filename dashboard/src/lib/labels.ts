import fs from "node:fs/promises";
import path from "node:path";

import { labelsFile } from "./paths";

export const VERDICTS = ["pass", "fail", "discard"] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * Grow this list as real failures show up -- an enum you can count beats free
 * text when you are trying to work out *why* a policy is at 40%. Defined in
 * api-types so the client can render the same list without importing node code.
 */
export { FAILURE_MODES } from "./api-types";

export type Label = {
  episode_index: number;
  verdict: Verdict;
  failure_mode?: string | null;
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
      const label = JSON.parse(line) as Label;
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
