import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Nitro service foundation", () => {
  it("exposes a versioned health endpoint", () => {
    const route = readFileSync(
      new URL("../src/server/api/health.get.ts", import.meta.url),
      "utf8",
    );
    expect(route).toContain('status: "ok"');
    expect(route).toContain("schemaVersion: 1");
  });

  it("authenticates dashboard pruning and limits browser origins to loopback", () => {
    const pruning = readFileSync(
      new URL("../src/server/api/v1/pruning.post.ts", import.meta.url),
      "utf8",
    );
    const middleware = readFileSync(
      new URL("../src/server/middleware/local-dashboard.ts", import.meta.url),
      "utf8",
    );
    expect(pruning).toContain("service.authenticate(credential)");
    expect(pruning).toContain("statusCode: 401");
    expect(middleware).toContain('"localhost", "127.0.0.1", "::1"');
    expect(middleware).toContain("Dashboard origin must be local");
  });

  it("keeps the service singleton across Nitro hot reloads", () => {
    const runtime = readFileSync(
      new URL("../src/server/runtime.ts", import.meta.url),
      "utf8",
    );
    expect(runtime).toContain("globalThis");
    expect(runtime).toContain("__SWF_SERVICE_RUNTIME__");
  });

  it("terminates the hosting process after authenticated service shutdown", () => {
    const route = readFileSync(
      new URL("../src/server/api/v1/service.post.ts", import.meta.url),
      "utf8",
    );
    expect(route).toContain("service.shutdown");
    expect(route).toContain("process.exit(0)");
  });
});
