import { describe, expect, it } from "vitest";
import {
  evaluateUpgradePreflight,
  performServiceUpgrade,
  renderUpgradePreflight,
  type ServiceUpgradeDependencies,
} from "../src/upgrade.js";
import { createProductMetadata } from "../src/product.js";

const installed = createProductMetadata(
  {
    productVersion: "0.2.0",
    sourceCommit: "a".repeat(40),
    sourceDirty: false,
    channel: "stable",
    builtAt: "2026-08-17T00:00:00.000Z",
  },
  {
    apiProtocolVersion: 2,
    stateSchemaVersion: 3,
    compatibleClientRange: ">=0.2.0 <0.3.0",
    piExtensionRange: ">=0.2.0 <0.3.0",
    minimumNodeVersion: "24.0.0",
  },
);

const matchingService = {
  productVersion: "0.2.0",
  sourceCommit: "a".repeat(40),
  apiProtocolVersion: 2,
  stateSchemaVersion: 3,
};

function dependencies(
  overrides: Partial<ServiceUpgradeDependencies> = {},
): ServiceUpgradeDependencies & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hasActiveWork: async () => {
      calls.push("hasActiveWork");
      return false;
    },
    stop: async (force) => {
      calls.push(`stop:${force}`);
    },
    validateNewEntry: async () => {
      calls.push("validateNewEntry");
      return true;
    },
    start: async () => {
      calls.push("start");
    },
    verifyHealth: async () => {
      calls.push("verifyHealth");
      return { ready: true };
    },
    collectDiagnostics: async () => {
      calls.push("collectDiagnostics");
      return ["log line"];
    },
    ...overrides,
  };
}

describe("upgrade preflight", () => {
  it("reports current when the service matches the installed product", () => {
    const preflight = evaluateUpgradePreflight({
      installed,
      runningService: matchingService,
    });
    expect(preflight.outcome).toBe("current");
    expect(preflight.blocked).toBe(false);
    expect(preflight.steps).toEqual([]);
  });

  it("reports restart-only after a patch upgrade replaced product files", () => {
    const preflight = evaluateUpgradePreflight({
      installed,
      runningService: { ...matchingService, productVersion: "0.1.9" },
    });
    expect(preflight.outcome).toBe("restart-only");
    expect(preflight.blocked).toBe(false);
    expect(preflight.steps.map(({ id }) => id)).toEqual([
      "drain-service",
      "start-service",
      "verify-health",
    ]);
  });

  it("detects a changed build identity at the same version", () => {
    const preflight = evaluateUpgradePreflight({
      installed,
      runningService: { ...matchingService, sourceCommit: "b".repeat(40) },
    });
    expect(preflight.outcome).toBe("restart-only");
    expect(
      preflight.findings.find(({ id }) => id === "build-identity")?.status,
    ).toBe("changed");
  });

  it("blocks on API protocol skew", () => {
    const preflight = evaluateUpgradePreflight({
      installed,
      runningService: { ...matchingService, apiProtocolVersion: 1 },
    });
    expect(preflight.outcome).toBe("incompatible");
    expect(preflight.blocked).toBe(true);
    expect(preflight.summary).toContain("cannot safely mutate");
  });

  it("requires migration when a plan has pending migrations", () => {
    const preflight = evaluateUpgradePreflight({
      installed,
      runningService: matchingService,
      migrationPlan: {
        from: 2,
        to: 3,
        migrations: [{ from: 2, to: 3, description: "add cursor field" }],
      },
    });
    expect(preflight.outcome).toBe("migration-required");
    const ids = preflight.steps.map(({ id }) => id);
    // Migration must be previewed and applied before the service restarts.
    expect(ids.indexOf("preview-migration")).toBeLessThan(
      ids.indexOf("apply-migration"),
    );
    expect(ids.indexOf("apply-migration")).toBeLessThan(
      ids.indexOf("start-service"),
    );
  });

  it("treats an empty migration plan as no migration", () => {
    expect(
      evaluateUpgradePreflight({
        installed,
        runningService: matchingService,
        migrationPlan: { from: 3, to: 3, migrations: [] },
      }).outcome,
    ).toBe("current");
  });

  it("refuses a downgrade facing a newer state schema", () => {
    const preflight = evaluateUpgradePreflight({
      installed,
      runningService: matchingService,
      observedStateSchemaVersion: 4,
    });
    expect(preflight.outcome).toBe("downgrade-refused");
    expect(preflight.blocked).toBe(true);
    expect(preflight.steps[0]?.command).toContain("--rollback");
  });

  it("allows an older but supported state schema", () => {
    expect(
      evaluateUpgradePreflight({
        installed,
        runningService: matchingService,
        observedStateSchemaVersion: 2,
      }).outcome,
    ).toBe("current");
  });

  it("reports an unknown service when none is running", () => {
    const preflight = evaluateUpgradePreflight({ installed });
    expect(
      preflight.findings.find(({ id }) => id === "service-version")?.status,
    ).toBe("unknown");
  });

  it("surfaces a stale managed unit as an extra repair step", () => {
    const preflight = evaluateUpgradePreflight({
      installed,
      runningService: { ...matchingService, productVersion: "0.1.9" },
      managedService: [
        { id: "stale-package", detail: "entry missing", remediation: "repair" },
      ],
    });
    expect(preflight.steps.map(({ id }) => id)).toContain(
      "repair-managed-service",
    );
  });

  it("states that project configuration is never rewritten", () => {
    const preflight = evaluateUpgradePreflight({
      installed,
      runningService: matchingService,
      projectConfigVersion: 1,
    });
    expect(
      preflight.findings.find(({ id }) => id === "project-config")?.detail,
    ).toContain("never rewritten");
  });

  it("renders a preview that says nothing has changed", () => {
    const rendered = renderUpgradePreflight(
      evaluateUpgradePreflight({
        installed,
        runningService: { ...matchingService, productVersion: "0.1.9" },
      }),
    );
    expect(rendered).toContain("nothing has been changed");
    expect(rendered).toContain("swf service stop");
  });

  it("marks blocked previews explicitly", () => {
    const rendered = renderUpgradePreflight(
      evaluateUpgradePreflight({
        installed,
        observedStateSchemaVersion: 9,
      }),
    );
    expect(rendered).toContain("Mutations are blocked");
  });
});

describe("controlled service upgrade", () => {
  it("drains and replaces a healthy service", async () => {
    const deps = dependencies();
    const result = await performServiceUpgrade(deps);
    expect(result).toMatchObject({ upgraded: true, forced: false });
    // The new entry is validated before the old service is stopped.
    expect(deps.calls.indexOf("validateNewEntry")).toBeLessThan(
      deps.calls.indexOf("stop:false"),
    );
  });

  it("refuses when the installed product has no valid service entry", async () => {
    const deps = dependencies({ validateNewEntry: async () => false });
    const result = await performServiceUpgrade(deps);
    expect(result.upgraded).toBe(false);
    expect(result.reason).toContain("no valid service entry");
    // The running service must be left untouched.
    expect(deps.calls).not.toContain("stop:false");
  });

  it("refuses to interrupt active work without force", async () => {
    const deps = dependencies({ hasActiveWork: async () => true });
    const result = await performServiceUpgrade(deps);
    expect(result.upgraded).toBe(false);
    expect(result.reason).toContain("--force");
    expect(deps.calls).not.toContain("stop:false");
  });

  it("interrupts active work when forced", async () => {
    const deps = dependencies({ hasActiveWork: async () => true });
    const result = await performServiceUpgrade(deps, { force: true });
    expect(result).toMatchObject({ upgraded: true, forced: true });
    expect(deps.calls).toContain("stop:true");
  });

  it("preserves diagnostics when the replacement never becomes healthy", async () => {
    const deps = dependencies({
      verifyHealth: async () => ({ ready: false, reason: "EADDRINUSE" }),
    });
    const result = await performServiceUpgrade(deps);
    expect(result.upgraded).toBe(false);
    expect(result.reason).toBe("EADDRINUSE");
    expect(result.diagnostics).toEqual(["log line"]);
  });
});
