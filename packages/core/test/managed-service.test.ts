import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MANAGED_SERVICE_LABEL,
  SYSTEMD_UNIT_NAME,
  UnsupportedManagedServiceError,
  applyManagedServicePlan,
  createManagedServicePlan,
  definitionPermissions,
  detectManagedServicePlatform,
  diagnoseManagedService,
  managedServicePaths,
  manualFallbackGuidance,
  previewManagedServiceRepair,
  renderManagedServicePlan,
  uninstallManagedService,
} from "../src/managed-service.js";
import { createServiceLaunchPlan } from "../src/service-launcher.js";

const temporary: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "swf managed "));
  temporary.push(root);
  return root;
}

afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function planFor(
  platform: "launchd" | "systemd",
  overrides: { runAtLoad?: boolean } = {},
) {
  const root = await workspace();
  const serviceHome = join(root, "service-home");
  const entry = join(root, "product", "service", "server", "index.mjs");
  await mkdir(join(entry, ".."), { recursive: true });
  await writeFile(entry, "export default {};\n");
  await mkdir(serviceHome, { recursive: true });
  return {
    root,
    entry,
    serviceHome,
    plan: createManagedServicePlan({
      launch: createServiceLaunchPlan({
        serviceEntry: entry,
        serviceHome,
        port: 34671,
        nodeExecutable: process.execPath,
      }),
      platform,
      home: root,
      runAtLoad: overrides.runAtLoad,
    }),
  };
}

describe("platform detection", () => {
  it("maps supported platforms", () => {
    expect(detectManagedServicePlatform("darwin")).toBe("launchd");
    expect(detectManagedServicePlatform("linux")).toBe("systemd");
    expect(detectManagedServicePlatform("win32")).toBe("unsupported");
  });

  it("refuses to plan on an unsupported platform with fallback guidance", () => {
    expect(() =>
      createManagedServicePlan({
        launch: createServiceLaunchPlan({
          serviceEntry: "/entry.mjs",
          serviceHome: "/home",
          port: 1,
        }),
        platform: "unsupported",
      }),
    ).toThrow(UnsupportedManagedServiceError);
    expect(manualFallbackGuidance().join(" ")).toContain("swf service start");
  });

  it("places definitions in user-scoped locations", () => {
    expect(
      managedServicePaths("launchd", "/home/svc", "/Users/me").definitionPath,
    ).toBe(`/Users/me/Library/LaunchAgents/${MANAGED_SERVICE_LABEL}.plist`);
    expect(
      managedServicePaths("systemd", "/home/svc", "/home/me").definitionPath,
    ).toBe(`/home/me/.config/systemd/user/${SYSTEMD_UNIT_NAME}`);
  });
});

describe("launchd agent", () => {
  it("renders a plist with the argument array and environment", async () => {
    const { plan, entry, serviceHome } = await planFor("launchd");
    expect(plan.definition).toContain("<?xml version");
    expect(plan.definition).toContain(
      `<string>${MANAGED_SERVICE_LABEL}</string>`,
    );
    expect(plan.definition).toContain(`<string>${entry}</string>`);
    expect(plan.definition).toContain(`<string>${serviceHome}</string>`);
    expect(plan.definition).toContain("<key>SWF_SERVICE_HOME</key>");
    expect(plan.definition).toContain("<key>HOST</key>");
    expect(plan.definition).toContain("<string>127.0.0.1</string>");
  });

  it("does not start at login unless explicitly requested", async () => {
    const off = await planFor("launchd");
    expect(off.plan.definition).toContain("<key>RunAtLoad</key>\n    <false/>");
    const on = await planFor("launchd", { runAtLoad: true });
    expect(on.plan.definition).toContain("<key>RunAtLoad</key>\n    <true/>");
  });

  it("uses launchctl for enable and disable", async () => {
    const { plan } = await planFor("launchd");
    expect(plan.enableCommands[0]?.[0]).toBe("launchctl");
    expect(plan.enableCommands[0]).toContain("bootstrap");
    expect(plan.disableCommands[0]).toContain("bootout");
  });
});

describe("systemd unit", () => {
  it("renders a unit with ExecStart, environment, and log destinations", async () => {
    const { plan, entry, serviceHome } = await planFor("systemd");
    expect(plan.definition).toContain("[Unit]");
    // Paths containing spaces must be quoted for systemd.
    expect(plan.definition).toContain(
      `ExecStart=${process.execPath} "${entry}"`,
    );
    expect(plan.definition).toContain(
      `Environment=SWF_SERVICE_HOME=${serviceHome}`,
    );
    expect(plan.definition).toContain("Environment=HOST=127.0.0.1");
    expect(plan.definition).toContain("WantedBy=default.target");
  });

  it("does not restart automatically", async () => {
    const { plan } = await planFor("systemd");
    expect(plan.definition).toContain("Restart=no");
  });

  it("uses systemctl --user for enable and disable", async () => {
    const { plan } = await planFor("systemd");
    expect(plan.enableCommands.every((c) => c[0] === "systemctl")).toBe(true);
    expect(plan.enableCommands.every((c) => c.includes("--user"))).toBe(true);
    expect(plan.disableCommands[0]).toContain("disable");
  });
});

describe("preview before apply", () => {
  it("shows every destination, path, and command", async () => {
    const { plan } = await planFor("launchd");
    const rendered = renderManagedServicePlan(plan);
    expect(rendered).toContain(plan.definitionPath);
    expect(rendered).toContain(plan.standardOutputPath);
    expect(rendered).toContain("start at login no");
    expect(rendered).toContain("commands run only after confirmation");
  });

  it("refuses to write without explicit confirmation", async () => {
    const { plan } = await planFor("systemd");
    await expect(applyManagedServicePlan(plan)).rejects.toThrow(
      "explicit confirmation",
    );
  });

  it("writes a private definition and leaves enablement to the caller", async () => {
    const { plan } = await planFor("systemd");
    const result = await applyManagedServicePlan(plan, { confirmed: true });
    expect(result.written).toBe(true);
    expect(await definitionPermissions(plan.definitionPath)).toBe(0o600);
    // Nothing was enabled or started; the caller must run these.
    expect(result.pendingCommands.length).toBeGreaterThan(0);
    expect(await readFile(plan.definitionPath, "utf8")).toContain("[Unit]");
  });
});

describe("diagnostics", () => {
  it("reports a missing definition", async () => {
    const { plan } = await planFor("launchd");
    expect((await diagnoseManagedService(plan))[0]).toMatchObject({
      id: "definition-missing",
    });
  });

  it("reports a healthy installed definition", async () => {
    const { plan } = await planFor("systemd");
    await applyManagedServicePlan(plan, { confirmed: true });
    expect((await diagnoseManagedService(plan))[0]).toMatchObject({
      id: "healthy",
    });
  });

  it("detects a stale service entry after the package moves", async () => {
    const { plan, entry } = await planFor("systemd");
    await applyManagedServicePlan(plan, { confirmed: true });
    await rm(entry, { force: true });
    const findings = await diagnoseManagedService(plan);
    expect(findings.map(({ id }) => id)).toContain("stale-package");
    expect(findings[0]?.remediation).toContain("--repair");
  });

  it("detects a stale working directory", async () => {
    const { plan, serviceHome } = await planFor("systemd");
    await applyManagedServicePlan(plan, { confirmed: true });
    await rm(serviceHome, { recursive: true, force: true });
    expect((await diagnoseManagedService(plan)).map(({ id }) => id)).toContain(
      "stale-working-directory",
    );
  });

  it("refuses to claim a definition it does not own", async () => {
    const { plan } = await planFor("launchd");
    await mkdir(join(plan.definitionPath, ".."), { recursive: true });
    await writeFile(plan.definitionPath, "<plist>someone else</plist>");
    expect((await diagnoseManagedService(plan))[0]).toMatchObject({
      id: "not-owned",
    });
  });

  it("previews a repair only when one is required", async () => {
    const { plan, entry } = await planFor("systemd");
    await applyManagedServicePlan(plan, { confirmed: true });
    expect((await previewManagedServiceRepair(plan)).required).toBe(false);
    await rm(entry, { force: true });
    const repair = await previewManagedServiceRepair(plan);
    expect(repair.required).toBe(true);
    expect(repair.replacement).toContain("[Unit]");
  });
});

describe("uninstall", () => {
  it("refuses without explicit confirmation", async () => {
    const { plan } = await planFor("systemd");
    await expect(uninstallManagedService(plan)).rejects.toThrow(
      "explicit confirmation",
    );
  });

  it("removes only the owned definition and preserves state", async () => {
    const { plan, serviceHome } = await planFor("systemd");
    await applyManagedServicePlan(plan, { confirmed: true });
    await writeFile(join(serviceHome, "service.json"), "{}");

    const result = await uninstallManagedService(plan, { confirmed: true });
    expect(result.removed).toBe(true);
    expect(result.preservedPaths).toContain(serviceHome);
    // Service uninstall is not state uninstall.
    expect((await stat(join(serviceHome, "service.json"))).isFile()).toBe(true);
  });

  it("never removes a definition it does not own", async () => {
    const { plan } = await planFor("launchd");
    await mkdir(join(plan.definitionPath, ".."), { recursive: true });
    await writeFile(plan.definitionPath, "<plist>someone else</plist>");
    await expect(
      uninstallManagedService(plan, { confirmed: true }),
    ).rejects.toThrow("not an SWF-owned definition");
    expect((await stat(plan.definitionPath)).isFile()).toBe(true);
  });

  it("reports nothing removed when no definition exists", async () => {
    const { plan } = await planFor("systemd");
    expect(
      await uninstallManagedService(plan, { confirmed: true }),
    ).toMatchObject({ removed: false });
  });
});
