import { join } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: join(import.meta.dirname, "../.."),
  turbopack: { root: join(import.meta.dirname, "../..") },
};

export default nextConfig;
