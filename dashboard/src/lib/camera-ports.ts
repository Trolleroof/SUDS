export type CameraSpec = { name: string; index: number };

export const DEFAULT_CAMERAS: CameraSpec[] = [
  { name: "overhead", index: 0 },
  { name: "wrist", index: 1 },
];

/** Prefer saved picks, then repo config — always include every camera from config/cameras.json. */
export function resolveCameras(stored: CameraSpec[] | null | undefined, configured: CameraSpec[]): CameraSpec[] {
  if (!configured.length) return stored?.length ? stored : DEFAULT_CAMERAS;
  if (!stored?.length) return configured;

  const byName = new Map(stored.map((camera) => [camera.name, camera]));
  const merged = configured.map((camera) => byName.get(camera.name) ?? camera);

  for (const camera of stored) {
    if (!merged.some((entry) => entry.name === camera.name)) merged.push(camera);
  }
  return merged;
}
