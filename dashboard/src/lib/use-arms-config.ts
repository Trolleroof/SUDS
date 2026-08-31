"use client";

import { useCallback, useEffect, useState } from "react";

import { DEFAULT_ARM_PORTS, type ArmPortSelection } from "./arm-ports";

let cached: ArmPortSelection | null = null;

/** Load permanent leader/follower ports from config/arms.json (via API). */
export function useArmsConfig() {
  const [configured, setConfigured] = useState<ArmPortSelection>(cached ?? DEFAULT_ARM_PORTS);
  const [ready, setReady] = useState(cached !== null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/config/arms", { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as ArmPortSelection;
        cached = { teleopPort: body.teleopPort, robotPort: body.robotPort };
        setConfigured(cached);
      }
    } catch {
      /* offline dev */
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    if (cached) return;
    void reload();
  }, [reload]);

  return { configured, ready, reload };
}
