import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectPreviewArtifact,
  instancePaths,
  readInstance,
} from "../packages/dev/src/index.js";
import { repositoryRoot } from "../scripts/product-layout.js";

const PREVIEW_INSTANCE = "prev";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const paths = instancePaths(repositoryRoot, PREVIEW_INSTANCE);
const previewed = await exists(join(paths.packageDirectory, "package.json"));

/**
 * Exercises a real previewed artifact. Preview is a build output, so skip
 * rather than fail when `pnpm dev preview` has not been run in this checkout.
 */
describe.skipIf(!previewed)("previewed artifact", () => {
  it("stages the package inside the development instance", async () => {
    const instance = await readInstance(repositoryRoot, PREVIEW_INSTANCE);
    expect(instance.mode).toBe("preview");
    expect(paths.packageDirectory.startsWith(repositoryRoot)).toBe(true);
    expect(paths.packageDirectory).toContain(".swf-dev");
  });

  it("passes production artifact inspection", async () => {
    expect(
      await inspectPreviewArtifact(paths.packageDirectory, repositoryRoot),
    ).toEqual([]);
  });

  it("runs compiled entries rather than TypeScript source", async () => {
    const manifest = JSON.parse(
      await readFile(join(paths.packageDirectory, "package.json"), "utf8"),
    ) as {
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(manifest.bin?.swf).toMatch(/\.mjs$/);
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("tsx");
    expect(
      await exists(
        join(paths.packageDirectory, "service", "server", "index.mjs"),
      ),
    ).toBe(true);
  });

  it("installs its declared dependencies beside the artifact", async () => {
    expect(
      await exists(join(paths.packageDirectory, "node_modules", "zod")),
    ).toBe(true);
    expect(
      await exists(join(paths.packageDirectory, "node_modules", "tsx")),
    ).toBe(false);
  });

  it("keeps preview state inside the instance rather than the user home", async () => {
    const instance = await readInstance(repositoryRoot, PREVIEW_INSTANCE);
    expect(instance.serviceHome).toContain(".swf-dev");
    expect(instance.serviceHome).not.toContain(".config/swf");
    expect(instance.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("serves health and dashboard from the previewed service when running", async () => {
    const instance = await readInstance(repositoryRoot, PREVIEW_INSTANCE);
    let health: Response;
    try {
      health = await fetch(`${instance.endpoint}/api/health`, {
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      // The previewed service is not running; the artifact checks above still
      // hold and are the substance of this suite.
      return;
    }
    expect(health.ok).toBe(true);
    const body = (await health.json()) as {
      product?: { productVersion?: string };
      compatibility?: { minimumNodeVersion?: string };
    };
    expect(body.product?.productVersion).toBeTruthy();
    expect(body.compatibility?.minimumNodeVersion).toBe("24.0.0");

    const dashboard = await fetch(`${instance.endpoint}/dashboard/`, {
      signal: AbortSignal.timeout(3_000),
    });
    expect(dashboard.ok).toBe(true);
  });
});
