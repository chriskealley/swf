import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import picomatch from "picomatch";
import {
  externalRuntimeDependencies,
  forbiddenRuntimeDependencies,
  packageSizeBudgetBytes,
  productLayout,
  stagingRoot,
} from "./product-layout.js";

export { packageSizeBudgetBytes };

/**
 * Everything the product is allowed to ship. Assembly starts from an empty
 * directory, but an allowlist additionally catches anything a build step emits
 * unexpectedly — safer than excluding known-bad paths, which fails open.
 */
export const contentAllowlist = [
  "package.json",
  "product.json",
  "LICENSE",
  "manifest.json",
  "bin/swf.mjs",
  "bin/swf.mjs.map",
  "bin/product.json",
  "service/server/index.mjs",
  "service/server/index.mjs.map",
  "service/server/product.json",
  "service/server/chunks/**",
  "service/public/dashboard/**",
] as const;

/**
 * Paths that must never appear regardless of the allowlist. Operational state
 * and credentials would be a disclosure; TypeScript sources would mean the
 * product still depends on a source checkout.
 */
export const forbiddenContent = [
  "**/.swf-state/**",
  "**/.swf-dev/**",
  "**/.env",
  "**/.env.*",
  "**/*.log",
  "**/logs/**",
  "**/coverage/**",
  "**/node_modules/**",
  "**/*.ts",
  "**/*.tsx",
  "**/*.vue",
  "**/test/**",
  "**/__tests__/**",
  "**/*.test.*",
  "**/fixtures/**",
  "**/service.json",
  "**/credential*",
  "**/*.pem",
  "**/*.key",
  "**/.git/**",
  "**/.DS_Store",
] as const;

export interface ManifestEntry {
  path: string;
  bytes: number;
  mode: string;
  sha256: string;
}

export interface VerificationResult {
  entries: ManifestEntry[];
  totalBytes: number;
  violations: string[];
}

async function walk(root: string, directory = root): Promise<string[]> {
  const found: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, item.name);
    if (item.isDirectory()) found.push(...(await walk(root, absolute)));
    else found.push(relative(root, absolute).split(sep).join(posix.sep));
  }
  return found.sort();
}

async function describe(
  root: string,
  relativePath: string,
): Promise<ManifestEntry> {
  const absolute = join(root, relativePath.split(posix.sep).join(sep));
  const [stats, contents] = await Promise.all([
    stat(absolute),
    readFile(absolute),
  ]);
  return {
    path: relativePath,
    bytes: stats.size,
    mode: (stats.mode & 0o777).toString(8).padStart(4, "0"),
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

/**
 * Validates the published manifest independently of file content: a package can
 * contain only allowed files and still be uninstallable if it declares a
 * workspace dependency or points `bin` at TypeScript.
 */
async function verifyManifest(root: string): Promise<string[]> {
  const violations: string[] = [];
  const manifest = JSON.parse(
    await readFile(join(root, productLayout.packageManifest), "utf8"),
  ) as {
    name?: string;
    version?: string;
    license?: string;
    engines?: { node?: string };
    bin?: Record<string, string>;
    dependencies?: Record<string, string>;
    files?: string[];
    repository?: unknown;
    publishConfig?: { access?: string };
  };

  if (!manifest.name?.startsWith("@")) violations.push("name must be scoped");
  if (!manifest.version) violations.push("version is missing");
  if (manifest.license !== "MIT")
    violations.push(`license must be MIT, found ${manifest.license}`);
  if (!manifest.repository) violations.push("repository metadata is missing");
  if (!manifest.engines?.node?.includes("24"))
    violations.push("engines.node must declare the Node 24 baseline");
  if (manifest.publishConfig?.access !== "public")
    violations.push("scoped publication requires publishConfig.access=public");
  if (!manifest.files?.length) violations.push("files allowlist is missing");

  const binTarget = manifest.bin?.swf;
  if (!binTarget) violations.push("bin.swf is missing");
  else if (!binTarget.endsWith(".mjs"))
    violations.push(
      `bin.swf must target compiled JavaScript, found ${binTarget}`,
    );

  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (range.startsWith("workspace:"))
      violations.push(`${name} uses the workspace protocol`);
    if (name.startsWith("@swf/"))
      violations.push(`${name} is an unpublished internal package`);
    if ((forbiddenRuntimeDependencies as readonly string[]).includes(name))
      violations.push(`${name} is a build-only tool declared at runtime`);
  }
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  for (const required of externalRuntimeDependencies)
    if (!declared.has(required))
      violations.push(`${required} is used at runtime but not declared`);

  // A package manager must never restart a service, migrate state, or touch
  // committed project configuration as a side effect of installation, so the
  // published manifest carries no lifecycle scripts at all.
  const forbiddenScripts = [
    "preinstall",
    "install",
    "postinstall",
    "prepare",
    "prepublish",
    "preuninstall",
    "uninstall",
    "postuninstall",
  ];
  const scripts = (manifest as { scripts?: Record<string, string> }).scripts;
  for (const name of forbiddenScripts)
    if (scripts && name in scripts)
      violations.push(
        `published manifest declares a ${name} lifecycle script; installation must have no side effects`,
      );

  const licensed = await readFile(join(root, productLayout.license), "utf8");
  if (!licensed.includes("MIT License"))
    violations.push("LICENSE does not contain the MIT licence text");

  return violations;
}

/**
 * Internal packages must stay unpublished. Publishing one because the product
 * ships would create an implied SDK contract the project has not committed to.
 */
export async function verifyInternalPackagesPrivate(
  root: string,
): Promise<string[]> {
  const internal = [
    join("packages", "core"),
    join("packages", "integrations"),
    join("apps", "cli"),
    join("apps", "service"),
    join("apps", "dashboard"),
    join("extensions", "pi"),
  ];
  const violations: string[] = [];
  for (const directory of internal) {
    const manifest = JSON.parse(
      await readFile(join(root, directory, "package.json"), "utf8"),
    ) as { name?: string; private?: boolean };
    if (manifest.private !== true)
      violations.push(`${manifest.name ?? directory} is not marked private`);
  }
  return violations;
}

export async function verifyProduct(
  root = stagingRoot,
): Promise<VerificationResult> {
  const files = (await walk(root)).filter(
    (path) => path !== productLayout.manifest,
  );
  const allowed = picomatch([...contentAllowlist], { dot: true });
  const forbidden = picomatch([...forbiddenContent], { dot: true });
  const violations: string[] = [];

  for (const path of files) {
    if (forbidden(path)) violations.push(`forbidden content: ${path}`);
    else if (!allowed(path)) violations.push(`unexpected content: ${path}`);
  }

  const entries = await Promise.all(files.map((path) => describe(root, path)));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalBytes > packageSizeBudgetBytes)
    violations.push(
      `package is ${totalBytes} bytes, over the ${packageSizeBudgetBytes} byte budget`,
    );

  const binary = entries.find(({ path }) => path === productLayout.binary);
  if (!binary) violations.push(`missing ${productLayout.binary}`);
  if (!entries.some(({ path }) => path === productLayout.serviceEntry))
    violations.push(`missing ${productLayout.serviceEntry}`);
  if (
    !entries.some(({ path }) =>
      path.startsWith(`${posix.join("service", "public", "dashboard")}/`),
    )
  )
    violations.push("missing packaged dashboard assets");

  violations.push(...(await verifyManifest(root)));

  await writeFile(
    join(root, productLayout.manifest),
    `${JSON.stringify({ schemaVersion: 1, totalBytes, entries }, null, 2)}\n`,
  );
  return { entries, totalBytes, violations };
}

async function main(): Promise<void> {
  const { entries, totalBytes, violations } = await verifyProduct();
  process.stdout.write(
    `Inspected ${entries.length} files, ${(totalBytes / 1024).toFixed(0)} KiB\n`,
  );
  if (violations.length) {
    for (const violation of violations)
      process.stderr.write(`  ✗ ${violation}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Package contents verified\n");
}

if (process.argv[1]?.endsWith("verify-product.ts")) await main();
