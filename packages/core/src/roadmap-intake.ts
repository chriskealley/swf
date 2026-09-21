import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { withFileLock, type LockOptions } from "./event-store.js";
import type { CommandRunner } from "./git.js";
import {
  RoadmapIntakeJournalSchema,
  RoadmapIntakeRecordSchema,
  type DocumentValue,
} from "./schemas.js";

/**
 * The lowest OpenRoad release whose machine-readable operations SWF understands.
 * Older releases predate the versioned `next`/`start` JSON documents, so their
 * output is rejected rather than guessed at.
 */
export const OPENROAD_MINIMUM_VERSION = "0.2.0";

/** The `schemaVersion` every supported OpenRoad JSON document carries. */
export const OPENROAD_SCHEMA_VERSION = 1;

export const OpenRoadItemStatusSchema = z.enum([
  "planned",
  "ready",
  "active",
  "done",
  "cancelled",
]);

export const OpenRoadRoadmapItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: OpenRoadItemStatusSchema,
  workState: z.enum(["available", "blocked", "paused"]).optional(),
  priority: z.number().int(),
  change: z.string().min(1).optional(),
  dependsOn: z.array(z.string().min(1)).default([]),
  blockedBy: z.string().min(1).optional(),
});

export const OpenRoadDiagnosticSchema = z.object({
  severity: z.enum(["info", "error"]),
  code: z.string().min(1),
  message: z.string().min(1),
  target: z.string().min(1).optional(),
});

export const OpenRoadNextResultSchema = z.object({
  schemaVersion: z.literal(OPENROAD_SCHEMA_VERSION),
  root: z.string().min(1),
  item: OpenRoadRoadmapItemSchema.nullable(),
  status: z.array(OpenRoadDiagnosticSchema).default([]),
});

export const OpenRoadStartResultSchema = OpenRoadNextResultSchema.extend({
  change: z
    .object({ name: z.string().min(1), path: z.string().min(1) })
    .nullable(),
  changed: z.boolean(),
});

export type OpenRoadRoadmapItem = z.infer<typeof OpenRoadRoadmapItemSchema>;
export type OpenRoadDiagnostic = z.infer<typeof OpenRoadDiagnosticSchema>;
export type OpenRoadNextResult = z.infer<typeof OpenRoadNextResultSchema>;
export type OpenRoadStartResult = z.infer<typeof OpenRoadStartResultSchema>;

/**
 * Stable intake classifications. They are deliberately coarser than OpenRoad's
 * diagnostic codes so automation can branch on them while the original
 * diagnostics stay attached for humans.
 */
export type OpenRoadFailureKind =
  "invalid-roadmap" | "conflict" | "unavailable";

export type OpenRoadNextOutcome =
  | { kind: "selected"; item: OpenRoadRoadmapItem; result: OpenRoadNextResult }
  | { kind: "no-eligible-work"; diagnostics: OpenRoadDiagnostic[] }
  | { kind: OpenRoadFailureKind; diagnostics: OpenRoadDiagnostic[] };

export type OpenRoadStartOutcome =
  | {
      kind: "linked";
      item: OpenRoadRoadmapItem;
      changeName: string;
      /** False when OpenRoad observed the link already in place. */
      changed: boolean;
      result: OpenRoadStartResult;
    }
  | { kind: OpenRoadFailureKind; diagnostics: OpenRoadDiagnostic[] };

export type OpenRoadDoctorOutcome =
  | { kind: "ready"; summary: string }
  | { kind: OpenRoadFailureKind; diagnostics: OpenRoadDiagnostic[] };

/**
 * OpenRoad reports every refusal as a diagnostic code. Roadmap content problems
 * are `invalid-roadmap`, disagreements about an existing association are
 * `conflict`, and anything else is an environment problem SWF should retry or
 * escalate rather than reinterpret.
 */
const failureKindByCode: Record<string, OpenRoadFailureKind> = {
  roadmap_invalid: "invalid-roadmap",
  roadmap_unreadable: "invalid-roadmap",
  change_already_linked: "conflict",
  item_not_ready: "conflict",
  item_not_found: "conflict",
  dependencies_not_done: "conflict",
  change_not_found: "conflict",
  identity_mismatch: "conflict",
};

export function classifyOpenRoadDiagnostics(
  diagnostics: readonly OpenRoadDiagnostic[],
): OpenRoadFailureKind {
  for (const kind of ["invalid-roadmap", "conflict"] as const) {
    if (diagnostics.some((entry) => failureKindByCode[entry.code] === kind))
      return kind;
  }
  return "unavailable";
}

function diagnostic(
  code: string,
  message: string,
  target?: string,
): OpenRoadDiagnostic {
  return { severity: "error", code, message, ...(target ? { target } : {}) };
}

function parseJsonDocument<T extends z.ZodType>(
  schema: T,
  stdout: string,
):
  | { ok: true; value: z.infer<T> }
  | { ok: false; diagnostic: OpenRoadDiagnostic } {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return {
      ok: false,
      diagnostic: diagnostic(
        "unsupported_output",
        `OpenRoad did not emit a JSON document; SWF requires OpenRoad >=${OPENROAD_MINIMUM_VERSION}.`,
      ),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      diagnostic: diagnostic(
        "unsupported_output",
        `OpenRoad returned an unsupported document shape; SWF requires OpenRoad >=${OPENROAD_MINIMUM_VERSION}: ${parsed.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          )
          .join("; ")}`,
      ),
    };
  return { ok: true, value: parsed.data };
}

export interface OpenRoadAdapter {
  /** Validate that OpenRoad is installed and this project's roadmap parses. */
  doctor(root: string): Promise<OpenRoadDoctorOutcome>;
  /** Ask OpenRoad which item is eligible. SWF never ranks items itself. */
  next(root: string): Promise<OpenRoadNextOutcome>;
  /** Idempotently link an existing OpenSpec change and activate the item. */
  start(
    root: string,
    itemId: string,
    changeName: string,
  ): Promise<OpenRoadStartOutcome>;
}

export interface ProcessOpenRoadAdapterOptions {
  command?: string;
  timeoutMs?: number;
}

/**
 * Invokes the OpenRoad CLI and translates its versioned JSON into intake
 * classifications. Eligibility, ordering, and lifecycle rules stay entirely
 * inside OpenRoad: this adapter only parses and classifies what it is told.
 */
export class ProcessOpenRoadAdapter implements OpenRoadAdapter {
  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly runner: CommandRunner,
    options: ProcessOpenRoadAdapterOptions = {},
  ) {
    this.command = options.command ?? "openroad";
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  private async run(args: string[], root: string) {
    try {
      return await this.runner.run(this.command, args, {
        cwd: root,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      return {
        code: 127,
        stdout: "",
        stderr:
          error instanceof Error
            ? error.message
            : "openroad could not be executed",
      };
    }
  }

  async doctor(root: string): Promise<OpenRoadDoctorOutcome> {
    const result = await this.run(["doctor", "--root", root], root);
    if (result.code === 0)
      return { kind: "ready", summary: result.stdout.trim() };
    const message = (result.stderr.trim() || result.stdout.trim()).replace(
      /^Error:\s*/,
      "",
    );
    if (/roadmap validation failed/i.test(message))
      return {
        kind: "invalid-roadmap",
        diagnostics: [diagnostic("roadmap_invalid", message)],
      };
    return {
      kind: "unavailable",
      diagnostics: [
        diagnostic(
          "command_failed",
          message || `openroad doctor exited with code ${result.code}`,
        ),
      ],
    };
  }

  async next(root: string): Promise<OpenRoadNextOutcome> {
    const result = await this.run(["next", "--json", "--root", root], root);
    const parsed = parseJsonDocument(OpenRoadNextResultSchema, result.stdout);
    if (!parsed.ok)
      return {
        kind: "unavailable",
        diagnostics: [
          parsed.diagnostic,
          ...(result.stderr.trim()
            ? [diagnostic("command_failed", result.stderr.trim())]
            : []),
        ],
      };
    const document = parsed.value;
    if (
      result.code !== 0 ||
      document.status.some((e) => e.severity === "error")
    )
      return {
        kind: classifyOpenRoadDiagnostics(document.status),
        diagnostics: document.status,
      };
    if (!document.item)
      return { kind: "no-eligible-work", diagnostics: document.status };
    return { kind: "selected", item: document.item, result: document };
  }

  async start(
    root: string,
    itemId: string,
    changeName: string,
  ): Promise<OpenRoadStartOutcome> {
    const result = await this.run(
      ["start", itemId, "--change", changeName, "--json", "--root", root],
      root,
    );
    const parsed = parseJsonDocument(OpenRoadStartResultSchema, result.stdout);
    if (!parsed.ok)
      return {
        kind: "unavailable",
        diagnostics: [
          parsed.diagnostic,
          ...(result.stderr.trim()
            ? [diagnostic("command_failed", result.stderr.trim())]
            : []),
        ],
      };
    const document = parsed.value;
    if (result.code !== 0 || !document.item || !document.change)
      return {
        kind: classifyOpenRoadDiagnostics(document.status),
        diagnostics: document.status.length
          ? document.status
          : [
              diagnostic(
                "command_failed",
                `openroad start exited with code ${result.code}`,
              ),
            ],
      };
    // A successful exit is not proof that OpenRoad acted on what was asked
    // for. Recording an association SWF did not request would bind a run to
    // the wrong item, so an identity that drifted is a conflict, not a link.
    const mismatches = [
      document.item.id !== itemId
        ? `item ${document.item.id} instead of ${itemId}`
        : undefined,
      document.change.name !== changeName
        ? `change ${document.change.name} instead of ${changeName}`
        : undefined,
      resolve(document.root) !== resolve(root)
        ? `root ${document.root} instead of ${root}`
        : undefined,
    ].filter((entry): entry is string => Boolean(entry));
    if (mismatches.length)
      return {
        kind: "conflict",
        diagnostics: [
          diagnostic(
            "identity_mismatch",
            `OpenRoad linked ${mismatches.join(", ")}`,
            document.item.id,
          ),
          ...document.status,
        ],
      };
    return {
      kind: "linked",
      item: document.item,
      changeName: document.change.name,
      changed: document.changed,
      result: document,
    };
  }
}

const MAX_CHANGE_NAME_LENGTH = 64;

/**
 * Both SWF and OpenRoad accept lowercase kebab-case, but SWF additionally
 * requires a leading letter, so derivation targets that narrower intersection.
 */
export function slugifyChangeName(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[0-9-]+/, "");
  if (slug.length <= MAX_CHANGE_NAME_LENGTH) return slug;
  const truncated = slug.slice(0, MAX_CHANGE_NAME_LENGTH);
  const boundary = truncated.lastIndexOf("-");
  return (boundary > 0 ? truncated.slice(0, boundary) : truncated).replace(
    /-+$/,
    "",
  );
}

/**
 * Deterministic change-name candidates for a roadmap item, most preferred
 * first. The title alone reads best, so it comes first; the roadmap ID
 * qualifier is the stable fallback when two items share a title. Derivation
 * never consults mutable state, so a recovering process derives the same
 * candidates the original intake did.
 */
export function deriveChangeNameCandidates(
  item: Pick<OpenRoadRoadmapItem, "id" | "title">,
): string[] {
  const idSlug = slugifyChangeName(item.id) || "roadmap-item";
  const titleSlug = slugifyChangeName(item.title);
  const qualified = titleSlug
    ? slugifyChangeName(`${titleSlug}-${idSlug}`)
    : idSlug;
  const candidates = [titleSlug || idSlug, qualified, idSlug].filter(Boolean);
  return [...new Set(candidates)];
}

export function deriveChangeName(
  item: Pick<OpenRoadRoadmapItem, "id" | "title">,
): string {
  return deriveChangeNameCandidates(item)[0]!;
}

export type ChangeNameSelection =
  | { kind: "selected"; changeName: string; reusedExisting: boolean }
  | { kind: "exhausted"; candidates: string[] };

/**
 * Picks the change name for an item. A candidate already owned by this same
 * item is reused so a repeated intake converges, a candidate owned by anything
 * else is skipped in favour of the roadmap-ID-qualified fallback, and running
 * out of candidates is reported rather than resolved by inventing a name.
 */
export function selectChangeName(
  item: Pick<OpenRoadRoadmapItem, "id" | "title">,
  owner: (changeName: string) => string | undefined,
): ChangeNameSelection {
  const candidates = deriveChangeNameCandidates(item);
  for (const changeName of candidates) {
    const existing = owner(changeName);
    if (existing === undefined)
      return { kind: "selected", changeName, reusedExisting: false };
    if (existing === item.id)
      return { kind: "selected", changeName, reusedExisting: true };
  }
  return { kind: "exhausted", candidates };
}

export type RoadmapIntakeRecord = DocumentValue<"roadmapIntakeRecord">;
export type RoadmapIntakeJournalDocument =
  DocumentValue<"roadmapIntakeJournal">;
export type RoadmapIntakeStep = RoadmapIntakeRecord["step"];

/**
 * Ordered so a retry can only ever move an intake record forward. A process
 * that observes state it did not write itself still advances the record, but
 * an already-completed record is never rewound by a slower writer.
 */
export const roadmapIntakeSteps = [
  "intent-recorded",
  "run-created",
  "roadmap-linked",
  "completed",
] as const;

export function compareRoadmapIntakeSteps(
  left: RoadmapIntakeStep,
  right: RoadmapIntakeStep,
): number {
  return roadmapIntakeSteps.indexOf(left) - roadmapIntakeSteps.indexOf(right);
}

const JOURNAL_FILE = "roadmap-intake.json";
const JOURNAL_LOCK = join("locks", "roadmap-intake.lock");

async function writeAtomically(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Durable record of intake intent. No transaction can span the roadmap file,
 * the OpenSpec scaffold, and `.swf-state`, so this journal is the evidence a
 * recovering process uses to tell safe completion from conflicting reuse.
 */
export class RoadmapIntakeJournal {
  constructor(
    readonly stateDirectory: string,
    private readonly lockOptions: LockOptions = {},
  ) {}

  get path(): string {
    return join(this.stateDirectory, JOURNAL_FILE);
  }

  get lockPath(): string {
    return join(this.stateDirectory, JOURNAL_LOCK);
  }

  async read(): Promise<RoadmapIntakeJournalDocument> {
    try {
      return RoadmapIntakeJournalSchema.parse(
        JSON.parse(await readFile(this.path, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { schemaVersion: 1, records: [] };
      throw error;
    }
  }

  /**
   * Serializes every roadmap intake operation for one project. Selection and
   * reconciliation both run inside this lock so two requests cannot race for
   * the same eligible item.
   */
  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    return withFileLock(this.lockPath, operation, this.lockOptions);
  }

  async find(itemId: string): Promise<RoadmapIntakeRecord | undefined> {
    return (await this.read()).records.find(
      (record) => record.itemId === itemId,
    );
  }

  async findByChangeName(
    changeName: string,
  ): Promise<RoadmapIntakeRecord | undefined> {
    return (await this.read()).records.find(
      (record) => record.changeName === changeName,
    );
  }

  async incomplete(): Promise<RoadmapIntakeRecord[]> {
    return (await this.read()).records.filter(
      (record) => record.step !== "completed",
    );
  }

  /**
   * Merges one record into the journal. Callers already hold {@link withLock},
   * but the file is re-read here so a writer that acquired the lock after a
   * crash still merges onto current state rather than its own stale copy.
   */
  async record(
    input: Omit<RoadmapIntakeRecord, "createdAt" | "updatedAt"> &
      Partial<Pick<RoadmapIntakeRecord, "createdAt" | "updatedAt">>,
  ): Promise<RoadmapIntakeRecord> {
    const journal = await this.read();
    const now = new Date().toISOString();
    const index = journal.records.findIndex(
      (record) => record.operationId === input.operationId,
    );
    const previous = index >= 0 ? journal.records[index]! : undefined;
    const next = RoadmapIntakeRecordSchema.parse({
      ...previous,
      ...input,
      step:
        previous && compareRoadmapIntakeSteps(previous.step, input.step) > 0
          ? previous.step
          : input.step,
      runId: input.runId ?? previous?.runId,
      createdAt: previous?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    });
    if (index >= 0) journal.records[index] = next;
    else journal.records.push(next);
    await writeAtomically(
      this.path,
      `${JSON.stringify(RoadmapIntakeJournalSchema.parse(journal), null, 2)}\n`,
    );
    return next;
  }
}
