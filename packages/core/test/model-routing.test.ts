import { describe, expect, it } from "vitest";
import {
  admitModelRouteToBudgets,
  resolveModelRoute,
  validateModelRouteCapabilities,
  diagnoseModelRoutes,
  previewModelMapping,
  type HarnessAdapter,
} from "../src/index.js";

const adapter = {
  capabilities: {
    structuredEvents: true,
    modelSelection: true,
    toolSelection: true,
    cancellation: true,
    blockedInput: true,
    resume: false,
    usage: true,
  },
  async validate() {
    return { valid: true, errors: [] };
  },
} satisfies Pick<HarnessAdapter, "capabilities" | "validate">;

describe("deterministic model routing", () => {
  it("resolves a tier through the effective harness mapping with provenance", () => {
    const result = resolveModelRoute({
      harness: "pi",
      sources: {
        "built-in": {
          modelTiers: { coding: { pi: { model: "old-model" } } },
        },
        project: {
          modelTiers: { coding: { pi: { model: "project-model" } } },
        },
        phase: { modelTier: "coding" },
      },
    });
    expect(result.route).toMatchObject({
      requestedTier: "coding",
      concreteModel: "project-model",
      source: "project",
      mappingPath: "modelTiers.coding.pi",
    });
    expect(result.route.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("gives an explicit concrete model precedence over a tier", () => {
    const result = resolveModelRoute({
      harness: "pi",
      model: "runtime-model",
      modelTier: "fast",
      sources: {
        project: {
          model: "project-model",
          modelTier: "coding",
          modelTiers: { fast: { pi: { model: "fast-model" } } },
        },
      },
    });
    expect(result.route).toMatchObject({
      concreteModel: "runtime-model",
      requestedTier: "fast",
    });
  });

  it("fails closed for a tier without a mapping unless default use is explicit", () => {
    expect(() =>
      resolveModelRoute({
        harness: "pi",
        sources: {
          phase: { modelTier: "reasoning" },
          project: { modelTiers: { reasoning: { pi: {} } } },
        },
      }),
    ).toThrow("no concrete model");

    const result = resolveModelRoute({
      harness: "pi",
      sources: {
        phase: { modelTier: "reasoning" },
        project: {
          modelTiers: {
            reasoning: { pi: { allowHarnessDefault: true } },
          },
        },
      },
    });
    expect(result.route.allowHarnessDefault).toBe(true);
  });

  it("checks required adapter capabilities and budgets without substitution", () => {
    const route = resolveModelRoute({
      harness: "pi",
      model: "coding-model",
    }).route;
    expect(
      validateModelRouteCapabilities(route, adapter, ["structured-events"]),
    ).toMatchObject({ valid: true });
    expect(
      validateModelRouteCapabilities(route, adapter, ["missing-capability"]),
    ).toMatchObject({ valid: false });
    expect(() =>
      admitModelRouteToBudgets({
        route,
        configuration: { phase: { maxTokens: 10, strictUnknown: true } },
        usage: [
          {
            invocationId: "invocation",
            projectId: "project",
            runId: "run",
            phaseId: "planning",
            costQuality: "unknown",
          },
        ],
        target: { projectId: "project", runId: "run", phaseId: "planning" },
      }),
    ).toThrow("fails closed");
  });

  it("exposes unresolved paths and reviewable mapping previews", () => {
    expect(
      diagnoseModelRoutes({
        tiers: ["reasoning", "fast"],
        harnesses: ["pi"],
        sources: {
          project: {
            modelTiers: { reasoning: { pi: { model: "provider/reasoning" } } },
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        tier: "reasoning",
        status: "resolved",
        model: "provider/reasoning",
      }),
      expect.objectContaining({
        tier: "fast",
        status: "unresolved",
        path: "modelTiers.fast.pi",
      }),
    ]);
    expect(
      previewModelMapping({
        tier: "fast",
        harness: "pi",
        model: "provider/fast",
      }),
    ).toMatchObject({ requiresConfirmation: true, path: "modelTiers.fast.pi" });
  });
});
