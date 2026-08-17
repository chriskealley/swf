import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Staging root for an assembled product. Never committed. */
export const stagingRoot = join(repositoryRoot, "dist", "product");

/**
 * Paths inside the assembled package. Runtime asset resolution in
 * `@swf/core` mirrors this layout, so both sides must change together.
 */
export const productLayout = {
  binary: join("bin", "swf.mjs"),
  serviceEntry: join("service", "server", "index.mjs"),
  serviceDirectory: join("service", "server"),
  dashboardDirectory: join("service", "public", "dashboard"),
  productMetadata: "product.json",
  manifest: "manifest.json",
  license: "LICENSE",
  packageManifest: "package.json",
} as const;

/**
 * Third-party packages stay external and are declared by the published
 * manifest, so dependency security patches reach installations without a SWF
 * release. Internal `@swf/*` packages are inlined because they are private and
 * could never be resolved from a consumer installation.
 */
export const externalRuntimeDependencies = [
  "citty",
  "consola",
  "destr",
  "effect",
  "nypm",
  "picomatch",
  "semver",
  "yaml",
  "zod",
] as const;

/** Present in the workspace for development or build only. */
export const forbiddenRuntimeDependencies = [
  "tsx",
  "nitropack",
  "esbuild",
  "vite",
  "vitest",
  "typescript",
] as const;

/** Staging root for the separately installable Pi extension package. */
export const extensionStagingRoot = join(
  repositoryRoot,
  "dist",
  "pi-extension",
);

export const extensionLayout = {
  entry: join("dist", "index.mjs"),
  packageManifest: "package.json",
  license: "LICENSE",
  compatibility: "compatibility.json",
} as const;

/**
 * Pi supplies these to the extension host, so they are peer dependencies rather
 * than bundled copies; two Pi runtimes in one process would be incoherent.
 */
export const extensionPeerDependencies = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
] as const;

/** Bytes. A regression usually means a dependency got inlined. */
export const packageSizeBudgetBytes = 4 * 1024 * 1024;

export async function workspaceVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  ) as { version?: string };
  return manifest.version ?? "0.0.0";
}
