import { describe, expect, it } from "vitest";
import {
  buildTaskAudit,
  normalizeTaskText,
  parseOpenSpecTasks,
} from "../src/index.js";

describe("OpenSpec task verification", () => {
  it("parses stable task identifiers and normalized checkbox state", () => {
    const tasks = parseOpenSpecTasks(
      "## Build\n\n- [x] 1.1 Add  a thing\n- [ ] 1.2 Finish it\n",
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      checked: true,
      text: "Build: 1.1 Add a thing",
    });
    expect(tasks[0]!.taskId).toMatch(/^1\.1:/);
    expect(normalizeTaskText("  lots   of whitespace ")).toBe(
      "lots of whitespace",
    );
  });

  it("fails closed for unchecked tasks and succeeds only with current evidence", () => {
    const incomplete = buildTaskAudit({
      tasksContents: "- [x] 1.1 Done\n- [ ] 1.2 Missing\n",
      tasksPath: "openspec/changes/example/tasks.md",
      sourceCommit: "abc",
      implementationRefs: ["src/example.ts"],
      checks: [],
    });
    expect(incomplete.status).toBe("failed");
    expect(incomplete.entries[1]!.conclusion).toBe("unverified");

    const complete = buildTaskAudit({
      tasksContents: "- [x] 1.1 Done\n",
      tasksPath: "openspec/changes/example/tasks.md",
      sourceCommit: "abc",
      implementationRefs: ["src/example.ts"],
      checks: [
        {
          checkId: "unit",
          type: "command",
          required: true,
          status: "passed",
          deterministic: true,
          createdAt: new Date().toISOString(),
          summary: "passed",
          artifact: {
            schemaVersion: 1,
            artifactId: "8c86919c-3569-4e97-9f09-1bba7b49ed3d",
            runId: "8c86919c-3569-4e97-9f09-1bba7b49ed3d",
            type: "command-result",
            phaseId: "verifying",
            sourceCommit: "abc",
            inputFingerprint: "input",
            status: "valid",
            createdAt: new Date().toISOString(),
            outputRef: "artifacts/unit.json",
            consumers: [],
          },
        },
      ],
    });
    expect(complete.status).toBe("verified");
    expect(complete.entries[0]!.conclusion).toBe("verified");
  });

  it("requires current evidence for actionable review findings", () => {
    const review = {
      summary: "one finding",
      findings: [
        {
          id: "security-1",
          severity: "blocking" as const,
          title: "Issue",
          detail: "Fix it",
          artifactIds: [],
        },
      ],
    };
    const unresolved = buildTaskAudit({
      tasksContents: "- [x] 1.1 Done\n",
      tasksPath: "tasks.md",
      sourceCommit: "abc",
      implementationRefs: ["src/example.ts"],
      review,
    });
    expect(unresolved.status).toBe("failed");
    const resolved = buildTaskAudit({
      tasksContents: "- [x] 1.1 Done\n",
      tasksPath: "tasks.md",
      sourceCommit: "abc",
      implementationRefs: ["src/example.ts"],
      review,
      reviewResolutions: [
        {
          findingId: "security-1",
          status: "resolved",
          evidenceArtifactIds: ["8c86919c-3569-4e97-9f09-1bba7b49ed3d"],
          sourceCommit: "abc",
        },
      ],
    });
    expect(resolved.status).toBe("verified");
  });
});
