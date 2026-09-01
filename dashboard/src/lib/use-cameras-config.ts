"use client";

import { useCallback, useEffect, useState } from "react";

import { DEFAULT_CAMERAS, type CameraSpec } from "./camera-ports";

let cached: CameraSpec[] | null = null;

/** Load permanent camera names/indices from config/cameras.json (via API). */
export function useCamerasConfig() {
  const [configured, setConfigured] = useState<CameraSpec[]>(cached ?? DEFAULT_CAMERAS);
  const [ready, setReady] = useState(cached !== null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/config/cameras", { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { cameras: CameraSpec[] };
        cached = body.cameras ?? DEFAULT_CAMERAS;
        setConfigured(cached);
      }
    } catch {
      /* offline dev */
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { configured, ready, reload };
}
