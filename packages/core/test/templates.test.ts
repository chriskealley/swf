import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adoptTemplateFiles,
  createTemplateMetadata,
  inspectTemplateDiff,
  restoreTemplateBackup,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("versioned default templates", () => {
  it("classifies upstream and project changes without writing during inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-template-"));
    roots.push(root);
    await writeFile(join(root, "profile.yaml"), "project\n");
    const metadata = createTemplateMetadata({
      version: "1",
      files: { "profile.yaml": "base\n" },
    });
    const diff = await inspectTemplateDiff({
      configDirectory: root,
      adopted: metadata,
      installed: { "profile.yaml": "upstream\n", "new.yaml": "new\n" },
    });
    expect(diff).toEqual([
      expect.objectContaining({ path: "new.yaml", status: "upstream-only" }),
      expect.objectContaining({ path: "profile.yaml", status: "conflict" }),
    ]);
    expect(await readFile(join(root, "profile.yaml"), "utf8")).toBe(
      "project\n",
    );
  });

  it("handles clean upstream updates and projects without metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-template-"));
    roots.push(root);
    await writeFile(join(root, "profile.yaml"), "base\n");
    const metadata = createTemplateMetadata({
      version: "1",
      files: { "profile.yaml": "base\n" },
    });
    const clean = await inspectTemplateDiff({
      configDirectory: root,
      adopted: metadata,
      installed: { "profile.yaml": "updated\n" },
    });
    expect(clean[0]).toMatchObject({ status: "upstream-only" });
    const legacy = await inspectTemplateDiff({
      configDirectory: root,
      installed: { "profile.yaml": "updated\n" },
    });
    expect(legacy[0]).toMatchObject({ status: "conflict" });
  });

  it("adopts only selected clean files and creates a backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-template-"));
    roots.push(root);
    const backup = join(root, "backup");
    await writeFile(join(root, "profile.yaml"), "base\n");
    const metadata = createTemplateMetadata({
      version: "1",
      files: { "profile.yaml": "base\n" },
    });
    const installed = { "profile.yaml": "updated\n", "other.yaml": "other\n" };
    const diff = await inspectTemplateDiff({
      configDirectory: root,
      adopted: metadata,
      installed,
    });
    const result = await adoptTemplateFiles({
      configDirectory: root,
      metadata,
      installed,
      selectedPaths: ["profile.yaml"],
      diff,
      backupDirectory: backup,
    });
    expect(result.adopted).toEqual(["profile.yaml"]);
    expect(await readFile(join(root, "profile.yaml"), "utf8")).toBe(
      "updated\n",
    );
    expect(await readFile(join(backup, "profile.yaml"), "utf8")).toBe("base\n");
    expect(
      await restoreTemplateBackup({
        configDirectory: root,
        backupDirectory: backup,
        selectedPaths: ["profile.yaml"],
      }),
    ).toEqual(["profile.yaml"]);
    expect(await readFile(join(root, "profile.yaml"), "utf8")).toBe("base\n");
    await expect(readFile(join(root, "other.yaml"), "utf8")).rejects.toThrow();
  });
});
