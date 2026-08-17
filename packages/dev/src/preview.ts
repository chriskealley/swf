import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { DevelopmentInstance } from "./instance.js";

/**
 * Commands that mean the preview is not running the release artifact. Preview
 * exists to be the local bridge to release verification, so serving source
 * through a development server would make it worthless — and worse, misleading.
 */
const DEVELOPMENT_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> =
  [
    { pattern: /(^|\s)tsx(\s|$)/, reason: "runs TypeScript through tsx" },
    { pattern: /--filter/, reason: "uses a pnpm workspace filter" },
    {
      pattern: /(^|\s)nitro\s+dev(\s|$)/,
      reason: "starts the Nitro dev server",
    },
    { pattern: /(^|\s)vite(\s|$)/, reason: "starts a Vite dev server" },
    { pattern: /(^|\s)nodemon(\s|$)/, reason: "starts a watch-mode runner" },
    { pattern: /\.tsx?($|\s)/, reason: "targets TypeScript source" },
  ];

export interface ArtifactViolation {
  id:
    | "missing-artifact"
    | "typescript-source"
    | "development-dependency"
    | "source-bin"
    | "workspace-dependency"
    | "development-command"
    | "source-repository-path";
  detail: string;
}

const DEVELOPMENT_ONLY_DEPENDENCIES = [
  "tsx",
  "vite",
  "nitropack",
  "esbuild",
  "vitest",
  "typescript",
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(root: string, from = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const absolute = join(from, entry.name);
    if (entry.isDirectory()) {
      // A staged package installs its own dependencies; their sources are not
      // the product's and must not fail the product's own checks.
      if (entry.name === "node_modules") continue;
      found.push(...(await collectFiles(root, absolute)));
    } else found.push(relative(root, absolute));
  }
  return found;
}

/**
 * Proves a staged directory is the production artifact rather than a view onto
 * the source checkout. Returns every violation instead of the first, so a
 * contributor sees the whole picture in one run.
 */
export async function inspectPreviewArtifact(
  packageDirectory: string,
  repositoryRoot: string,
): Promise<ArtifactViolation[]> {
  const violations: ArtifactViolation[] = [];
  const manifestPath = join(packageDirectory, "package.json");
  if (!(await exists(manifestPath)))
    return [
      {
        id: "missing-artifact",
        detail: `No package.json under ${packageDirectory}`,
      },
    ];

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    bin?: Record<string, string>;
    dependencies?: Record<string, string>;
  };

  const binTarget = manifest.bin?.swf;
  if (!binTarget)
    violations.push({ id: "source-bin", detail: "bin.swf is not declared" });
  else if (/\.tsx?$/.test(binTarget))
    violations.push({
      id: "source-bin",
      detail: `bin.swf targets TypeScript source: ${binTarget}`,
    });
  else if (!(await exists(join(packageDirectory, binTarget))))
    violations.push({
      id: "missing-artifact",
      detail: `bin.swf target does not exist: ${binTarget}`,
    });

  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (DEVELOPMENT_ONLY_DEPENDENCIES.includes(name))
      violations.push({
        id: "development-dependency",
        detail: `${name} is a development-only dependency`,
      });
    if (range.startsWith("workspace:") || name.startsWith("@swf/"))
      violations.push({
        id: "workspace-dependency",
        detail: `${name} would not resolve outside the workspace`,
      });
  }

  for (const file of await collectFiles(packageDirectory))
    if (/\.tsx?$/.test(file) && !file.endsWith(".d.ts"))
      violations.push({
        id: "typescript-source",
        detail: `staged package contains TypeScript source: ${file}`,
      });

  // A staged package must be self-contained. A symlink or path escaping into
  // the checkout would silently reintroduce source-repository resolution.
  const resolved = await stat(packageDirectory);
  if (!resolved.isDirectory())
    violations.push({
      id: "missing-artifact",
      detail: `${packageDirectory} is not a directory`,
    });
  if (!relative(repositoryRoot, packageDirectory).startsWith(`.swf-dev${sep}`))
    violations.push({
      id: "source-repository-path",
      detail: `preview package must be staged under .swf-dev, found ${packageDirectory}`,
    });

  return violations;
}

/** Rejects a launch command that would serve source instead of the artifact. */
export function inspectPreviewCommand(
  command: string,
  args: string[],
): ArtifactViolation[] {
  const line = [command, ...args].join(" ");
  return DEVELOPMENT_COMMAND_PATTERNS.filter(({ pattern }) =>
    pattern.test(line),
  ).map(({ reason }) => ({
    id: "development-command" as const,
    detail: `preview command ${reason}: ${line}`,
  }));
}

export class PreviewArtifactError extends Error {
  constructor(readonly violations: ArtifactViolation[]) {
    super(
      `Preview artifact is not production-ready:\n${violations
        .map(({ detail }) => `  - ${detail}`)
        .join("\n")}`,
    );
    this.name = "PreviewArtifactError";
  }
}

export async function assertPreviewArtifact(
  packageDirectory: string,
  repositoryRoot: string,
): Promise<void> {
  const violations = await inspectPreviewArtifact(
    packageDirectory,
    repositoryRoot,
  );
  if (violations.length) throw new PreviewArtifactError(violations);
}

export interface PreviewSummary {
  instance: string;
  mode: DevelopmentInstance["mode"];
  productVersion: string;
  channel: string;
  sourceCommit: string;
  sourceDirty: boolean;
  publishable: boolean;
  endpoint: string;
  executable: string;
  serviceEntry: string;
  serviceHome: string;
  logsDirectory: string;
  manifestDigest?: string;
  fileCount?: number;
  totalBytes?: number;
}

/** Everything an operator needs to confirm what preview is actually running. */
export function renderPreviewSummary(summary: PreviewSummary): string {
  const lines = [
    `instance    ${summary.instance} (${summary.mode})`,
    `version     ${summary.productVersion} (${summary.channel})`,
    `commit      ${summary.sourceCommit.slice(0, 12)}${summary.sourceDirty ? "-dirty" : ""}`,
    `publishable ${summary.publishable ? "yes" : "no"}`,
    `endpoint    ${summary.endpoint}`,
    `executable  ${summary.executable}`,
    `service     ${summary.serviceEntry}`,
    `state       ${summary.serviceHome}`,
    `logs        ${summary.logsDirectory}`,
  ];
  if (summary.fileCount !== undefined && summary.totalBytes !== undefined)
    lines.push(
      `artifact    ${summary.fileCount} files, ${(summary.totalBytes / 1024).toFixed(0)} KiB`,
    );
  if (summary.manifestDigest)
    lines.push(`manifest    sha256:${summary.manifestDigest.slice(0, 16)}…`);
  return lines.join("\n");
}
