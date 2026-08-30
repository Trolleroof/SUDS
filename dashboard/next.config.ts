import type { NextConfig } from "next";

import path from "node:path";

const nextConfig: NextConfig = {
  // There is a lockfile in the parent directory too; pin the root explicitly.
  outputFileTracingRoot: path.resolve(process.cwd()),
  // `npm run build` writes to .next-build so it cannot overwrite the chunks a
  // running `npm run dev` is serving out of .next -- that clobbering is what
  // produces "Cannot find module './611.js'".
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // The dataset lives outside the project tree (~/.cache/huggingface/lerobot by
  // default), so nothing here is bundled -- it is all read at request time.
  serverExternalPackages: ["hyparquet", "hyparquet-compressors"],
};

export default nextConfig;
