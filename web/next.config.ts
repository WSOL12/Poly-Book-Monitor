import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { NextConfig } from "next";

const here = dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  reactStrictMode: true,
  turbopack: { root: here },
  agentRules: false,
  serverExternalPackages: ["better-sqlite3"],
};

export default config;
