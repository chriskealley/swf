#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkNoWorkspaceResolution,
  checkPrivatePermissions,
  classifyDifference,
  compareReproducibility,
  createReleaseEvidence,
  decidePublishability,
  fileDigest,
  inspectPackedArtifact,
  installTarball,
  installedPackageDirectory,
  packArtifact,
  removeSmokeEnvironment,
  runIsolated,
  simulateUninstall,
  smokePackagedService,
  stagedFileDigests,
  type SmokeCheck,
} from "../packages/dev/src/index.js";
import { buildProduct } from "./build-product.js";
import { verifyProduct } from "./verify-product.js";
import {
  extensionStagingRoot,
  packageSizeBudgetBytes,
  repositoryRoot,
  stagingRoot,
} from "./product-layout.js";

const FORBIDDEN_PACKED_PATHS = [
  /(^|\/)\.swf-state\//,
  /(^|\/)\.swf-dev\//,
  /(^|\/)node_modules\//,
  /\.ts$/,
  /(^|\/)service\.json$/,
  /\.env$/,
  /(^|\/)logs?\//,
];

const REQUIRED_PACKED_PATHS = [
  "package.json",
  "LICENSE",
  "product.json",
  "bin/swf.mjs",
  "service/server/index.mjs",
];

function report(checks: SmokeCheck[]): boolean {
  let ok = true;
  for (const check of checks) {
    process.stdout.write(
      `  ${check.passed ? "ok  " : "FAIL"} ${check.id}: ${check.detail}\n`,
    );
    if (!check.passed) ok = false;
  }
  return ok;
}

async function main(): Promise<void> {
  const channel = (process.argv
    .find((value) => value.startsWith("--channel="))
    ?.split("=")[1] ?? "development") as "stable" | "next" | "development";
  const keep = process.argv.includes("--retain");

  process.stdout.write("1. Assembling the product\n");
  const { metadata } = await buildProduct({ channel });
  const verification = await verifyProduct(stagingRoot);
  if (verification.violations.length) {
    for (const violation of verification.violations)
      process.stderr.write(`  FAIL ${violation}\n`);
    throw new Error("Package contents failed verification");
  }
  process.stdout.write(
    `  ok   ${verification.entries.length} files, ${(verification.totalBytes / 1024).toFixed(0)} KiB\n`,
  );

  const publishability = decidePublishability({
    channel,
    sourceDirty: metadata.build.sourceDirty,
    version: metadata.build.productVersion,
  });
  process.stdout.write(
    `  ${publishability.publishable ? "ok  " : "note"} artifact is ${publishability.label}${
      publishability.reasons.length
        ? `: ${publishability.reasons.join("; ")}`
        : ""
    }\n`,
  );
  if (channel === "stable" && !publishability.publishable)
    throw new Error(
      `Refusing a stable release: ${publishability.reasons.join("; ")}`,
    );

  process.stdout.write("2. Packing the product and Pi extension\n");
  const packDestination = await mkdtemp(join(tmpdir(), "swf-pack-"));
  const product = await packArtifact({
    packageDirectory: stagingRoot,
    destinationDirectory: packDestination,
  });
  const extension = await packArtifact({
    packageDirectory: extensionStagingRoot,
    destinationDirectory: packDestination,
  });
  process.stdout.write(
    `  ok   ${product.filename} ${product.entryCount} files sha256:${product.sha256.slice(0, 16)}\n` +
      `  ok   ${extension.filename} ${extension.entryCount} files sha256:${extension.sha256.slice(0, 16)}\n`,
  );

  const packedInspection = inspectPackedArtifact(product, {
    forbiddenPatterns: FORBIDDEN_PACKED_PATHS,
    requiredPaths: REQUIRED_PACKED_PATHS,
    maximumBytes: packageSizeBudgetBytes,
    expectedName: "@chriskealley/swf",
  });
  if (packedInspection.violations.length) {
    for (const violation of packedInspection.violations)
      process.stderr.write(`  FAIL ${violation}\n`);
    throw new Error("Packed tarball failed inspection");
  }
  process.stdout.write("  ok   packed contents inspected\n");

  process.stdout.write("3. Comparing reproducibility\n");
  // manifest.json is written by verification, not by the build, so it is not
  // an input to reproducibility.
  const excludeVerificationArtifacts = (
    entries: Array<{ path: string; sha256: string }>,
  ) => entries.filter(({ path }) => path !== "manifest.json");
  const firstDigests = excludeVerificationArtifacts(
    await stagedFileDigests(stagingRoot),
  );
  // Retain the first build's content so a difference can be explained, not
  // merely detected.
  const firstSnapshot = new Map<string, string>();
  for (const { path } of firstDigests)
    firstSnapshot.set(
      path,
      await readFile(join(stagingRoot, path), "utf8").catch(() => ""),
    );
  const { metadata: second } = await buildProduct({
    channel,
    version: metadata.build.productVersion,
    sourceCommit: metadata.build.sourceCommit,
    sourceDirty: metadata.build.sourceDirty,
    builtAt: metadata.build.builtAt,
  });
  void second;
  const secondDigests = excludeVerificationArtifacts(
    await stagedFileDigests(stagingRoot),
  );
  const repeatPack = await packArtifact({
    packageDirectory: stagingRoot,
    destinationDirectory: packDestination,
  });
  const reproducibility = compareReproducibility(
    firstDigests,
    secondDigests,
    repeatPack.sha256 === product.sha256,
  );
  process.stdout.write(
    `  ok   ${reproducibility.matchedFiles} file digests matched\n`,
  );
  for (const note of reproducibility.knownNondeterminism)
    process.stdout.write(`  note ${note}\n`);

  // Classify each difference instead of assuming its cause: only a file that is
  // byte-identical once embedded timestamps are removed counts as known
  // nondeterminism. Anything else is a real build difference and fails.
  const unexplained: string[] = [];
  for (const differing of reproducibility.differingFiles) {
    const classification = differing.includes("(missing in")
      ? "content"
      : classifyDifference(
          firstSnapshot.get(differing) ?? "",
          await readFile(join(stagingRoot, differing), "utf8").catch(() => ""),
        );
    if (classification === "timestamps-only")
      process.stdout.write(
        `  note ${differing} differs only in embedded timestamps\n`,
      );
    else unexplained.push(differing);
  }
  for (const differing of unexplained)
    process.stderr.write(`  FAIL differing: ${differing}\n`);
  if (unexplained.length)
    throw new Error("Build is not reproducible for source-derived content");

  process.stdout.write("4. Installing the exact tarball into a clean prefix\n");
  const environment = await installTarball(product.tarballPath);
  const checks: SmokeCheck[] = [];
  try {
    process.stdout.write(`  ok   installed at ${environment.prefix}\n`);

    const version = await runIsolated(environment, environment.executable, [
      "--version",
    ]);
    checks.push({
      id: "version",
      passed: version.code === 0 && version.stdout.trim().length > 0,
      detail: version.stdout.trim() || version.stderr.trim(),
    });

    const help = await runIsolated(environment, environment.executable, [
      "--help",
    ]);
    checks.push({
      id: "help",
      passed: help.code === 0 && help.stdout.includes("swf"),
      detail: `exit ${help.code}`,
    });

    const doctor = await runIsolated(environment, environment.executable, [
      "doctor",
      "--json",
    ]);
    checks.push({
      id: "doctor",
      passed: doctor.stdout.includes("checks") || doctor.code !== 127,
      detail: `exit ${doctor.code}`,
    });

    checks.push(await checkNoWorkspaceResolution(environment, repositoryRoot));

    const installed = installedPackageDirectory(environment);
    const manifest = JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    checks.push({
      id: "installed-dependencies",
      passed: !Object.keys(manifest.dependencies ?? {}).some(
        (name) => name.startsWith("@swf/") || name === "tsx",
      ),
      detail: `declares ${Object.keys(manifest.dependencies ?? {}).length} dependencies`,
    });

    checks.push({
      id: "packaged-dashboard",
      passed: await fileDigest(
        join(installed, "service", "public", "dashboard", "index.html"),
      )
        .then(() => true)
        .catch(() => false),
      detail: "dashboard entry present in the installed product",
    });

    // Templates are generated in code rather than shipped as files, and no
    // migrations exist yet, so project initialization is what exercises them.
    const initialize = await runIsolated(environment, environment.executable, [
      "init",
      "--json",
    ]);
    // `init` reports `untrusted` and exits non-zero until a project is
    // explicitly trusted, which is the intended contract. What matters here is
    // that the installed product resolves its packaged templates and emits a
    // valid projection rather than failing to load.
    const initializeReport = (() => {
      try {
        return JSON.parse(initialize.stdout) as {
          schemaVersion?: number;
          result?: { status?: string; project?: { root?: string } };
        };
      } catch {
        return undefined;
      }
    })();
    checks.push({
      id: "project-initialization",
      passed:
        initializeReport?.schemaVersion === 1 &&
        typeof initializeReport.result?.status === "string" &&
        typeof initializeReport.result.project?.root === "string",
      detail: initializeReport
        ? `status ${initializeReport.result?.status} (exit ${initialize.code})`
        : `no valid projection (exit ${initialize.code})`,
    });

    const extensionManifest = JSON.parse(
      await readFile(join(extensionStagingRoot, "package.json"), "utf8"),
    ) as { pi?: { extensions?: string[] }; version?: string };
    const extensionEntry = extensionManifest.pi?.extensions?.[0];
    checks.push({
      id: "pi-extension-loadable",
      passed:
        typeof extensionEntry === "string" &&
        extensionEntry.endsWith(".mjs") &&
        (await fileDigest(join(extensionStagingRoot, extensionEntry))
          .then(() => true)
          .catch(() => false)),
      detail: `entry ${extensionEntry ?? "missing"}`,
    });
    checks.push({
      id: "pi-extension-lockstep",
      passed: extensionManifest.version === product.version,
      detail: `extension ${extensionManifest.version} vs product ${product.version}`,
    });

    const serviceSmoke = await smokePackagedService(environment);
    checks.push(...serviceSmoke.checks);
    checks.push(...(await checkPrivatePermissions(environment)));
    checks.push(...(await simulateUninstall(environment)));

    process.stdout.write("5. Smoke results\n");
    if (!report(checks)) throw new Error("Smoke checks failed");

    process.stdout.write("6. Writing release evidence\n");
    const evidenceDirectory = join(repositoryRoot, "dist", "release");
    await mkdir(evidenceDirectory, { recursive: true });
    const evidence = createReleaseEvidence({
      source: {
        commit: metadata.build.sourceCommit,
        dirty: metadata.build.sourceDirty,
      },
      toolchain: {
        node: process.version,
        packageManager: "npm",
      },
      lockfile: {
        path: "pnpm-lock.yaml",
        sha256: await fileDigest(join(repositoryRoot, "pnpm-lock.yaml")),
      },
      product: {
        name: product.name,
        version: product.version,
        channel,
        publishable: publishability.publishable,
      },
      artifacts: [product, extension].map((artifact) => ({
        name: artifact.name,
        filename: artifact.filename,
        sha256: artifact.sha256,
        integrity: artifact.integrity,
        entryCount: artifact.entryCount,
        unpackedBytes: artifact.unpackedBytes,
      })),
      tests: checks.map(({ id, passed, detail }) => ({
        suite: id,
        passed,
        detail,
      })),
      provenance: { requested: channel !== "development" },
      destinations:
        channel === "development"
          ? []
          : ["npm:@chriskealley/swf", "github:chriskealley/swf"],
    });
    const evidencePath = join(evidenceDirectory, "release-evidence.json");
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`  ok   ${evidencePath}\n`);
  } finally {
    if (keep)
      process.stdout.write(`\nRetained smoke prefix at ${environment.root}\n`);
    else await removeSmokeEnvironment(environment);
    if (!keep) await rm(packDestination, { recursive: true, force: true });
  }

  process.stdout.write("\nRelease verification passed\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
