/** SUDS-1 arm USB identities — suffix after `/dev/tty.`. */

export const ARM_SERIAL = {
  leader: "usbmodem5C821087231",
  follower: "usbmodem5C821094831",
} as const;

export type ArmRole = "leader" | "follower";

export type ArmPortSelection = {
  teleopPort: string | null;
  robotPort: string | null;
};

export function portPath(serial: string): string {
  return serial.startsWith("/dev/") ? serial : `/dev/tty.${serial}`;
}

export function shortPort(port: string): string {
  return port.replace(/^\/dev\/tty\./, "");
}

/** Last five digits — enough to tell two arms apart in a tight UI. */
export function compactPort(port: string): string {
  const serial = shortPort(port);
  const tail = serial.match(/(\d{5})$/);
  return tail ? tail[1] : serial.length > 10 ? serial.slice(-8) : serial;
}

/** Map a scanned port to a known arm role, if we recognise the serial. */
export function knownRoleForPort(port: string): ArmRole | null {
  const serial = shortPort(port);
  if (!serial) return null;
  if (serial === ARM_SERIAL.leader || serial.endsWith("87231")) return "leader";
  if (serial === ARM_SERIAL.follower || serial.endsWith("94831")) return "follower";
  return null;
}

/**
 * Assign leader/follower when both known serials are plugged in.
 * When `forceKnown` is true (rescan with both present), always apply the mapping.
 */
export function applyKnownArmPorts(
  ports: string[],
  current: ArmPortSelection,
  forceKnown = false,
): ArmPortSelection {
  const leaderPort = ports.find((p) => knownRoleForPort(p) === "leader") ?? null;
  const followerPort = ports.find((p) => knownRoleForPort(p) === "follower") ?? null;

  if (leaderPort && followerPort) {
    return { teleopPort: leaderPort, robotPort: followerPort };
  }

  let teleopPort = current.teleopPort;
  let robotPort = current.robotPort;

  if (leaderPort && (forceKnown || !teleopPort)) teleopPort = leaderPort;
  if (followerPort && (forceKnown || !robotPort)) robotPort = followerPort;

  return { teleopPort, robotPort };
}

export function rolePort(selection: ArmPortSelection, role: ArmRole): string | null {
  return role === "leader" ? selection.teleopPort : selection.robotPort;
}

export function readStoredSetup(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem("suds.setup") ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeStoredSetup(patch: Record<string, unknown>): void {
  try {
    const stored = readStoredSetup();
    window.localStorage.setItem("suds.setup", JSON.stringify({ ...stored, ...patch }));
  } catch {
    /* private browsing */
  }
}

export const DEFAULT_ARM_PORTS: ArmPortSelection = {
  teleopPort: portPath(ARM_SERIAL.leader),
  robotPort: portPath(ARM_SERIAL.follower),
};

/** Prefer saved config, then current selection, then repo defaults. */
export function resolveArmPorts(
  saved: ArmPortSelection,
  configured: ArmPortSelection,
): ArmPortSelection {
  return {
    teleopPort: saved.teleopPort ?? configured.teleopPort,
    robotPort: saved.robotPort ?? configured.robotPort,
  };
}

/**
 * After a USB scan: keep configured ports unless they are absent and a known
 * replacement appeared (macOS reassigned serial names).
 */
export function reconcileArmPorts(
  scanned: string[],
  configured: ArmPortSelection,
): { ports: ArmPortSelection; changed: boolean; missing: string[] } {
  const missing: string[] = [];
  if (configured.teleopPort && !scanned.includes(configured.teleopPort)) missing.push(configured.teleopPort);
  if (configured.robotPort && !scanned.includes(configured.robotPort)) missing.push(configured.robotPort);

  if (missing.length === 0) {
    return { ports: configured, changed: false, missing: [] };
  }

  const mapped = applyKnownArmPorts(scanned, configured, scanned.length >= 2);
  const changed =
    mapped.teleopPort !== configured.teleopPort || mapped.robotPort !== configured.robotPort;
  return { ports: changed ? mapped : configured, changed, missing };
}
