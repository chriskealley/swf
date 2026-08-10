import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse, stringify } from "yaml";

export interface CheckCandidate {
  id: string;
  command: string;
  source: string;
  proposedPhase: "building" | "reviewing" | "verifying";
  cwd: string;
  timeoutMs: number;
  required: boolean;
  rationale: string;
}

export interface CheckDiscoveryResult {
  root: string;
  candidates: CheckCandidate[];
  warnings: string[];
}

const scriptPhases: Record<string, CheckCandidate["proposedPhase"]> = {
  build: "building",
  typecheck: "verifying",
  lint: "reviewing",
  test: "verifying",
  check: "verifying",
  validate: "verifying",
};

function candidateId(script: string, path: string): string {
  const normalized = path
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `${script}-${normalized || "root"}`;
}

async function readJson(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function discoverProjectChecks(
  root: string,
): Promise<CheckDiscoveryResult> {
  const candidates: CheckCandidate[] = [];
  const warnings: string[] = [];
  const manifests: string[] = [];
  const packagePath = join(root, "package.json");
  if (await isFile(packagePath)) manifests.push(packagePath);
  for (const name of ["pyproject.toml", "go.mod", "Cargo.toml", "Makefile"]) {
    if (await isFile(join(root, name))) manifests.push(join(root, name));
  }

  const packageJson = await readJson(packagePath);
  const scripts = packageJson?.scripts;
  if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
    for (const [name, command] of Object.entries(
      scripts as Record<string, unknown>,
    )) {
      const phase = scriptPhases[name];
      if (!phase || typeof command !== "string" || !command.trim()) continue;
      candidates.push({
        id: candidateId(name, "package"),
        command: `pnpm run ${name}`,
        source: relative(root, packagePath),
        proposedPhase: phase,
        cwd: root,
        timeoutMs: phase === "verifying" ? 15 * 60_000 : 10 * 60_000,
        required: ["test", "typecheck", "check", "validate"].includes(name),
        rationale: `package.json script ${name}: ${command}`,
      });
    }
  }
  if (
    manifests.length &&
    !packageJson &&
    manifests.some((path) => path.endsWith("Makefile"))
  ) {
    candidates.push({
      id: candidateId("make-check", "Makefile"),
      command: "make check",
      source: "Makefile",
      proposedPhase: "verifying",
      cwd: root,
      timeoutMs: 15 * 60_000,
      required: true,
      rationale:
        "recognized Makefile; command requires operator review before adoption",
    });
  }
  if (!manifests.length)
    warnings.push("No recognized project manifest was found");
  if (!candidates.length)
    warnings.push(
      "No conventional build, typecheck, lint, test, or validation candidates were found",
    );
  return { root, candidates, warnings };
}

export interface CheckAdoptionPreview {
  candidates: CheckCandidate[];
  writes: Array<{
    phase: string;
    path: string;
    command: string;
    required: boolean;
  }>;
  requiresConfirmation: true;
}

export function previewCheckAdoption(
  candidates: CheckCandidate[],
  selectedIds: string[],
  configPath = ".swf/workflows/default.yaml",
): CheckAdoptionPreview {
  const selected = candidates.filter(({ id }) => selectedIds.includes(id));
  return {
    candidates: selected,
    writes: selected.map((candidate) => ({
      phase: candidate.proposedPhase,
      path: configPath,
      command: candidate.command,
      required: candidate.required,
    })),
    requiresConfirmation: true,
  };
}

/** Apply only a previously reviewed selection. Discovery and preview remain read-only. */
export async function applyCheckAdoption(input: {
  root: string;
  configPath?: string;
  candidates: CheckCandidate[];
  selectedIds: string[];
  confirmed: boolean;
}): Promise<{ path: string; adopted: CheckCandidate[] }> {
  if (!input.confirmed)
    throw new Error("Check adoption requires explicit confirmation");
  const selected = input.candidates.filter(({ id }) =>
    input.selectedIds.includes(id),
  );
  if (!selected.length)
    throw new Error("No discovered checks were selected for adoption");
  const path = join(
    input.root,
    input.configPath ?? ".swf/workflows/default.yaml",
  );
  const workflow = parse(await readFile(path, "utf8")) as {
    phases?: Array<{ id: string; checks?: Array<Record<string, unknown>> }>;
  };
  if (!Array.isArray(workflow.phases))
    throw new Error("Workflow has no phases to update");
  for (const candidate of selected) {
    const phase = workflow.phases.find(
      ({ id }) => id === candidate.proposedPhase,
    );
    if (!phase)
      throw new Error(`Workflow has no ${candidate.proposedPhase} phase`);
    phase.checks ??= [];
    if (phase.checks.some((check) => check.id === candidate.id)) continue;
    phase.checks.push({
      id: candidate.id,
      type: "command",
      required: candidate.required,
      command: candidate.command,
      options: { source: candidate.source, timeoutMs: candidate.timeoutMs },
    });
  }
  const temporary = `${path}.${process.pid}.adoption.tmp`;
  await mkdir(join(input.root, ".swf"), { recursive: true, mode: 0o700 });
  await writeFile(temporary, stringify(workflow), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
  return { path, adopted: selected };
}

export function assertChecksAdopted(input: {
  expectedCodeVerification: boolean;
  checks: Array<{ type: string; required: boolean }>;
}): void {
  if (
    input.expectedCodeVerification &&
    !input.checks.some(({ type, required }) => required && type === "command")
  )
    throw new Error(
      "Verification gap: no required project command checks have been adopted",
    );
}
