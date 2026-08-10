import { describe, expect, it } from "vitest";
import {
  buildPhasePrompt,
  phaseContractFor,
  phaseMutationBoundaryViolations,
} from "../src/index.js";

describe("structured phase contracts", () => {
  it("gives each default phase distinct responsibilities and limits", () => {
    const planning = phaseContractFor("planning");
    const reviewing = phaseContractFor("reviewing");
    const verifying = phaseContractFor("verifying");
    expect(planning.prohibitedActions).toContain("merge");
    expect(reviewing.objective).toContain("code review");
    expect(verifying.objective).toContain("OpenSpec task");
    expect(verifying.prohibitedActions).toContain(
      "repeat unconstrained code review",
    );
  });

  it("builds bounded deterministic prompts and excludes raw or stale evidence", () => {
    const result = buildPhasePrompt({
      contract: phaseContractFor("building"),
      phaseId: "building",
      runId: "run",
      changeName: "add-feature",
      cwd: "/worktree",
      guidelines: "project guidance",
      openspecContext: "tasks.md",
      evidence: [
        { ref: "artifacts/current.json", valid: true, summary: "current" },
        { ref: "raw/transcript.log", raw: true, valid: true },
        { ref: "artifacts/stale.json", valid: false },
      ],
      maxLength: 1_000,
    });
    expect(result.prompt.length).toBeLessThanOrEqual(1_000);
    expect(result.evidenceRefs).toEqual(["artifacts/current.json"]);
    expect(result.excludedEvidenceRefs).toEqual([
      "raw/transcript.log",
      "artifacts/stale.json",
    ]);
    expect(result.prompt).toContain("Prohibited actions");
    expect(result.contractFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("enforces distinct mutation boundaries", () => {
    expect(
      phaseMutationBoundaryViolations("planning", [
        "openspec/changes/x/design.md",
        "src/app.ts",
      ]),
    ).toEqual(["src/app.ts"]);
    expect(
      phaseMutationBoundaryViolations("reviewing", ["src/app.ts"]),
    ).toEqual(["src/app.ts"]);
    expect(
      phaseMutationBoundaryViolations("building", [
        "openspec/changes/archive/x/proposal.md",
        "src/app.ts",
      ]),
    ).toEqual(["openspec/changes/archive/x/proposal.md"]);
  });
});
