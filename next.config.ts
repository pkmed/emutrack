import type { NextConfig } from "next";

/**
 * Two build modes:
 * - Default (dev server / sandbox / node hosting): standalone server output.
 * - STATIC_EXPORT=1: pure static export for static hosts such as GitHub Pages.
 *   Set BASE_PATH (e.g. "/emutrack") when the site is served from a sub-path
 *   (project pages: <user>.github.io/<repo>/); leave it unset for user/org
 *   root sites (<user>.github.io).
 */
const isStaticExport = process.env.STATIC_EXPORT === "1";
const basePath = (process.env.BASE_PATH ?? "").replace(/\/+$/, "");

const nextConfig: NextConfig = isStaticExport
  ? {
      output: "export",
      basePath,
      images: { unoptimized: true },
      typescript: { ignoreBuildErrors: true },
      reactStrictMode: false,
    }
  : {
      output: "standalone",
      typescript: { ignoreBuildErrors: true },
      reactStrictMode: false,
    };

export default nextConfig;
