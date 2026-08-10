import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTaskAudit,
  discoverProjectChecks,
  inspectTemplateDiff,
  phaseContractFor,
  resolveModelRoute,
} from "../packages/core/src/index.ts";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

describe("execution-defaults acceptance", () => {
  it("routes agent phases statically and leaves Releasing agent-free", () => {
    const mappings = {
      reasoning: { pi: { model: "provider/reasoning" } },
      coding: { pi: { model: "provider/coding" } },
      fast: { pi: { model: "provider/fast" } },
    };
    expect(
      resolveModelRoute({
        harness: "pi",
        modelTier: "reasoning",
        sources: { project: { modelTiers: mappings } },
      }).route.concreteModel,
    ).toBe("provider/reasoning");
    expect(
      resolveModelRoute({
        harness: "pi",
        modelTier: "coding",
        sources: { project: { modelTiers: mappings } },
      }).route.concreteModel,
    ).toBe("provider/coding");
    expect(
      resolveModelRoute({
        harness: "pi",
        modelTier: "fast",
        sources: { project: { modelTiers: mappings } },
      }).route.concreteModel,
    ).toBe("provider/fast");
    expect(phaseContractFor("releasing").prohibitedActions).toContain("merge");
  });

  it("keeps review distinct from task verification and keeps discovery/default inspection read-only", async () => {
    expect(phaseContractFor("reviewing").objective).not.toBe(
      phaseContractFor("verifying").objective,
    );
    const root = await mkdtemp(join(tmpdir(), "swf-defaults-e2e-"));
    roots.push(root);
    const packageContents = JSON.stringify({ scripts: { test: "echo test" } });
    await writeFile(join(root, "package.json"), packageContents);
    const discovered = await discoverProjectChecks(root);
    expect(discovered.candidates[0]).toMatchObject({
      proposedPhase: "verifying",
      command: "pnpm run test",
    });
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(
      packageContents,
    );
    await writeFile(join(root, "profile.yaml"), "project\n");
    const diff = await inspectTemplateDiff({
      configDirectory: root,
      adopted: undefined,
      installed: { "profile.yaml": "installed\n" },
    });
    expect(diff[0]?.status).toBe("conflict");
    expect(await readFile(join(root, "profile.yaml"), "utf8")).toBe(
      "project\n",
    );
    const audit = buildTaskAudit({
      tasksContents: "- [x] 1.1 Done\n",
      tasksPath: "tasks.md",
      sourceCommit: "abc",
      implementationRefs: ["src/app.ts"],
      checks: [
        {
          checkId: "test",
          type: "command",
          required: true,
          status: "passed",
          deterministic: true,
          createdAt: new Date().toISOString(),
          summary: "passed",
        },
      ],
    });
    expect(audit.status).toBe("verified");
  });
});
