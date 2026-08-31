import { readFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_ARM_PORTS, type ArmPortSelection } from "./arm-ports";

export type ArmsConfigFile = {
  leader: string;
  follower: string;
};

/** Repo-root `config/arms.json` — edit when macOS assigns new serial names. */
export function armsConfigPath(): string {
  const override = process.env.SUDS_ARMS_CONFIG;
  if (override) return path.resolve(override.replace(/^~(?=$|\/)/, process.env.HOME ?? ""));
  return path.resolve(process.cwd(), "../config/arms.json");
}

export function readArmsConfigFile(): ArmsConfigFile | null {
  try {
    const raw = JSON.parse(readFileSync(armsConfigPath(), "utf8")) as Partial<ArmsConfigFile>;
    if (raw.leader && raw.follower) return { leader: raw.leader, follower: raw.follower };
    return null;
  } catch {
    return null;
  }
}

export function readArmsConfig(): ArmPortSelection {
  const file = readArmsConfigFile();
  if (!file) return DEFAULT_ARM_PORTS;
  return { teleopPort: file.leader, robotPort: file.follower };
}
