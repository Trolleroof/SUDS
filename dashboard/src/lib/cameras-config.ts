import { readFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_CAMERAS, type CameraSpec } from "./camera-ports";

export type { CameraSpec } from "./camera-ports";
export { DEFAULT_CAMERAS, resolveCameras } from "./camera-ports";

export type CamerasConfigFile = Record<string, number>;

/** Repo-root `config/cameras.json` — edit when OpenCV assigns new indices. */
export function camerasConfigPath(): string {
  const override = process.env.SUDS_CAMERAS_CONFIG;
  if (override) return path.resolve(override.replace(/^~(?=$|\/)/, process.env.HOME ?? ""));
  return path.resolve(process.cwd(), "../config/cameras.json");
}

export function readCamerasConfigFile(): CamerasConfigFile | null {
  try {
    const raw = JSON.parse(readFileSync(camerasConfigPath(), "utf8")) as CamerasConfigFile;
    const entries = Object.entries(raw).filter(
      ([name, index]) => /^[a-z][a-z0-9_]*$/i.test(name) && Number.isInteger(index) && index >= 0,
    );
    if (!entries.length) return null;
    return Object.fromEntries(entries);
  } catch {
    return null;
  }
}

export function readCamerasConfig(): CameraSpec[] {
  const file = readCamerasConfigFile();
  if (!file) return DEFAULT_CAMERAS;
  return Object.entries(file).map(([name, index]) => ({ name, index }));
}
