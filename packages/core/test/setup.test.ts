import { describe, expect, it, vi } from "vitest";
import { applySetupPlan, createSetupPlan } from "../src/setup.js";

describe("setup plans", () => {
  it("previews Herdr integration installation without executing it", () => {
    const plan = createSetupPlan(["herdr-integration:pi"]);
    expect(plan).toEqual({
      actions: [
        expect.objectContaining({
          command: "herdr",
          args: ["integration", "install", "pi"],
        }),
      ],
      unsupported: [],
    });
  });

  it("only executes actions after explicit confirmation", async () => {
    const plan = createSetupPlan(["pi"]);
    const execute = vi.fn(async () => ({
      code: 0,
      stdout: "installed",
      stderr: "",
    }));
    const result = await applySetupPlan(plan, {
      confirm: async () => false,
      execute,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ applied: false });
  });

  it("records successful explicitly confirmed installation", async () => {
    const plan = createSetupPlan(["herdr-integration:pi"]);
    const execute = vi.fn(async () => ({
      code: 0,
      stdout: "installed",
      stderr: "",
    }));
    const result = await applySetupPlan(plan, {
      confirm: async () => true,
      execute,
    });

    expect(execute).toHaveBeenCalledWith("herdr", [
      "integration",
      "install",
      "pi",
    ]);
    expect(result.results[0]).toMatchObject({ applied: true, code: 0 });
  });

  it("plans platform-specific GitHub CLI installation", () => {
    expect(createSetupPlan(["gh"], "darwin").actions[0]).toMatchObject({
      command: "brew",
      args: ["install", "gh"],
    });
    expect(createSetupPlan(["gh"], "win32").unsupported).toEqual(["gh"]);
  });
});
