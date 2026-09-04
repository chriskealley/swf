import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface DependencyRecord {
  name: string;
  version: string;
  license: string;
  /** Direct dependencies are declared by the product; the rest are inherited. */
  direct: boolean;
}

export interface DependencyClosure {
  /** Ranges the product declares, which is what a consumer install resolves. */
  declared: Record<string, string>;
  /** What one particular installation resolved to. Not artifact identity. */
  resolved: DependencyRecord[];
  totalPackages: number;
  licenses: Record<string, number>;
  unknownLicenses: string[];
}

async function readManifest(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function licenseOf(manifest: Record<string, unknown>): string {
  const license = manifest.license;
  if (typeof license === "string") return license;
  if (
    license &&
    typeof license === "object" &&
    typeof (license as { type?: unknown }).type === "string"
  )
    return (license as { type: string }).type;
  const licenses = manifest.licenses;
  if (Array.isArray(licenses) && licenses.length) {
    const first = licenses[0] as { type?: unknown };
    if (typeof first?.type === "string") return first.type;
  }
  return "UNKNOWN";
}

/**
 * Walks an installed dependency tree.
 *
 * The closure is recorded as release evidence but is deliberately *not* part
 * of artifact identity: the product declares version ranges, so a consumer
 * installing later may resolve different versions. Recording it makes version
 * drift diagnosable when a defect cannot be reproduced.
 */
export async function collectDependencyClosure(
  installedPackageDirectory: string,
): Promise<DependencyClosure> {
  const manifest = await readManifest(
    join(installedPackageDirectory, "package.json"),
  );
  const declared = (manifest?.dependencies ?? {}) as Record<string, string>;
  const directNames = new Set(Object.keys(declared));

  const modulesRoot = join(installedPackageDirectory, "node_modules");
  const resolved: DependencyRecord[] = [];

  async function visit(root: string): Promise<void> {
    const entries = await readdir(root, { withFileTypes: true }).catch(
      (): [] => [],
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      const directory = join(root, entry.name);
      // Scoped packages nest one level deeper.
      if (entry.name.startsWith("@")) {
        await visit(directory);
        continue;
      }
      const packageManifest = await readManifest(
        join(directory, "package.json"),
      );
      if (!packageManifest) continue;
      const name = String(packageManifest.name ?? entry.name);
      resolved.push({
        name,
        version: String(packageManifest.version ?? "unknown"),
        license: licenseOf(packageManifest),
        direct: directNames.has(name),
      });
      await visit(join(directory, "node_modules"));
    }
  }
  await visit(modulesRoot);

  resolved.sort((left, right) => left.name.localeCompare(right.name));
  const licenses: Record<string, number> = {};
  for (const record of resolved)
    licenses[record.license] = (licenses[record.license] ?? 0) + 1;

  return {
    declared,
    resolved,
    totalPackages: resolved.length,
    licenses,
    unknownLicenses: resolved
      .filter(({ license }) => license === "UNKNOWN")
      .map(({ name, version }) => `${name}@${version}`),
  };
}

export interface SoftwareBillOfMaterials {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  version: 1;
  metadata: {
    timestamp: string;
    component: {
      type: "application";
      name: string;
      version: string;
      licenses: Array<{ license: { id: string } }>;
    };
  };
  components: Array<{
    type: "library";
    name: string;
    version: string;
    licenses: Array<{ license: { id: string } }>;
    scope: "required";
  }>;
}

/**
 * Emits a CycloneDX bill of materials. The format is chosen because it is
 * consumable by standard scanners; the content is derived from the resolved
 * closure rather than the declared ranges, so it describes what was actually
 * present at verification time.
 */
export function createSbom(input: {
  name: string;
  version: string;
  license: string;
  closure: DependencyClosure;
  createdAt?: string;
}): SoftwareBillOfMaterials {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      timestamp: input.createdAt ?? new Date().toISOString(),
      component: {
        type: "application",
        name: input.name,
        version: input.version,
        licenses: [{ license: { id: input.license } }],
      },
    },
    components: input.closure.resolved.map((record) => ({
      type: "library" as const,
      name: record.name,
      version: record.version,
      licenses: [{ license: { id: record.license } }],
      scope: "required" as const,
    })),
  };
}

export interface ProvenanceContext {
  available: boolean;
  reason?: string;
  repository?: string;
  workflow?: string;
}

/**
 * Registry provenance requires an OIDC-capable trusted CI environment. It is
 * reported rather than assumed, so a stable release fails closed when the
 * environment cannot produce it.
 */
export function detectProvenanceContext(
  environment: NodeJS.ProcessEnv = process.env,
): ProvenanceContext {
  if (environment.GITHUB_ACTIONS !== "true")
    return {
      available: false,
      reason: "not running in GitHub Actions",
    };
  if (!environment.ACTIONS_ID_TOKEN_REQUEST_URL)
    return {
      available: false,
      reason:
        "the workflow does not request an OIDC token; add permissions: id-token: write",
      repository: environment.GITHUB_REPOSITORY,
    };
  return {
    available: true,
    repository: environment.GITHUB_REPOSITORY,
    workflow: environment.GITHUB_WORKFLOW,
  };
}

/**
 * An untrusted pull request must never reach publication credentials. Fork
 * pull requests do not receive secrets from GitHub, but this is checked
 * explicitly rather than relied upon implicitly. Publication begins from a
 * protected main-branch dispatch because the release workflow creates the Git
 * tag only after registry publication succeeds.
 */
export function isTrustedReleaseEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): { trusted: boolean; reason: string } {
  if (environment.GITHUB_ACTIONS !== "true")
    return { trusted: false, reason: "not running in CI" };
  if (environment.GITHUB_EVENT_NAME !== "workflow_dispatch")
    return {
      trusted: false,
      reason: "publication requires an explicit workflow dispatch",
    };
  if (environment.GITHUB_REF !== "refs/heads/main")
    return {
      trusted: false,
      reason: "publication dispatches only from main",
    };
  if (environment.GITHUB_REF_PROTECTED !== "true")
    return {
      trusted: false,
      reason: "the main branch is not protected",
    };
  return {
    trusted: true,
    reason: "manual main-branch run in a protected environment",
  };
}

export interface ChecksumEntry {
  filename: string;
  sha256: string;
}

/** `sha256sum`-compatible so a user can verify a download with standard tools. */
export function renderChecksumFile(entries: ChecksumEntry[]): string {
  return `${entries
    .map(({ sha256, filename }) => `${sha256}  ${filename}`)
    .join("\n")}\n`;
}

export async function npmVersionsPublished(
  packageName: string,
): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["view", packageName, "versions", "--json"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.once("error", () => resolve([]));
    child.once("close", () => {
      try {
        const parsed = JSON.parse(out) as string[] | string;
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {
        // An unpublished package has no versions; that is not an error.
        resolve([]);
      }
    });
  });
}
