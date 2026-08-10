import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertChecksAdopted,
  discoverProjectChecks,
  previewCheckAdoption,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("read-only check discovery", () => {
  it("discovers scripts without executing or changing the manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-discovery-"));
    roots.push(root);
    const packagePath = join(root, "package.json");
    const contents = JSON.stringify({
      scripts: { test: "echo test", lint: "echo lint", deploy: "rm -rf /" },
    });
    await writeFile(packagePath, contents);
    const result = await discoverProjectChecks(root);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      command: "pnpm run test",
      proposedPhase: "verifying",
      required: true,
    });
    expect(await readFile(packagePath, "utf8")).toBe(contents);
  });

  it("previews selective adoption and fails closed when no required checks exist", () => {
    const candidate = {
      id: "test-package",
      command: "pnpm run test",
      source: "package.json",
      proposedPhase: "verifying" as const,
      cwd: "/repo",
      timeoutMs: 1000,
      required: true,
      rationale: "test",
    };
    expect(previewCheckAdoption([candidate], [candidate.id])).toMatchObject({
      requiresConfirmation: true,
      writes: [{ phase: "verifying", command: "pnpm run test" }],
    });
    expect(() =>
      assertChecksAdopted({ expectedCodeVerification: true, checks: [] }),
    ).toThrow("Verification gap");
  });
});
