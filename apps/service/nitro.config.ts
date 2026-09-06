import { fileURLToPath } from "node:url";
import { defineNitroConfig } from "nitropack/config";

/**
 * The packaged dashboard is served by the same authenticated loopback process
 * as the API, so a consumer installation needs no Vite server. Assets are taken
 * from the dashboard's production build output, which must therefore be built
 * before the service.
 */
const dashboardAssets = fileURLToPath(
  new URL("../dashboard/dist", import.meta.url),
);

export default defineNitroConfig({
  srcDir: "src/server",
  compatibilityDate: "2026-04-02",
  publicAssets: [{ dir: dashboardAssets, baseURL: "/dashboard" }],
  // The service is copied into the published product rather than installed as
  // its own package. Inline its runtime dependencies so Nitro cannot preserve
  // build-machine file URLs that will not exist on a consumer machine. The
  // product manifest still declares these dependencies for the CLI bundle.
  externals: {
    trace: false,
    inline: [
      /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:effect|picomatch|yaml|zod)(?:\/|$)/,
    ],
  },
});
