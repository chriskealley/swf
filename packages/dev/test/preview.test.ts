import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FIXTURE_CAPABILITIES,
  PreviewArtifactError,
  assertPreviewArtifact,
  createGitFixture,
  fixtureCapabilitySummary,
  fixtureEnvironment,
  inspectPreviewArtifact,
  inspectPreviewCommand,
  removeGitFixture,
  renderPreviewSummary,
} from "../src/index.js";

const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

/** Builds a minimal staged package that passes every production check. */
async function stageArtifact(
  overrides: {
    manifest?: Record<string, unknown>;
    extraFiles?: Record<string, string>;
  } = {},
): Promise<{ repositoryRoot: string; packageDirectory: string }> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "swf-repo-"));
  temporary.push(repositoryRoot);
  const packageDirectory = join(
    repositoryRoot,
    ".swf-dev",
    "preview",
    "package",
  );
  await mkdir(join(packageDirectory, "bin"), { recursive: true });
  await writeFile(
    join(packageDirectory, "bin", "swf.mjs"),
    "#!/usr/bin/env node\n",
  );
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "@chriskealley/swf",
      bin: { swf: "./bin/swf.mjs" },
      dependencies: { zod: "^4.4.3" },
      ...overrides.manifest,
    }),
  );
  for (const [path, contents] of Object.entries(overrides.extraFiles ?? {})) {
    const absolute = join(packageDirectory, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents);
  }
  return { repositoryRoot, packageDirectory };
}

describe("preview artifact inspection", () => {
  it("accepts a production-shaped staged package", async () => {
    const { repositoryRoot, packageDirectory } = await stageArtifact();
    expect(
      await inspectPreviewArtifact(packageDirectory, repositoryRoot),
    ).toEqual([]);
    await expect(
      assertPreviewArtifact(packageDirectory, repositoryRoot),
    ).resolves.toBeUndefined();
  });

  it("rejects a bin pointing at TypeScript source", async () => {
    const { repositoryRoot, packageDirectory } = await stageArtifact({
      manifest: { bin: { swf: "./src/main.ts" } },
    });
    const violations = await inspectPreviewArtifact(
      packageDirectory,
      repositoryRoot,
    );
    expect(violations.map(({ id }) => id)).toContain("source-bin");
  });

  it("rejects development-only dependencies", async () => {
    const { repositoryRoot, packageDirectory } = await stageArtifact({
      manifest: { dependencies: { tsx: "^4.21.0", vite: "^8.2.0" } },
    });
    const violations = await inspectPreviewArtifact(
      packageDirectory,
      repositoryRoot,
    );
    expect(
      violations.filter(({ id }) => id === "development-dependency"),
    ).toHaveLength(2);
  });

  it("rejects workspace and internal dependencies", async () => {
    const { repositoryRoot, packageDirectory } = await stageArtifact({
      manifest: { dependencies: { "@swf/core": "workspace:*" } },
    });
    const violations = await inspectPreviewArtifact(
      packageDirectory,
      repositoryRoot,
    );
    expect(violations.map(({ id }) => id)).toContain("workspace-dependency");
  });

  it("rejects TypeScript source inside the staged package", async () => {
    const { repositoryRoot, packageDirectory } = await stageArtifact({
      extraFiles: { "bin/helper.ts": "export const x = 1;\n" },
    });
    const violations = await inspectPreviewArtifact(
      packageDirectory,
      repositoryRoot,
    );
    expect(violations.map(({ id }) => id)).toContain("typescript-source");
  });

  it("ignores installed dependency sources under node_modules", async () => {
    const { repositoryRoot, packageDirectory } = await stageArtifact({
      extraFiles: { "node_modules/dep/index.ts": "export const y = 2;\n" },
    });
    expect(
      await inspectPreviewArtifact(packageDirectory, repositoryRoot),
    ).toEqual([]);
  });

  it("rejects a package staged outside the development root", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "swf-repo-"));
    temporary.push(repositoryRoot);
    const packageDirectory = join(repositoryRoot, "dist", "product");
    await mkdir(join(packageDirectory, "bin"), { recursive: true });
    await writeFile(join(packageDirectory, "bin", "swf.mjs"), "#!\n");
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({ bin: { swf: "./bin/swf.mjs" } }),
    );
    const violations = await inspectPreviewArtifact(
      packageDirectory,
      repositoryRoot,
    );
    expect(violations.map(({ id }) => id)).toContain("source-repository-path");
  });

  it("reports a missing artifact rather than throwing", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "swf-repo-"));
    temporary.push(repositoryRoot);
    const violations = await inspectPreviewArtifact(
      join(repositoryRoot, ".swf-dev", "absent", "package"),
      repositoryRoot,
    );
    expect(violations).toEqual([
      expect.objectContaining({ id: "missing-artifact" }),
    ]);
  });

  it("throws with every violation listed", async () => {
    const { repositoryRoot, packageDirectory } = await stageArtifact({
      manifest: {
        bin: { swf: "./src/main.ts" },
        dependencies: { tsx: "^4.21.0" },
      },
    });
    await expect(
      assertPreviewArtifact(packageDirectory, repositoryRoot),
    ).rejects.toBeInstanceOf(PreviewArtifactError);
  });
});

describe("preview command inspection", () => {
  it("accepts running a compiled entry with node", () => {
    expect(
      inspectPreviewCommand("/usr/bin/node", [
        "/tmp/pkg/service/server/index.mjs",
      ]),
    ).toEqual([]);
  });

  it("rejects development runners and workspace filters", () => {
    for (const [command, args] of [
      ["tsx", ["apps/cli/src/main.ts"]],
      ["pnpm", ["--filter", "@swf/service", "dev"]],
      ["nitro", ["dev"]],
      ["vite", []],
      ["node", ["apps/cli/src/main.ts"]],
    ] as Array<[string, string[]]>)
      expect(
        inspectPreviewCommand(command, args).length,
        `${command} ${args.join(" ")}`,
      ).toBeGreaterThan(0);
  });
});

describe("preview summary", () => {
  it("reports artifact identity, endpoint, and exact executable", () => {
    const rendered = renderPreviewSummary({
      instance: "prev",
      mode: "preview",
      productVersion: "0.1.0",
      channel: "development",
      sourceCommit: "a".repeat(40),
      sourceDirty: true,
      publishable: false,
      endpoint: "http://127.0.0.1:65439",
      executable: "/tmp/pkg/bin/swf.mjs",
      serviceEntry: "/tmp/pkg/service/server/index.mjs",
      serviceHome: "/tmp/home",
      logsDirectory: "/tmp/logs",
      fileCount: 28,
      totalBytes: 1_431_552,
    });
    expect(rendered).toContain("0.1.0 (development)");
    expect(rendered).toContain("aaaaaaaaaaaa-dirty");
    expect(rendered).toContain("publishable no");
    expect(rendered).toContain("/tmp/pkg/bin/swf.mjs");
    expect(rendered).toContain("28 files");
  });
});

describe("git fixtures", () => {
  it("creates a committed repository with an OpenSpec change", async () => {
    const fixture = await createGitFixture({ retain: true });
    temporary.push(fixture.root);
    expect(fixture.branch).toBe("main");
    expect(fixture.headCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(fixture.changeName).toBe("fixture-change");
  });

  it("defaults every paid or remote capability to disabled", async () => {
    const fixture = await createGitFixture({ retain: true });
    temporary.push(fixture.root);
    expect(fixture.capabilities).toEqual(DEFAULT_FIXTURE_CAPABILITIES);
    expect(fixtureEnvironment(fixture)).toMatchObject({
      SWF_LIVE_HARNESS: "0",
      SWF_HOSTED_DELIVERY: "0",
      SWF_DELIVERY_MODE: "local-branch",
    });
  });

  it("enables paid capabilities only when explicitly requested", async () => {
    const fixture = await createGitFixture({
      retain: true,
      capabilities: { liveHarness: true, hostedDelivery: true },
    });
    temporary.push(fixture.root);
    expect(fixtureEnvironment(fixture)).toMatchObject({
      SWF_LIVE_HARNESS: "1",
      SWF_HOSTED_DELIVERY: "1",
      SWF_DELIVERY_MODE: "pull-request",
    });
    expect(fixtureCapabilitySummary(fixture)[0]).toContain("ENABLED");
  });

  it("removes a fixture unless retention was requested", async () => {
    const disposable = await createGitFixture();
    expect(await removeGitFixture(disposable)).toBe(true);

    const retained = await createGitFixture({ retain: true });
    temporary.push(retained.root);
    expect(await removeGitFixture(retained)).toBe(false);
  });
});
