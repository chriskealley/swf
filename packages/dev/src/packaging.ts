import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";

export interface PackedArtifact {
  name: string;
  version: string;
  filename: string;
  tarballPath: string;
  /** npm's own digests, retained so publication can be matched to this pack. */
  shasum: string;
  integrity: string;
  /** Computed independently of npm so evidence does not rest on one tool. */
  sha256: string;
  entryCount: number;
  unpackedBytes: number;
  files: Array<{ path: string; bytes: number }>;
}

export interface PackOptions {
  packageDirectory: string;
  destinationDirectory: string;
  packageManager?: string;
}

interface NpmPackReport {
  id: string;
  name: string;
  version: string;
  filename: string;
  shasum: string;
  integrity: string;
  entryCount: number;
  unpackedSize: number;
  files: Array<{ path: string; size: number }>;
}

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Packs a staged package and records both npm's digests and an independently
 * computed SHA-256. Publication later promotes exactly this identity, so the
 * digest must not depend on re-running the build.
 */
export async function packArtifact(
  options: PackOptions,
): Promise<PackedArtifact> {
  const manager = options.packageManager ?? "npm";
  const result = await run(
    manager,
    [
      "pack",
      "--json",
      "--pack-destination",
      options.destinationDirectory,
      "--silent",
    ],
    options.packageDirectory,
  );
  if (result.code !== 0)
    throw new Error(`${manager} pack failed: ${result.stderr.trim()}`);

  // npm may emit warnings before the JSON payload; take the JSON array only.
  const start = result.stdout.indexOf("[");
  if (start === -1) throw new Error(`${manager} pack produced no JSON report`);
  const [report] = JSON.parse(result.stdout.slice(start)) as NpmPackReport[];
  if (!report) throw new Error(`${manager} pack produced an empty report`);

  const tarballPath = join(options.destinationDirectory, report.filename);
  const sha256 = createHash("sha256")
    .update(await readFile(tarballPath))
    .digest("hex");

  return {
    name: report.name,
    version: report.version,
    filename: report.filename,
    tarballPath,
    shasum: report.shasum,
    integrity: report.integrity,
    sha256,
    entryCount: report.entryCount,
    unpackedBytes: report.unpackedSize,
    files: report.files.map(({ path, size }) => ({ path, bytes: size })),
  };
}

export interface PackedInspection {
  violations: string[];
}

/**
 * Inspects what npm would actually publish. The staged directory can be clean
 * while the packed tarball is not, because `files`, `.npmignore`, and npm's own
 * always-included paths all affect the result.
 */
export function inspectPackedArtifact(
  packed: PackedArtifact,
  expectations: {
    forbiddenPatterns: RegExp[];
    requiredPaths: string[];
    maximumBytes: number;
    expectedName: string;
  },
): PackedInspection {
  const violations: string[] = [];
  const paths = packed.files.map(({ path }) => path);

  if (packed.name !== expectations.expectedName)
    violations.push(
      `packed name ${packed.name} does not match ${expectations.expectedName}`,
    );

  for (const required of expectations.requiredPaths)
    if (!paths.includes(required))
      violations.push(`packed tarball is missing ${required}`);

  for (const path of paths)
    for (const pattern of expectations.forbiddenPatterns)
      if (pattern.test(path))
        violations.push(`packed tarball contains forbidden path ${path}`);

  if (packed.unpackedBytes > expectations.maximumBytes)
    violations.push(
      `unpacked size ${packed.unpackedBytes} exceeds ${expectations.maximumBytes}`,
    );

  if (!/^[a-f0-9]{64}$/.test(packed.sha256))
    violations.push("artifact digest is not a SHA-256 hex digest");

  return { violations };
}

export interface ReleaseEvidence {
  schemaVersion: 1;
  createdAt: string;
  source: { commit: string; dirty: boolean; branch?: string };
  toolchain: { node: string; packageManager: string };
  lockfile: { path: string; sha256: string };
  product: {
    name: string;
    version: string;
    channel: string;
    publishable: boolean;
  };
  artifacts: Array<{
    name: string;
    filename: string;
    sha256: string;
    integrity: string;
    entryCount: number;
    unpackedBytes: number;
  }>;
  tests: Array<{ suite: string; passed: boolean; detail?: string }>;
  provenance: { requested: boolean; environment?: string };
  destinations: string[];
}

export async function fileDigest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/**
 * Release evidence must let an operator trace a published version back to a
 * source commit without relying on mutable CI logs, so every input identity is
 * recorded alongside the artifact digests.
 */
export function createReleaseEvidence(
  input: Omit<ReleaseEvidence, "schemaVersion" | "createdAt"> & {
    createdAt?: string;
  },
): ReleaseEvidence {
  const { createdAt, ...rest } = input;
  return {
    schemaVersion: 1,
    createdAt: createdAt ?? new Date().toISOString(),
    ...rest,
  };
}

/** ISO-8601 timestamps embedded by a generator, not derived from source. */
const EMBEDDED_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

/**
 * Decides whether two versions of a file differ only by embedded timestamps.
 * Reporting a difference as "known nondeterminism" is only honest if it has
 * been checked, so this normalizes timestamps and re-compares the content
 * rather than trusting the file's name or path.
 */
export type DifferenceClass = "timestamps-only" | "reordered" | "content";

/**
 * Classifies why two builds of one file differ.
 *
 * Generators embed build timestamps, and some emit collections in filesystem
 * iteration order, so an otherwise identical build can produce a byte-different
 * file. Both are checked rather than assumed: timestamps are normalized, and
 * "reordered" is only returned when the two files contain exactly the same
 * lines in a different sequence. Anything else is a real content change.
 */
export function classifyDifference(
  first: string,
  second: string,
): DifferenceClass {
  if (first === second) return "timestamps-only";
  const left = first.replace(EMBEDDED_TIMESTAMP, "");
  const right = second.replace(EMBEDDED_TIMESTAMP, "");
  if (left === right) return "timestamps-only";
  if (left.length !== right.length) return "content";
  const sortedLeft = left.split("\n").sort().join("\n");
  const sortedRight = right.split("\n").sort().join("\n");
  return sortedLeft === sortedRight ? "reordered" : "content";
}

export interface ReproducibilityReport {
  identical: boolean;
  matchedFiles: number;
  differingFiles: string[];
  /** Differences that are expected and do not indicate a build change. */
  knownNondeterminism: string[];
}

/**
 * Tar archives embed modification times and the packing order can vary, so an
 * archive digest is not by itself proof of a reproducible build. Comparing the
 * per-file content digests is the meaningful check; archive-level metadata is
 * reported separately rather than treated as a failure.
 */
export function compareReproducibility(
  first: Array<{ path: string; sha256: string }>,
  second: Array<{ path: string; sha256: string }>,
  archiveDigestsMatch: boolean,
): ReproducibilityReport {
  const left = new Map(first.map(({ path, sha256 }) => [path, sha256]));
  const right = new Map(second.map(({ path, sha256 }) => [path, sha256]));
  const differingFiles: string[] = [];
  let matchedFiles = 0;

  for (const [path, digest] of left) {
    const other = right.get(path);
    if (other === undefined) differingFiles.push(`${path} (missing in second)`);
    else if (other !== digest) differingFiles.push(path);
    else matchedFiles += 1;
  }
  for (const path of right.keys())
    if (!left.has(path)) differingFiles.push(`${path} (missing in first)`);

  const knownNondeterminism: string[] = [];
  if (!archiveDigestsMatch && differingFiles.length === 0)
    knownNondeterminism.push(
      "archive digests differ while every file digest matches: tar embeds modification times and entry ordering",
    );

  return {
    identical: differingFiles.length === 0,
    matchedFiles,
    differingFiles,
    knownNondeterminism,
  };
}

export interface PublishabilityDecision {
  publishable: boolean;
  label: "publishable" | "development-only";
  reasons: string[];
}

/**
 * A stable release must be traceable to an exact clean commit. A dirty tree is
 * still allowed to produce an artifact, but it is labelled non-publishable so a
 * later promotion step cannot mistake it for a release candidate.
 */
export function decidePublishability(input: {
  channel: string;
  sourceDirty: boolean;
  version: string;
}): PublishabilityDecision {
  const reasons: string[] = [];
  if (input.sourceDirty) reasons.push("the working tree is dirty");
  if (input.channel === "development")
    reasons.push("the build channel is development");
  const prerelease = input.version.includes("-");
  if (input.channel === "stable" && prerelease)
    reasons.push("a stable release must not use a prerelease version");
  if (input.channel === "next" && !prerelease)
    reasons.push("a next release requires a prerelease version");
  return {
    publishable: reasons.length === 0,
    label: reasons.length === 0 ? "publishable" : "development-only",
    reasons,
  };
}

/** Per-file digests of a staged directory, for reproducibility comparison. */
export async function stagedFileDigests(
  root: string,
  from = root,
): Promise<Array<{ path: string; sha256: string }>> {
  const entries: Array<{ path: string; sha256: string }> = [];
  for (const item of await readdir(from, { withFileTypes: true })) {
    const absolute = join(from, item.name);
    if (item.isDirectory()) {
      if (item.name === "node_modules") continue;
      entries.push(...(await stagedFileDigests(root, absolute)));
      continue;
    }
    const stats = await stat(absolute);
    if (!stats.isFile()) continue;
    entries.push({
      path: relative(root, absolute).split(sep).join(posix.sep),
      sha256: await fileDigest(absolute),
    });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}
