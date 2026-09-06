#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkPrivatePermissions,
  installTarball,
  installedPackageDirectory,
  removeSmokeEnvironment,
  runIsolated,
  simulateUninstall,
  smokePackagedService,
  type SmokeCheck,
  type SmokeEnvironment,
} from "../packages/dev/src/smoke.js";

interface ReleaseEvidence {
  source: { commit: string };
  product: { version: string };
  artifacts: Array<{ name: string; filename: string; sha256: string }>;
}

interface CandidateEvidence {
  schemaVersion: 1;
  createdAt: string;
  sourceCommit?: string;
  version?: string;
  runner: {
    platform: string;
    architecture: string;
    node: string;
    packageManager: string;
    packageManagerVersion: string;
    sourceCheckoutPresent: boolean;
  };
  artifacts: Array<{ name: string; filename: string; sha256: string }>;
  checks: SmokeCheck[];
  passed: boolean;
}

function argument(name: string, fallback?: string): string {
  return (
    process.argv
      .find((value) => value.startsWith(`--${name}=`))
      ?.slice(name.length + 3) ??
    fallback ??
    ""
  );
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function commandVersion(command: "npm" | "pnpm"): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command === "pnpm" ? "pnpm" : "npm", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`${command} --version failed: ${stderr.trim()}`)),
    );
  });
}

function record(
  checks: SmokeCheck[],
  id: string,
  passed: boolean,
  detail: string,
): void {
  checks.push({ id, passed, detail });
  process.stdout.write(`  ${passed ? "ok  " : "FAIL"} ${id}: ${detail}\n`);
}

async function main(): Promise<void> {
  const artifactsDirectory = dirname(fileURLToPath(import.meta.url));
  const evidencePath = join(
    artifactsDirectory,
    "release-candidate-evidence.json",
  );
  const requestedPackageManager = argument("package-manager", "npm");
  const packageManager: "npm" | "pnpm" =
    requestedPackageManager === "npm"
      ? "npm"
      : requestedPackageManager === "pnpm"
        ? "pnpm"
        : (() => {
            throw new Error(
              `Unsupported package manager: ${requestedPackageManager}`,
            );
          })();

  const checks: SmokeCheck[] = [];
  const artifacts: CandidateEvidence["artifacts"] = [];
  let release: ReleaseEvidence | undefined;
  let environment: SmokeEnvironment | undefined;
  let fatal: unknown;

  try {
    release = JSON.parse(
      await readFile(join(artifactsDirectory, "release-evidence.json"), "utf8"),
    ) as ReleaseEvidence;
    const checksumEntries = new Map(
      (await readFile(join(artifactsDirectory, "checksums.txt"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          const [sha256, filename] = line.trim().split(/\s+/, 2);
          return [filename, sha256] as const;
        }),
    );
    const product = release.artifacts.find(
      ({ name }) => name === "@chriskealley/swf",
    );
    const extension = release.artifacts.find(
      ({ name }) => name === "@chriskealley/swf-pi",
    );
    if (!product || !extension)
      throw new Error(
        "Release evidence does not identify both package artifacts",
      );

    for (const artifact of [product, extension]) {
      const actual = await digest(join(artifactsDirectory, artifact.filename));
      const matches =
        actual === artifact.sha256 &&
        actual === checksumEntries.get(artifact.filename);
      artifacts.push({ ...artifact, sha256: actual });
      record(
        checks,
        `checksum:${artifact.name}`,
        matches,
        matches ? actual : `expected ${artifact.sha256}; received ${actual}`,
      );
    }

    const sourceCheckoutPresent =
      (await exists(join(artifactsDirectory, ".git"))) ||
      (await exists(join(artifactsDirectory, "pnpm-workspace.yaml")));
    record(
      checks,
      "source-checkout-absent",
      !sourceCheckoutPresent,
      sourceCheckoutPresent
        ? `source checkout detected beside ${fileURLToPath(import.meta.url)}`
        : "runner contains only downloaded release-candidate inputs",
    );

    environment = await installTarball(
      join(artifactsDirectory, product.filename),
      {
        packageManager,
        additionalTarballs: [join(artifactsDirectory, extension.filename)],
      },
    );

    const version = await runIsolated(environment, environment.executable, [
      "--version",
    ]);
    record(
      checks,
      "version",
      version.code === 0 && version.stdout.includes(release.product.version),
      version.stdout.trim() || version.stderr.trim(),
    );
    const help = await runIsolated(environment, environment.executable, [
      "--help",
    ]);
    record(
      checks,
      "help",
      help.code === 0 && help.stdout.includes("swf"),
      `exit ${help.code}`,
    );
    const doctor = await runIsolated(environment, environment.executable, [
      "doctor",
      "--json",
    ]);
    record(
      checks,
      "doctor",
      doctor.code !== 127 && doctor.stdout.includes("checks"),
      `exit ${doctor.code}`,
    );

    const installed = installedPackageDirectory(environment);
    const manifest = JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const invalidDependency = Object.keys(manifest.dependencies ?? {}).find(
      (name) => name.startsWith("@swf/") || name === "tsx",
    );
    record(
      checks,
      "installed-dependencies",
      invalidDependency === undefined,
      invalidDependency
        ? `invalid runtime dependency ${invalidDependency}`
        : `${Object.keys(manifest.dependencies ?? {}).length} published dependencies`,
    );
    record(
      checks,
      "packaged-dashboard",
      await exists(
        join(installed, "service", "public", "dashboard", "index.html"),
      ),
      "dashboard entry is present in the installed product",
    );

    const initialize = await runIsolated(environment, environment.executable, [
      "init",
      "--json",
    ]);
    let initialized = false;
    try {
      const parsed = JSON.parse(initialize.stdout) as {
        schemaVersion?: number;
        result?: { status?: string; project?: { root?: string } };
      };
      initialized =
        parsed.schemaVersion === 1 &&
        typeof parsed.result?.status === "string" &&
        typeof parsed.result.project?.root === "string";
    } catch {
      initialized = false;
    }
    record(
      checks,
      "project-initialization",
      initialized,
      `exit ${initialize.code}`,
    );

    const extensionDirectory = join(
      environment.globalModulesDirectory,
      "@chriskealley",
      "swf-pi",
    );
    const extensionManifest = JSON.parse(
      await readFile(join(extensionDirectory, "package.json"), "utf8"),
    ) as { version?: string; pi?: { extensions?: string[] } };
    const extensionEntry = extensionManifest.pi?.extensions?.[0];
    let extensionLoaded = false;
    if (extensionEntry)
      extensionLoaded = await import(
        pathToFileURL(join(extensionDirectory, extensionEntry)).href
      ).then(
        () => true,
        () => false,
      );
    record(
      checks,
      "pi-extension-loadable",
      extensionLoaded && extensionManifest.version === release.product.version,
      `entry ${extensionEntry ?? "missing"}; version ${extensionManifest.version ?? "missing"}`,
    );

    const service = await smokePackagedService(environment);
    for (const check of service.checks)
      record(checks, check.id, check.passed, check.detail);
    for (const check of await checkPrivatePermissions(environment))
      record(checks, check.id, check.passed, check.detail);
    for (const check of await simulateUninstall(environment))
      record(checks, check.id, check.passed, check.detail);
  } catch (error) {
    fatal = error;
    record(
      checks,
      "fatal",
      false,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (environment) await removeSmokeEnvironment(environment);
  }

  const packageManagerVersion = await commandVersion(packageManager).catch(
    (error) => `unavailable: ${String(error)}`,
  );
  const sourceCheckoutPresent =
    (await exists(join(artifactsDirectory, ".git"))) ||
    (await exists(join(artifactsDirectory, "pnpm-workspace.yaml")));
  const result: CandidateEvidence = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceCommit: release?.source.commit,
    version: release?.product.version,
    runner: {
      platform: platform(),
      architecture: arch(),
      node: process.version,
      packageManager,
      packageManagerVersion,
      sourceCheckoutPresent,
    },
    artifacts,
    checks,
    passed: !fatal && checks.length > 0 && checks.every(({ passed }) => passed),
  };
  await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  if (!result.passed) process.exitCode = 1;
}

await main();
