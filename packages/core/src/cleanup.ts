import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Cleanup scopes. Each is selected explicitly: nothing is implied by removing
 * the package or the managed service, and no scope ever includes another.
 */
export type CleanupScope =
  | "service-metadata"
  | "credentials"
  | "logs"
  | "caches"
  | "development-instances"
  | "project-state";

export const CLEANUP_SCOPES: readonly CleanupScope[] = [
  "service-metadata",
  "credentials",
  "logs",
  "caches",
  "development-instances",
  "project-state",
] as const;

export interface CleanupCandidate {
  path: string;
  scope: CleanupScope;
  /** Why SWF considers this path its own to remove. */
  ownership: string;
  /** What removing it costs the user. */
  effect: string;
  bytes: number;
  exists: boolean;
}

export interface CleanupPreview {
  confirmationId: string;
  createdAt: string;
  scopes: CleanupScope[];
  candidates: CleanupCandidate[];
  totalBytes: number;
  /** Paths deliberately excluded, so the user can see what survives. */
  preserved: string[];
  warnings: string[];
}

export interface CleanupPreviewInput {
  serviceHome: string;
  scopes: CleanupScope[];
  /** Only these projects may have operational state removed. */
  selectedProjectStateDirectories?: string[];
  /** Present only so the preview can list what it will not touch. */
  knownProjectStateDirectories?: string[];
  checkoutRoot?: string;
  now?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function directorySize(path: string): Promise<number> {
  const stats = await stat(path).catch(() => undefined);
  if (!stats) return 0;
  if (stats.isFile()) return stats.size;
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true }).catch(
    (): [] => [],
  )) {
    total += await directorySize(join(path, entry.name));
  }
  return total;
}

async function candidate(
  path: string,
  scope: CleanupScope,
  ownership: string,
  effect: string,
): Promise<CleanupCandidate> {
  const present = await exists(path);
  return {
    path,
    scope,
    ownership,
    effect,
    bytes: present ? await directorySize(path) : 0,
    exists: present,
  };
}

/**
 * Builds a previewed cleanup plan. Nothing is removed. Every candidate states
 * its ownership basis and effect so a user can judge each one, and the preview
 * also lists what is preserved — most importantly, project state that was not
 * explicitly selected.
 */
export async function previewCleanup(
  input: CleanupPreviewInput,
): Promise<CleanupPreview> {
  const scopes = [...new Set(input.scopes)];
  const candidates: CleanupCandidate[] = [];
  const preserved: string[] = [];
  const warnings: string[] = [];

  if (scopes.includes("service-metadata"))
    for (const name of ["service.json", "service.lock", "projects.json"])
      candidates.push(
        await candidate(
          join(input.serviceHome, name),
          "service-metadata",
          "written by the SWF service in its own home",
          name === "projects.json"
            ? "registered projects must be re-registered; project files are untouched"
            : "the running service must be restarted",
        ),
      );

  if (scopes.includes("credentials")) {
    candidates.push(
      await candidate(
        join(input.serviceHome, "service.json"),
        "credentials",
        "holds the loopback bearer credential",
        "any connected dashboard or CLI session must reconnect",
      ),
      await candidate(
        join(input.serviceHome, "trusted-projects.json"),
        "credentials",
        "records which project roots you explicitly trusted",
        "each project must be trusted again with swf init --trust",
      ),
    );
  }

  if (scopes.includes("logs"))
    candidates.push(
      await candidate(
        join(input.serviceHome, "logs"),
        "logs",
        "service stdout and stderr written by SWF",
        "recent diagnostics are lost; audit history is preserved separately",
      ),
    );

  if (scopes.includes("caches"))
    candidates.push(
      await candidate(
        join(input.serviceHome, "cache"),
        "caches",
        "regenerable data derived from durable state",
        "rebuilt on demand; no durable information is lost",
      ),
    );

  if (scopes.includes("development-instances") && input.checkoutRoot)
    candidates.push(
      await candidate(
        join(input.checkoutRoot, ".swf-dev"),
        "development-instances",
        "contributor development instances created from this checkout",
        "isolated development services, their state, and their logs are removed",
      ),
    );

  if (scopes.includes("project-state"))
    for (const directory of input.selectedProjectStateDirectories ?? [])
      candidates.push(
        await candidate(
          directory,
          "project-state",
          "explicitly selected project operational state",
          "run history, events, artifacts, and raw output for this project are lost",
        ),
      );

  // Audit history is retained even when its own directory is in scope: it is
  // the record of what SWF did, including this cleanup.
  if (!scopes.includes("credentials"))
    preserved.push(join(input.serviceHome, "trusted-projects.json"));
  preserved.push(join(input.serviceHome, "audit.jsonl"));

  const selected = new Set(input.selectedProjectStateDirectories ?? []);
  for (const directory of input.knownProjectStateDirectories ?? [])
    if (!selected.has(directory)) preserved.push(directory);

  if (scopes.includes("project-state") && !selected.size)
    warnings.push(
      "project-state was selected but no project was chosen; no project state will be removed",
    );
  if (scopes.includes("credentials"))
    warnings.push(
      "removing credentials also removes recorded project trust; each project must be trusted again",
    );

  return {
    confirmationId: randomUUID(),
    createdAt: input.now ?? new Date().toISOString(),
    scopes,
    candidates,
    totalBytes: candidates.reduce((sum, entry) => sum + entry.bytes, 0),
    preserved,
    warnings,
  };
}

/** Git configuration is never SWF's to remove. */
export const PRESERVED_ALWAYS = [
  "project .swf/ committed configuration",
  "project .git/ and all Git configuration",
  "exported runs written outside the service home",
] as const;

export function renderCleanupPreview(preview: CleanupPreview): string {
  const lines = [
    `scopes       ${preview.scopes.join(", ") || "(none)"}`,
    `confirmation ${preview.confirmationId}`,
    "",
    "Would remove:",
  ];
  const present = preview.candidates.filter(({ exists }) => exists);
  if (!present.length) lines.push("  (nothing matched the selected scopes)");
  for (const entry of present)
    lines.push(
      `  ${entry.path}`,
      `      scope     ${entry.scope}`,
      `      ownership ${entry.ownership}`,
      `      effect    ${entry.effect}`,
      `      size      ${entry.bytes} bytes`,
    );
  lines.push("", "Preserved:");
  for (const path of [...preview.preserved, ...PRESERVED_ALWAYS])
    lines.push(`  ${path}`);
  if (preview.warnings.length) {
    lines.push("", "Warnings:");
    for (const warning of preview.warnings) lines.push(`  ${warning}`);
  }
  lines.push(
    "",
    "Nothing has been removed. Re-run with --apply and this confirmation id.",
  );
  return lines.join("\n");
}

/** Previews live here so a printed confirmation id can be honoured later. */
export function cleanupPreviewPath(
  serviceHome: string,
  confirmationId: string,
): string {
  return join(serviceHome, "cleanup-previews", `${confirmationId}.json`);
}

/**
 * Persists a preview so the confirmation id printed to the operator binds the
 * exact candidate list. Without this, applying would have to recompute the
 * plan, which could silently widen between review and confirmation.
 */
export async function persistCleanupPreview(
  serviceHome: string,
  preview: CleanupPreview,
): Promise<string> {
  const path = cleanupPreviewPath(serviceHome, preview.confirmationId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(preview, null, 2)}\n`, {
    mode: 0o600,
  });
  return path;
}

export async function loadCleanupPreview(
  serviceHome: string,
  confirmationId: string,
): Promise<CleanupPreview | undefined> {
  try {
    return JSON.parse(
      await readFile(cleanupPreviewPath(serviceHome, confirmationId), "utf8"),
    ) as CleanupPreview;
  } catch {
    return undefined;
  }
}

/** A confirmation is single-use: applying it removes the stored preview. */
export async function discardCleanupPreview(
  serviceHome: string,
  confirmationId: string,
): Promise<void> {
  await rm(cleanupPreviewPath(serviceHome, confirmationId), { force: true });
}

export interface CleanupResult {
  removed: string[];
  skipped: Array<{ path: string; reason: string }>;
  preserved: string[];
}

export class CleanupConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanupConfirmationError";
  }
}

export interface ApplyCleanupInput {
  preview: CleanupPreview;
  /** Must match the preview, so a stale plan can never be applied. */
  confirmationId: string;
  confirmed: boolean;
  /** Rejects a preview older than this. */
  maximumAgeMs?: number;
  now?: string;
}

/**
 * Applies a previously previewed cleanup.
 *
 * The confirmation id binds the exact candidate list, so a plan cannot be
 * reviewed and then silently widened before it is applied. Destructive cleanup
 * therefore requires two separate steps regardless of how it is invoked.
 */
export async function applyCleanup(
  input: ApplyCleanupInput,
): Promise<CleanupResult> {
  if (!input.confirmed)
    throw new CleanupConfirmationError(
      "Refusing destructive cleanup without explicit confirmation",
    );
  if (input.confirmationId !== input.preview.confirmationId)
    throw new CleanupConfirmationError(
      "Confirmation id does not match the reviewed preview; run the preview again",
    );

  const maximumAgeMs = input.maximumAgeMs ?? 5 * 60_000;
  const age =
    new Date(input.now ?? new Date().toISOString()).getTime() -
    new Date(input.preview.createdAt).getTime();
  if (age > maximumAgeMs)
    throw new CleanupConfirmationError(
      "The reviewed preview has expired; run the preview again",
    );

  const removed: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const entry of input.preview.candidates) {
    if (!entry.exists) {
      skipped.push({ path: entry.path, reason: "did not exist" });
      continue;
    }
    await rm(entry.path, { recursive: true, force: true });
    removed.push(entry.path);
  }
  return { removed, skipped, preserved: input.preview.preserved };
}
