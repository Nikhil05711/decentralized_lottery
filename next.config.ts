import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Skip static optimization to prevent localStorage access during build
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
