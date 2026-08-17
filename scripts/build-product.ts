import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  createProductMetadata,
  type ProductMetadata,
} from "../packages/core/src/product.js";
import {
  externalRuntimeDependencies,
  productLayout,
  repositoryRoot,
  stagingRoot,
  workspaceVersion,
} from "./product-layout.js";

interface BuildOptions {
  channel: ProductMetadata["build"]["channel"];
  version?: string;
  sourceCommit?: string;
  sourceDirty?: boolean;
  outputDirectory?: string;
}

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`)),
    );
  });
}

async function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.once("error", reject);
    child.once("close", () => resolve(out.trim()));
  });
}

async function sourceIdentity(): Promise<{
  sourceCommit: string;
  sourceDirty: boolean;
}> {
  const [commit, status] = await Promise.all([
    capture("git", ["rev-parse", "HEAD"]),
    capture("git", ["status", "--porcelain"]),
  ]);
  return {
    sourceCommit: commit || "unknown",
    sourceDirty: status.length > 0,
  };
}

/**
 * Bundles the CLI. Internal `@swf/*` packages are inlined; every third-party
 * dependency stays external so the published manifest can declare it.
 */
async function buildCli(staging: string): Promise<void> {
  await build({
    entryPoints: [join(repositoryRoot, "apps", "cli", "src", "bin.ts")],
    outfile: join(staging, productLayout.binary),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: "linked",
    external: [...externalRuntimeDependencies],
    // The entry already carries a shebang and esbuild preserves it; adding a
    // banner here emits a second one and the output fails to parse.
    logLevel: "warning",
  });
}

async function buildService(staging: string): Promise<void> {
  await run("pnpm", ["--filter", "@swf/service", "build"], repositoryRoot);
  await cp(
    join(repositoryRoot, "apps", "service", ".output", "server"),
    join(staging, productLayout.serviceDirectory),
    { recursive: true },
  );
}

async function buildDashboard(staging: string): Promise<void> {
  await run("pnpm", ["--filter", "@swf/dashboard", "build"], repositoryRoot);
  await cp(
    join(repositoryRoot, "apps", "dashboard", "dist"),
    join(staging, productLayout.dashboardDirectory),
    { recursive: true },
  );
}

async function writeProductMetadata(
  staging: string,
  options: BuildOptions,
): Promise<ProductMetadata> {
  const identity = await sourceIdentity();
  const metadata = createProductMetadata({
    productVersion: options.version ?? (await workspaceVersion()),
    sourceCommit: options.sourceCommit ?? identity.sourceCommit,
    sourceDirty: options.sourceDirty ?? identity.sourceDirty,
    channel: options.channel,
  });
  await writeFile(
    join(staging, productLayout.productMetadata),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  // The service and CLI resolve metadata relative to their own module, so the
  // packaged copies must sit beside each compiled entry.
  for (const directory of [
    productLayout.serviceDirectory,
    join("bin"),
  ] as const)
    await writeFile(
      join(staging, directory, productLayout.productMetadata),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
  return metadata;
}

async function copyLicense(staging: string): Promise<void> {
  try {
    await cp(
      join(repositoryRoot, productLayout.license),
      join(staging, productLayout.license),
    );
  } catch {
    // Task 3.2 adds the repository LICENSE; assembly must not silently omit it
    // once it exists, so surface the absence rather than ignoring it.
    process.stderr.write(
      "warning: repository LICENSE is missing and was not packaged\n",
    );
  }
}

/**
 * Resolves the version range each external dependency is declared with in the
 * workspace, so the published manifest keeps the same ranges rather than
 * pinning. Ranges let consumers receive dependency security patches without a
 * SWF release.
 */
async function declaredDependencyRanges(): Promise<Record<string, string>> {
  const manifests = [
    join(repositoryRoot, "packages", "core", "package.json"),
    join(repositoryRoot, "packages", "integrations", "package.json"),
    join(repositoryRoot, "apps", "cli", "package.json"),
    join(repositoryRoot, "apps", "service", "package.json"),
  ];
  const ranges: Record<string, string> = {};
  for (const path of manifests) {
    const manifest = JSON.parse(await readFile(path, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const [name, range] of Object.entries(manifest.dependencies ?? {}))
      if ((externalRuntimeDependencies as readonly string[]).includes(name))
        ranges[name] = range;
  }
  const missing = externalRuntimeDependencies.filter(
    (name) => !(name in ranges),
  );
  if (missing.length)
    throw new Error(
      `External dependencies are not declared by any workspace manifest: ${missing.join(", ")}`,
    );
  return Object.fromEntries(
    Object.entries(ranges).sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function writePackageManifest(
  staging: string,
  metadata: ProductMetadata,
): Promise<void> {
  const manifest = {
    name: "@chriskealley/swf",
    version: metadata.build.productVersion,
    description: "Durable agentic software factory",
    type: "module",
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/chriskealley/swf.git",
    },
    engines: { node: ">=24.0.0" },
    bin: { swf: `./${productLayout.binary}` },
    files: ["bin", "service", "product.json", "LICENSE"],
    publishConfig: { access: "public" },
    dependencies: await declaredDependencyRanges(),
  };
  await writeFile(
    join(staging, productLayout.packageManifest),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

export async function buildProduct(
  options: BuildOptions,
): Promise<{ staging: string; metadata: ProductMetadata }> {
  const staging = options.outputDirectory ?? stagingRoot;
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, "bin"), { recursive: true });
  await buildCli(staging);
  await buildService(staging);
  await buildDashboard(staging);
  const metadata = await writeProductMetadata(staging, options);
  await writePackageManifest(staging, metadata);
  await copyLicense(staging);
  return { staging, metadata };
}

async function main(): Promise<void> {
  const channelArgument = process.argv.find((value) =>
    value.startsWith("--channel="),
  );
  const channel = (channelArgument?.split("=")[1] ??
    "development") as ProductMetadata["build"]["channel"];
  const { staging, metadata } = await buildProduct({ channel });
  process.stdout.write(
    `Assembled ${metadata.build.productVersion} (${metadata.build.channel}) at ${staging}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
