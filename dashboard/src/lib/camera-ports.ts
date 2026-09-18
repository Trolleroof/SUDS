export type CameraSpec = { name: string; index: number };

/**
 * Only used when `config/cameras.json` cannot be read — it is the source of
 * truth and this must mirror it. Physical mapping for this rig: OpenCV 1 is the
 * wrist (close gripper view), OpenCV 0 is the overhead (wide workspace view).
 */
export const DEFAULT_CAMERAS: CameraSpec[] = [
  { name: "wrist", index: 1 },
  { name: "overhead", index: 0 },
];

/** Display order is semantic — wrist first — and independent of OpenCV index. */
const DISPLAY_ORDER = ["wrist", "overhead"];

export function sortCamerasForDisplay<T>(items: T[], nameOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ai = DISPLAY_ORDER.indexOf(nameOf(a));
    const bi = DISPLAY_ORDER.indexOf(nameOf(b));
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

/** Prefer saved picks, then repo config — order follows config/cameras.json. */
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
