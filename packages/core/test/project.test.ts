import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findProjectRoot,
  initializeProject,
  resolveConfiguration,
  resolveConfigurationSources,
  validateProjectConfiguration,
} from "../src/project.js";

const temporaryDirectories: string[] = [];

async function temporaryProject(): Promise<{
  root: string;
  configHome: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "swf-project-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, ".git"));
  return { root, configHome: join(root, "user-config") };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("project initialization", () => {
  it("finds the Git root from a nested directory", async () => {
    const { root } = await temporaryProject();
    const nested = join(root, "packages", "core");
    await mkdir(nested, { recursive: true });

    await expect(findProjectRoot(nested)).resolves.toMatchObject({
      root: await realpath(root),
      initialized: false,
    });
  });

  it("requires explicit trust and creates complete default project configuration", async () => {
    const { root, configHome } = await temporaryProject();
    await expect(
      initializeProject({ cwd: root, configHome }),
    ).resolves.toMatchObject({ status: "untrusted" });

    const initialized = await initializeProject({
      cwd: root,
      configHome,
      trust: true,
    });
    expect(initialized).toMatchObject({ status: "initialized" });
    expect(
      await readFile(join(root, ".swf", "workflows", "default.yaml"), "utf8"),
    ).toContain("planning");
    expect(
      await readFile(join(root, ".swf", "profiles", "planner.yaml"), "utf8"),
    ).toContain("planner");
    expect(await readFile(join(root, ".gitignore"), "utf8")).toContain(
      "/.swf-state/",
    );
    expect(
      await validateProjectConfiguration((await findProjectRoot(root))!),
    ).toEqual([]);
  });

  it("does not overwrite existing project-owned configuration", async () => {
    const { root, configHome } = await temporaryProject();
    await initializeProject({ cwd: root, configHome, trust: true });
    const configPath = join(root, ".swf", "config.yaml");
    await writeFile(configPath, "custom: preserved\n", "utf8");

    await expect(
      initializeProject({ cwd: root, configHome }),
    ).resolves.toMatchObject({
      status: "already-initialized",
    });
    await expect(readFile(configPath, "utf8")).resolves.toBe(
      "custom: preserved\n",
    );
  });

  it("reports unavailable required profile capabilities before execution resources are created", async () => {
    const { root, configHome } = await temporaryProject();
    await initializeProject({ cwd: root, configHome, trust: true });
    const profilePath = join(root, ".swf", "profiles", "planner.yaml");
    const profile = await readFile(profilePath, "utf8");
    await writeFile(
      profilePath,
      profile.replace("structured-events", "missing-capability"),
      "utf8",
    );

    const issues = await validateProjectConfiguration(
      (await findProjectRoot(root))!,
    );
    expect(
      issues.some((issue) =>
        issue.message.includes("unavailable structured-events capability"),
      ),
    ).toBe(true);
  });

  it("reports invalid profile references before execution resources are created", async () => {
    const { root, configHome } = await temporaryProject();
    await initializeProject({ cwd: root, configHome, trust: true });
    const workflowPath = join(root, ".swf", "workflows", "default.yaml");
    const workflow = await readFile(workflowPath, "utf8");
    await writeFile(
      workflowPath,
      workflow.replace("profile: planner", "profile: missing-profile"),
      "utf8",
    );

    const issues = await validateProjectConfiguration(
      (await findProjectRoot(root))!,
    );
    expect(
      issues.some((issue) => issue.message.includes("missing profile")),
    ).toBe(true);
  });
});

describe("configuration resolution", () => {
  it("uses deterministic precedence and preserves source provenance", () => {
    const resolved = resolveConfiguration([
      {
        name: "built-in",
        value: { harness: "pi", gate: { mode: "manual", retry: 1 } },
      },
      { name: "project", value: { gate: { mode: "automatic" } } },
      { name: "phase", value: { harness: "claude" } },
    ]);

    expect(resolved.value).toEqual({
      harness: "claude",
      gate: { mode: "automatic", retry: 1 },
    });
    expect(resolved.provenance["harness"]).toMatchObject({
      source: "phase",
      overridden: ["built-in"],
    });
    expect(resolved.provenance["gate.mode"]).toMatchObject({
      source: "project",
      overridden: ["built-in"],
    });

    const ordered = resolveConfigurationSources({
      phase: { harness: "claude" },
      "built-in": { harness: "pi" },
    });
    expect(ordered.value).toEqual({ harness: "claude" });
    expect(ordered.provenance.harness).toMatchObject({
      source: "phase",
      overridden: ["built-in"],
    });
  });
});
