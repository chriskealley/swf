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
});
