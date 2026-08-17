import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLEANUP_SCOPES,
  CleanupConfirmationError,
  PRESERVED_ALWAYS,
  applyCleanup,
  discardCleanupPreview,
  loadCleanupPreview,
  persistCleanupPreview,
  previewCleanup,
  renderCleanupPreview,
} from "../src/cleanup.js";
import { diagnoseOrphanedManagedService } from "../src/managed-service.js";

const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

/** A populated user service home plus two projects, only one of them selected. */
async function environment(): Promise<{
  serviceHome: string;
  selectedProject: string;
  otherProject: string;
  checkoutRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "swf-cleanup-"));
  temporary.push(root);
  const serviceHome = join(root, "service-home");
  const selectedProject = join(root, "project-a", ".swf-state");
  const otherProject = join(root, "project-b", ".swf-state");
  const checkoutRoot = join(root, "checkout");

  for (const directory of [
    join(serviceHome, "logs"),
    join(serviceHome, "cache"),
    selectedProject,
    otherProject,
    join(checkoutRoot, ".swf-dev", "default"),
    join(root, "project-a", ".swf"),
    join(root, "project-a", ".git"),
  ])
    await mkdir(directory, { recursive: true });

  await writeFile(join(serviceHome, "service.json"), '{"credential":"s"}');
  await writeFile(join(serviceHome, "service.lock"), "{}");
  await writeFile(join(serviceHome, "projects.json"), "{}");
  await writeFile(join(serviceHome, "trusted-projects.json"), "{}");
  await writeFile(join(serviceHome, "audit.jsonl"), "audit\n");
  await writeFile(join(serviceHome, "logs", "service.log"), "log\n");
  await writeFile(join(serviceHome, "cache", "entry"), "c");
  await writeFile(join(selectedProject, "run.json"), "{}");
  await writeFile(join(otherProject, "run.json"), "{}");
  await writeFile(join(root, "project-a", ".swf", "config.yaml"), "id: a\n");
  await writeFile(join(root, "project-a", ".git", "HEAD"), "ref: main\n");
  await writeFile(join(checkoutRoot, ".swf-dev", "default", "x"), "d");

  return { serviceHome, selectedProject, otherProject, checkoutRoot };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("cleanup preview", () => {
  it("removes nothing while previewing", async () => {
    const { serviceHome } = await environment();
    const before = await readdir(serviceHome);
    await previewCleanup({ serviceHome, scopes: [...CLEANUP_SCOPES] });
    expect(await readdir(serviceHome)).toEqual(before);
  });

  it("lists ownership, effect, and size for every candidate", async () => {
    const { serviceHome } = await environment();
    const preview = await previewCleanup({ serviceHome, scopes: ["logs"] });
    const entry = preview.candidates.find(({ exists }) => exists);
    expect(entry?.ownership).toBeTruthy();
    expect(entry?.effect).toBeTruthy();
    expect(entry?.bytes).toBeGreaterThan(0);
  });

  it("scopes are independent and never imply one another", async () => {
    const { serviceHome } = await environment();
    const logs = await previewCleanup({ serviceHome, scopes: ["logs"] });
    expect(logs.candidates.every(({ scope }) => scope === "logs")).toBe(true);
    expect(
      logs.candidates.some(({ path }) => path.endsWith("service.json")),
    ).toBe(false);
  });

  it("preserves audit history and Git configuration", async () => {
    const { serviceHome } = await environment();
    const preview = await previewCleanup({
      serviceHome,
      scopes: [...CLEANUP_SCOPES],
    });
    expect(preview.preserved.some((p) => p.endsWith("audit.jsonl"))).toBe(true);
    expect(PRESERVED_ALWAYS.join(" ")).toContain(".git/");
    expect(PRESERVED_ALWAYS.join(" ")).toContain(".swf/");
  });

  it("lists unselected project state as preserved", async () => {
    const { serviceHome, selectedProject, otherProject } = await environment();
    const preview = await previewCleanup({
      serviceHome,
      scopes: ["project-state"],
      selectedProjectStateDirectories: [selectedProject],
      knownProjectStateDirectories: [selectedProject, otherProject],
    });
    expect(preview.candidates.map(({ path }) => path)).toEqual([
      selectedProject,
    ]);
    expect(preview.preserved).toContain(otherProject);
  });

  it("warns when project-state is scoped but nothing is selected", async () => {
    const { serviceHome } = await environment();
    const preview = await previewCleanup({
      serviceHome,
      scopes: ["project-state"],
    });
    expect(preview.candidates).toEqual([]);
    expect(preview.warnings.join(" ")).toContain("no project was chosen");
  });

  it("warns that removing credentials also removes recorded trust", async () => {
    const { serviceHome } = await environment();
    const preview = await previewCleanup({
      serviceHome,
      scopes: ["credentials"],
    });
    expect(preview.warnings.join(" ")).toContain("trusted again");
  });

  it("renders a preview that says nothing was removed", async () => {
    const { serviceHome } = await environment();
    const rendered = renderCleanupPreview(
      await previewCleanup({ serviceHome, scopes: ["logs"] }),
    );
    expect(rendered).toContain("Nothing has been removed");
    expect(rendered).toContain("Preserved:");
  });
});

describe("confirmation", () => {
  it("refuses without explicit confirmation", async () => {
    const { serviceHome } = await environment();
    const preview = await previewCleanup({ serviceHome, scopes: ["logs"] });
    await expect(
      applyCleanup({
        preview,
        confirmationId: preview.confirmationId,
        confirmed: false,
      }),
    ).rejects.toBeInstanceOf(CleanupConfirmationError);
  });

  it("refuses a confirmation id that does not match the reviewed plan", async () => {
    const { serviceHome } = await environment();
    const preview = await previewCleanup({ serviceHome, scopes: ["logs"] });
    await expect(
      applyCleanup({
        preview,
        confirmationId: "00000000-0000-0000-0000-000000000000",
        confirmed: true,
      }),
    ).rejects.toThrow("does not match");
  });

  it("refuses an expired preview", async () => {
    const { serviceHome } = await environment();
    const preview = await previewCleanup({
      serviceHome,
      scopes: ["logs"],
      now: "2026-08-17T00:00:00.000Z",
    });
    await expect(
      applyCleanup({
        preview,
        confirmationId: preview.confirmationId,
        confirmed: true,
        now: "2026-08-17T00:10:00.000Z",
      }),
    ).rejects.toThrow("expired");
  });

  it("round trips a persisted preview so a printed id can be honoured", async () => {
    const { serviceHome } = await environment();
    const preview = await previewCleanup({ serviceHome, scopes: ["logs"] });
    await persistCleanupPreview(serviceHome, preview);
    const loaded = await loadCleanupPreview(
      serviceHome,
      preview.confirmationId,
    );
    expect(loaded?.confirmationId).toBe(preview.confirmationId);
    await discardCleanupPreview(serviceHome, preview.confirmationId);
    expect(
      await loadCleanupPreview(serviceHome, preview.confirmationId),
    ).toBeUndefined();
  });
});

describe("applied cleanup", () => {
  it("removes only what was reviewed", async () => {
    const { serviceHome, selectedProject, otherProject } = await environment();
    const preview = await previewCleanup({ serviceHome, scopes: ["logs"] });
    const result = await applyCleanup({
      preview,
      confirmationId: preview.confirmationId,
      confirmed: true,
    });
    expect(result.removed).toEqual([join(serviceHome, "logs")]);
    expect(await exists(join(serviceHome, "logs"))).toBe(false);
    // Everything outside the reviewed scope survives.
    expect(await exists(join(serviceHome, "service.json"))).toBe(true);
    expect(await exists(join(serviceHome, "audit.jsonl"))).toBe(true);
    expect(await exists(join(selectedProject, "run.json"))).toBe(true);
    expect(await exists(join(otherProject, "run.json"))).toBe(true);
  });

  it("never touches unselected project state", async () => {
    const { serviceHome, selectedProject, otherProject } = await environment();
    const preview = await previewCleanup({
      serviceHome,
      scopes: ["project-state"],
      selectedProjectStateDirectories: [selectedProject],
      knownProjectStateDirectories: [selectedProject, otherProject],
    });
    await applyCleanup({
      preview,
      confirmationId: preview.confirmationId,
      confirmed: true,
    });
    expect(await exists(selectedProject)).toBe(false);
    expect(await exists(join(otherProject, "run.json"))).toBe(true);
  });

  it("never removes committed project configuration or Git data", async () => {
    const { serviceHome, selectedProject } = await environment();
    const projectRoot = join(selectedProject, "..");
    const preview = await previewCleanup({
      serviceHome,
      scopes: [...CLEANUP_SCOPES],
      selectedProjectStateDirectories: [selectedProject],
    });
    await applyCleanup({
      preview,
      confirmationId: preview.confirmationId,
      confirmed: true,
    });
    expect(await exists(join(projectRoot, ".swf", "config.yaml"))).toBe(true);
    expect(await exists(join(projectRoot, ".git", "HEAD"))).toBe(true);
  });

  it("removes development instances only when that scope is selected", async () => {
    const { serviceHome, checkoutRoot } = await environment();
    const withoutScope = await previewCleanup({
      serviceHome,
      scopes: ["logs"],
      checkoutRoot,
    });
    await applyCleanup({
      preview: withoutScope,
      confirmationId: withoutScope.confirmationId,
      confirmed: true,
    });
    expect(await exists(join(checkoutRoot, ".swf-dev"))).toBe(true);

    const withScope = await previewCleanup({
      serviceHome,
      scopes: ["development-instances"],
      checkoutRoot,
    });
    await applyCleanup({
      preview: withScope,
      confirmationId: withScope.confirmationId,
      confirmed: true,
    });
    expect(await exists(join(checkoutRoot, ".swf-dev"))).toBe(false);
  });

  it("reports paths that did not exist rather than failing", async () => {
    const { serviceHome } = await environment();
    await rm(join(serviceHome, "cache"), { recursive: true, force: true });
    const preview = await previewCleanup({ serviceHome, scopes: ["caches"] });
    const result = await applyCleanup({
      preview,
      confirmationId: preview.confirmationId,
      confirmed: true,
    });
    expect(result.removed).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("did not exist");
  });
});

describe("orphaned managed service", () => {
  it("reports a definition whose product was removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-orphan-"));
    temporary.push(root);
    const definitionPath = join(root, "dev.swf.service.plist");
    await writeFile(definitionPath, "<string>dev.swf.service</string>");
    const report = await diagnoseOrphanedManagedService(
      definitionPath,
      join(root, "missing", "index.mjs"),
    );
    expect(report.orphaned).toBe(true);
    expect(report.options.map(({ action }) => action)).toEqual([
      "reinstall the product",
      "remove the definition",
    ]);
    expect(report.options[1]?.effect).toContain("preserved");
  });

  it("is not orphaned while the product is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-orphan-"));
    temporary.push(root);
    const definitionPath = join(root, "dev.swf.service.plist");
    const entry = join(root, "index.mjs");
    await writeFile(definitionPath, "<string>dev.swf.service</string>");
    await writeFile(entry, "export default {};");
    expect(
      (await diagnoseOrphanedManagedService(definitionPath, entry)).orphaned,
    ).toBe(false);
  });

  it("never claims a definition SWF does not own", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-orphan-"));
    temporary.push(root);
    const definitionPath = join(root, "other.plist");
    await writeFile(definitionPath, "<plist>someone else</plist>");
    const report = await diagnoseOrphanedManagedService(
      definitionPath,
      undefined,
    );
    expect(report.orphaned).toBe(false);
    expect(report.detail).toContain("does not own");
  });
});
