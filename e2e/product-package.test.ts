import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  contentAllowlist,
  forbiddenContent,
  packageSizeBudgetBytes,
  verifyInternalPackagesPrivate,
  verifyProduct,
} from "../scripts/verify-product.js";
import {
  extensionStagingRoot,
  repositoryRoot,
  stagingRoot,
} from "../scripts/product-layout.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const assembled = await exists(join(stagingRoot, "bin", "swf.mjs"));

describe("workspace package boundaries", () => {
  it("keeps every internal package private", async () => {
    expect(await verifyInternalPackagesPrivate(repositoryRoot)).toEqual([]);
  });
});

describe.skipIf(!assembled)("assembled package contents", () => {
  it("verifies with no violations", async () => {
    const { violations } = await verifyProduct(stagingRoot);
    expect(violations).toEqual([]);
  });

  it("stays inside the package size budget", async () => {
    const { totalBytes } = await verifyProduct(stagingRoot);
    expect(totalBytes).toBeLessThanOrEqual(packageSizeBudgetBytes);
  });

  it("produces a per-file manifest with size, mode, and digest", async () => {
    const { entries } = await verifyProduct(stagingRoot);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.mode).toMatch(/^[0-7]{4}$/);
      expect(entry.bytes).toBeGreaterThanOrEqual(0);
    }
    const manifest = JSON.parse(
      await readFile(join(stagingRoot, "manifest.json"), "utf8"),
    ) as { entries: unknown[] };
    expect(manifest.entries.length).toBe(entries.length);
  });

  it("ships no vendored dependency tree", async () => {
    const { entries } = await verifyProduct(stagingRoot);
    expect(entries.filter(({ path }) => path.includes("node_modules"))).toEqual(
      [],
    );
  });

  it("rejects forbidden content when it appears", async () => {
    const leaked = join(stagingRoot, "service", "server", "service.json");
    await writeFile(leaked, "{}");
    try {
      const { violations } = await verifyProduct(stagingRoot);
      expect(violations.some((v) => v.includes("service.json"))).toBe(true);
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(leaked, { force: true });
    }
  });

  it("rejects unexpected content outside the allowlist", async () => {
    const stray = join(stagingRoot, "unexpected-file.txt");
    await writeFile(stray, "x");
    try {
      const { violations } = await verifyProduct(stagingRoot);
      expect(violations.some((v) => v.includes("unexpected-file.txt"))).toBe(
        true,
      );
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(stray, { force: true });
    }
  });

  it("declares an allowlist and a forbidden list that are both non-empty", () => {
    expect(contentAllowlist.length).toBeGreaterThan(0);
    expect(forbiddenContent.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!assembled)("assembled Pi extension", () => {
  it("is separately installable with lockstep version and compatibility range", async () => {
    const manifest = JSON.parse(
      await readFile(join(extensionStagingRoot, "package.json"), "utf8"),
    ) as {
      name?: string;
      version?: string;
      license?: string;
      pi?: { extensions?: string[] };
      peerDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const product = JSON.parse(
      await readFile(join(stagingRoot, "package.json"), "utf8"),
    ) as { version?: string };

    expect(manifest.name).toBe("@chriskealley/swf-pi");
    expect(manifest.version).toBe(product.version);
    expect(manifest.license).toBe("MIT");
    expect(manifest.pi?.extensions?.[0]).toMatch(/\.mjs$/);
    expect(Object.keys(manifest.peerDependencies ?? {})).toContain(
      "@earendil-works/pi-coding-agent",
    );
    for (const name of Object.keys(manifest.dependencies ?? {}))
      expect(name).not.toMatch(/^@swf\//);

    const compatibility = JSON.parse(
      await readFile(join(extensionStagingRoot, "compatibility.json"), "utf8"),
    ) as { compatibleServiceRange?: string };
    expect(compatibility.compatibleServiceRange).toBeTruthy();
  });

  it("inlines internal packages into its compiled entry", async () => {
    const source = await readFile(
      join(extensionStagingRoot, "dist", "index.mjs"),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']@swf\//);
  });
});

describe("verification operates on an isolated directory", () => {
  it("reports missing entries for an empty staging root", async () => {
    const empty = await mkdtemp(join(tmpdir(), "swf-empty-product-"));
    await writeFile(join(empty, "package.json"), "{}");
    await writeFile(join(empty, "LICENSE"), "not a licence");
    const { violations } = await verifyProduct(empty);
    expect(violations.some((v) => v.includes("bin/swf.mjs"))).toBe(true);
    expect(violations.some((v) => v.includes("license must be MIT"))).toBe(
      true,
    );
  });
});
