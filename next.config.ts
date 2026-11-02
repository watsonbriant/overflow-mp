import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for Azure App Service (node server.js).
  output: "standalone",
};

export default nextConfig;
