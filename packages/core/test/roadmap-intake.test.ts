import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OpenRoadNextResultSchema,
  OpenRoadStartResultSchema,
  ProcessOpenRoadAdapter,
  RoadmapIntakeJournal,
  classifyOpenRoadDiagnostics,
  compareRoadmapIntakeSteps,
  deriveChangeName,
  deriveChangeNameCandidates,
  selectChangeName,
  parseDocument,
  slugifyChangeName,
  ROADMAP_INTAKE_STATE_VERSION,
  RunEventStore,
  StateMigrationManager,
  roadmapIntakeMigrations,
  type CommandRunner,
  type ProcessResult,
} from "../src/index.js";

const item = {
  id: "RM-004",
  title: "Start roadmap work through SWF",
  status: "ready" as const,
  priority: 4,
  dependsOn: [],
};

class ScriptedRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];

  constructor(private readonly responses: Array<ProcessResult | Error>) {}

  async run(command: string, args: string[]): Promise<ProcessResult> {
    this.calls.push({ command, args });
    const next = this.responses.shift();
    if (!next) throw new Error("no scripted response remains");
    if (next instanceof Error) throw next;
    return next;
  }
}

function processResult(
  code: number,
  stdout: unknown,
  stderr = "",
): ProcessResult {
  return {
    code,
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    stderr,
  };
}

describe("OpenRoad 0.2.0 document schemas", () => {
  it("accepts the documented next and start shapes", () => {
    expect(
      OpenRoadNextResultSchema.parse({
        schemaVersion: 1,
        root: "/repo",
        item,
        status: [],
      }).item?.id,
    ).toBe("RM-004");
    expect(
      OpenRoadStartResultSchema.parse({
        schemaVersion: 1,
        root: "/repo",
        item: { ...item, status: "active", change: "start-roadmap-work" },
        change: {
          name: "start-roadmap-work",
          path: "/repo/openspec/changes/x",
        },
        changed: true,
        status: [],
      }).changed,
    ).toBe(true);
  });

  it("rejects an unsupported schema version", () => {
    expect(
      OpenRoadNextResultSchema.safeParse({
        schemaVersion: 2,
        root: "/repo",
        item: null,
        status: [],
      }).success,
    ).toBe(false);
  });

  it("rejects a malformed item", () => {
    expect(
      OpenRoadNextResultSchema.safeParse({
        schemaVersion: 1,
        root: "/repo",
        item: { id: "RM-004", title: "x", status: "unknown", priority: 1 },
        status: [],
      }).success,
    ).toBe(false);
  });

  it("classifies diagnostics into stable intake categories", () => {
    const of = (code: string) =>
      classifyOpenRoadDiagnostics([{ severity: "error", code, message: "m" }]);
    expect(of("roadmap_invalid")).toBe("invalid-roadmap");
    expect(of("change_already_linked")).toBe("conflict");
    expect(of("roadmap_locked")).toBe("unavailable");
    expect(classifyOpenRoadDiagnostics([])).toBe("unavailable");
  });
});

describe("ProcessOpenRoadAdapter", () => {
  it("returns the item OpenRoad selected without re-ranking", async () => {
    const runner = new ScriptedRunner([
      processResult(0, { schemaVersion: 1, root: "/repo", item, status: [] }),
    ]);
    const outcome = await new ProcessOpenRoadAdapter(runner).next("/repo");
    expect(outcome.kind).toBe("selected");
    expect(outcome.kind === "selected" && outcome.item.id).toBe("RM-004");
    expect(runner.calls[0]?.args).toEqual([
      "next",
      "--json",
      "--root",
      "/repo",
    ]);
  });

  it("reports no eligible work with OpenRoad's own diagnostics", async () => {
    const outcome = await new ProcessOpenRoadAdapter(
      new ScriptedRunner([
        processResult(0, {
          schemaVersion: 1,
          root: "/repo",
          item: null,
          status: [
            {
              severity: "info",
              code: "no_ready_items",
              message: "No roadmap items are ready.",
            },
          ],
        }),
      ]),
    ).next("/repo");
    expect(outcome.kind).toBe("no-eligible-work");
    expect(
      outcome.kind === "no-eligible-work" && outcome.diagnostics[0]?.code,
    ).toBe("no_ready_items");
  });

  it("classifies an invalid roadmap", async () => {
    const outcome = await new ProcessOpenRoadAdapter(
      new ScriptedRunner([
        processResult(1, {
          schemaVersion: 1,
          root: "/repo",
          item: null,
          status: [
            {
              severity: "error",
              code: "roadmap_invalid",
              message: "RM-009: duplicate id",
            },
          ],
        }),
      ]),
    ).next("/repo");
    expect(outcome.kind).toBe("invalid-roadmap");
  });

  it("classifies an unparseable response as unavailable", async () => {
    const outcome = await new ProcessOpenRoadAdapter(
      new ScriptedRunner([processResult(0, "not json at all")]),
    ).next("/repo");
    expect(outcome.kind).toBe("unavailable");
    expect(outcome.kind !== "selected" && outcome.diagnostics[0]?.code).toBe(
      "unsupported_output",
    );
  });

  it("preserves a spawn failure as a diagnostic instead of throwing", async () => {
    const outcome = await new ProcessOpenRoadAdapter(
      new ScriptedRunner([new Error("spawn openroad ENOENT")]),
    ).next("/repo");
    expect(outcome.kind).toBe("unavailable");
  });

  it("treats a repeated start as an idempotent no-op link", async () => {
    const outcome = await new ProcessOpenRoadAdapter(
      new ScriptedRunner([
        processResult(0, {
          schemaVersion: 1,
          root: "/repo",
          item: { ...item, status: "active", change: "start-roadmap-work" },
          change: { name: "start-roadmap-work", path: "/repo/c" },
          changed: false,
          status: [],
        }),
      ]),
    ).start("/repo", "RM-004", "start-roadmap-work");
    expect(outcome.kind).toBe("linked");
    expect(outcome.kind === "linked" && outcome.changed).toBe(false);
  });

  it("classifies a change already linked to another item as a conflict", async () => {
    const outcome = await new ProcessOpenRoadAdapter(
      new ScriptedRunner([
        processResult(1, {
          schemaVersion: 1,
          root: "/repo",
          item: null,
          change: null,
          changed: false,
          status: [
            {
              severity: "error",
              code: "change_already_linked",
              message: "start-roadmap-work is already linked to RM-002",
            },
          ],
        }),
      ]),
    ).start("/repo", "RM-004", "start-roadmap-work");
    expect(outcome.kind).toBe("conflict");
  });

  it("reports doctor readiness and roadmap invalidity separately", async () => {
    expect(
      (
        await new ProcessOpenRoadAdapter(
          new ScriptedRunner([processResult(0, "Healthy: 8 roadmap item(s).")]),
        ).doctor("/repo")
      ).kind,
    ).toBe("ready");
    expect(
      (
        await new ProcessOpenRoadAdapter(
          new ScriptedRunner([
            processResult(1, "", "Error: Roadmap validation failed:\n- bad"),
          ]),
        ).doctor("/repo")
      ).kind,
    ).toBe("invalid-roadmap");
    expect(
      (
        await new ProcessOpenRoadAdapter(
          new ScriptedRunner([
            processResult(
              1,
              "",
              "Error: Manifest is missing; run `openroad init`",
            ),
          ]),
        ).doctor("/repo")
      ).kind,
    ).toBe("unavailable");
  });
});

describe("change-name derivation", () => {
  it("derives a deterministic kebab-case name from the title", () => {
    expect(deriveChangeName(item)).toBe("start-roadmap-work-through-swf");
    expect(deriveChangeName(item)).toBe(deriveChangeName({ ...item }));
  });

  it("strips punctuation and collapses separators", () => {
    expect(
      deriveChangeName({ id: "RM-1", title: "Add  OAuth2 / OIDC  (login!)" }),
    ).toBe("add-oauth2-oidc-login");
  });

  it("produces a leading letter even for numeric titles", () => {
    expect(slugifyChangeName("2024 cleanup")).toBe("cleanup");
    expect(deriveChangeName({ id: "RM-7", title: "2024" })).toBe("rm-7");
  });

  it("offers a roadmap-id-qualified fallback for duplicate titles", () => {
    const left = deriveChangeNameCandidates({ id: "RM-1", title: "Add auth" });
    const right = deriveChangeNameCandidates({ id: "RM-2", title: "Add auth" });
    expect(left[0]).toBe(right[0]);
    expect(left[1]).toBe("add-auth-rm-1");
    expect(right[1]).toBe("add-auth-rm-2");
    expect(new Set(left).size).toBe(left.length);
  });

  it("bounds long titles at a separator", () => {
    const name = deriveChangeName({
      id: "RM-9",
      title:
        "Reconcile every partially started roadmap intake operation safely",
    });
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.endsWith("-")).toBe(false);
    expect(/^[a-z][a-z0-9-]*$/.test(name)).toBe(true);
  });
});

describe("roadmap provenance on durable run state", () => {
  let stateDirectory: string;

  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "swf-roadmap-"));
  });
  afterEach(async () => {
    await rm(stateDirectory, { recursive: true, force: true });
  });

  it("records the item, change, and operation with the run", async () => {
    const store = new RunEventStore(stateDirectory);
    const operationId = randomUUID();
    const run = await store.create({
      projectId: randomUUID(),
      changeName: "start-roadmap-work-through-swf",
      changeIdentity: "openspec/changes/start-roadmap-work-through-swf",
      workflowId: "default",
      description: "Start RM-004",
      phaseIds: ["planning"],
      roadmap: {
        source: "openroad",
        itemId: "RM-004",
        itemTitle: item.title,
        operationId,
        linkedAt: new Date().toISOString(),
      },
    });
    expect(run.roadmap?.itemId).toBe("RM-004");
    const loaded = await store.load(run.runId);
    expect(loaded.run.roadmap?.operationId).toBe(operationId);
    const created = loaded.events[0]!;
    expect(created.type).toBe("run.created");
    expect(
      created.type === "run.created" ? created.data.roadmap : undefined,
    ).toMatchObject({ itemId: "RM-004" });
  });

  it("loads a legacy direct-entry run document unchanged", async () => {
    const store = new RunEventStore(stateDirectory);
    const run = await store.create({
      projectId: randomUUID(),
      changeName: "direct-entry",
      changeIdentity: "openspec/changes/direct-entry",
      workflowId: "default",
      description: "Direct entry",
      phaseIds: ["planning"],
    });
    expect(run.roadmap).toBeUndefined();
    const raw = JSON.parse(
      await readFile(
        join(stateDirectory, "runs", run.runId, "run.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect("roadmap" in raw).toBe(false);
    expect(parseDocument("run", raw).changeName).toBe("direct-entry");
    expect((await store.load(run.runId)).run.roadmap).toBeUndefined();
  });
});

describe("RoadmapIntakeJournal", () => {
  let stateDirectory: string;

  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "swf-journal-"));
  });
  afterEach(async () => {
    await rm(stateDirectory, { recursive: true, force: true });
  });

  it("returns an empty journal before anything is written", async () => {
    expect(
      (await new RoadmapIntakeJournal(stateDirectory).read()).records,
    ).toEqual([]);
  });

  it("advances step state monotonically and never rewinds", async () => {
    const journal = new RoadmapIntakeJournal(stateDirectory);
    const operationId = randomUUID();
    const runId = randomUUID();
    const base = {
      operationId,
      itemId: "RM-004",
      changeName: "start-roadmap-work-through-swf",
      mode: "planning-only" as const,
    };
    await journal.record({ ...base, step: "intent-recorded" });
    await journal.record({ ...base, step: "run-created", runId });
    const rewound = await journal.record({ ...base, step: "intent-recorded" });
    expect(rewound.step).toBe("run-created");
    expect(rewound.runId).toBe(runId);
    expect(compareRoadmapIntakeSteps("run-created", "completed")).toBeLessThan(
      0,
    );
  });

  it("serializes concurrent writers without losing state", async () => {
    const journal = new RoadmapIntakeJournal(stateDirectory, {
      timeoutMs: 10_000,
    });
    const operations = Array.from({ length: 8 }, (_, index) => ({
      operationId: randomUUID(),
      itemId: `RM-${index}`,
      changeName: `item-${index}`,
      mode: "automatic" as const,
      step: "intent-recorded" as const,
    }));
    await Promise.all(
      operations.map((operation) =>
        journal.withLock(() => journal.record(operation)),
      ),
    );
    const stored = await journal.read();
    expect(stored.records).toHaveLength(operations.length);
    expect(new Set(stored.records.map((record) => record.itemId)).size).toBe(8);
  });

  it("finds records by item and change and lists incomplete work", async () => {
    const journal = new RoadmapIntakeJournal(stateDirectory);
    await journal.record({
      operationId: randomUUID(),
      itemId: "RM-004",
      changeName: "start-roadmap-work-through-swf",
      mode: "planning-only",
      step: "roadmap-linked",
    });
    await journal.record({
      operationId: randomUUID(),
      itemId: "RM-005",
      changeName: "done-work",
      mode: "planning-only",
      step: "completed",
    });
    expect((await journal.find("RM-004"))?.changeName).toBe(
      "start-roadmap-work-through-swf",
    );
    expect((await journal.findByChangeName("done-work"))?.itemId).toBe(
      "RM-005",
    );
    expect((await journal.incomplete()).map(({ itemId }) => itemId)).toEqual([
      "RM-004",
    ]);
  });
});

describe("roadmap intake state migration", () => {
  let stateDirectory: string;

  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "swf-migrate-"));
  });
  afterEach(async () => {
    await rm(stateDirectory, { recursive: true, force: true });
  });

  async function seedLegacyState(): Promise<string> {
    const store = new RunEventStore(stateDirectory);
    const run = await store.create({
      projectId: randomUUID(),
      changeName: "legacy-change",
      changeIdentity: "openspec/changes/legacy-change",
      workflowId: "default",
      description: "Legacy direct entry",
      phaseIds: ["planning"],
    });
    await writeFile(
      join(stateDirectory, "state-version.json"),
      `${JSON.stringify({ schemaVersion: 1, stateVersion: 1 }, null, 2)}\n`,
    );
    return run.runId;
  }

  function manager(): StateMigrationManager {
    return new StateMigrationManager(
      stateDirectory,
      roadmapIntakeMigrations,
      ROADMAP_INTAKE_STATE_VERSION,
    );
  }

  it("previews the migration without touching state", async () => {
    await seedLegacyState();
    const preview = await manager().migrate({ dryRun: true });
    expect(preview.applied).toBe(false);
    expect(preview.plan).toMatchObject({ from: 1, to: 2 });
    expect(
      await readFile(join(stateDirectory, "roadmap-intake.json"), "utf8").catch(
        () => undefined,
      ),
    ).toBeUndefined();
  });

  it("applies the migration and preserves existing run bindings", async () => {
    const runId = await seedLegacyState();
    const before = await readFile(
      join(stateDirectory, "run-bindings.json"),
      "utf8",
    );
    const result = await manager().migrate({ dryRun: false });
    expect(result.applied).toBe(true);
    expect(
      JSON.parse(
        await readFile(join(stateDirectory, "roadmap-intake.json"), "utf8"),
      ),
    ).toEqual({ schemaVersion: 1, records: [] });
    expect(
      await readFile(join(stateDirectory, "run-bindings.json"), "utf8"),
    ).toBe(before);
    expect(
      (await new RunEventStore(stateDirectory).load(runId)).run.changeName,
    ).toBe("legacy-change");
    expect(
      await new RunEventStore(stateDirectory).findRunByChangeIdentity(
        "openspec/changes/legacy-change",
      ),
    ).toBe(runId);
  });

  it("rolls back to the pre-migration state", async () => {
    const runId = await seedLegacyState();
    const result = await manager().migrate({ dryRun: false });
    await manager().rollback(result.backupId!);
    expect(
      await readFile(join(stateDirectory, "roadmap-intake.json"), "utf8").catch(
        () => undefined,
      ),
    ).toBeUndefined();
    expect(
      await new RunEventStore(stateDirectory).findRunByChangeIdentity(
        "openspec/changes/legacy-change",
      ),
    ).toBe(runId);
  });

  it("is idempotent when the journal already exists", async () => {
    await seedLegacyState();
    await new RoadmapIntakeJournal(stateDirectory).record({
      operationId: randomUUID(),
      itemId: "RM-004",
      changeName: "start-roadmap-work-through-swf",
      mode: "planning-only",
      step: "completed",
    });
    await manager().migrate({ dryRun: false });
    expect(
      (await new RoadmapIntakeJournal(stateDirectory).read()).records,
    ).toHaveLength(1);
  });
});

describe("selectChangeName", () => {
  it("takes the preferred name when nothing owns it", () => {
    expect(selectChangeName(item, () => undefined)).toEqual({
      kind: "selected",
      changeName: "start-roadmap-work-through-swf",
      reusedExisting: false,
    });
  });

  it("reuses a name this same item already owns", () => {
    expect(
      selectChangeName(item, (name) =>
        name === "start-roadmap-work-through-swf" ? "RM-004" : undefined,
      ),
    ).toEqual({
      kind: "selected",
      changeName: "start-roadmap-work-through-swf",
      reusedExisting: true,
    });
  });

  it("falls back to the roadmap-id-qualified name when another item owns it", () => {
    const selection = selectChangeName(
      { id: "RM-2", title: "Add auth" },
      (name) => (name === "add-auth" ? "RM-1" : undefined),
    );
    expect(selection).toEqual({
      kind: "selected",
      changeName: "add-auth-rm-2",
      reusedExisting: false,
    });
  });

  it("reports exhaustion rather than inventing a name", () => {
    const selection = selectChangeName(item, () => "RM-999");
    expect(selection.kind).toBe("exhausted");
    expect(
      selection.kind === "exhausted" && selection.candidates.length,
    ).toBeGreaterThan(1);
  });
});

describe("OpenRoad start identity verification", () => {
  function startResponse(overrides: Record<string, unknown>): ProcessResult {
    return processResult(0, {
      schemaVersion: 1,
      root: "/repo",
      item: { ...item, status: "active", change: "start-roadmap-work" },
      change: { name: "start-roadmap-work", path: "/repo/c" },
      changed: true,
      status: [],
      ...overrides,
    });
  }

  const linkStart = (response: ProcessResult) =>
    new ProcessOpenRoadAdapter(new ScriptedRunner([response])).start(
      "/repo",
      "RM-004",
      "start-roadmap-work",
    );

  it("links when every identity matches the request", async () => {
    expect((await linkStart(startResponse({}))).kind).toBe("linked");
  });

  it("treats a different item ID as a conflict", async () => {
    const outcome = await linkStart(
      startResponse({
        item: {
          ...item,
          id: "RM-009",
          status: "active",
          change: "start-roadmap-work",
        },
      }),
    );
    expect(outcome.kind).toBe("conflict");
    expect(
      outcome.kind !== "linked" && outcome.diagnostics[0]?.message,
    ).toContain("item RM-009 instead of RM-004");
  });

  it("treats a different change name as a conflict", async () => {
    const outcome = await linkStart(
      startResponse({ change: { name: "other-change", path: "/repo/c" } }),
    );
    expect(outcome.kind).toBe("conflict");
    expect(
      outcome.kind !== "linked" && outcome.diagnostics[0]?.message,
    ).toContain("change other-change instead of start-roadmap-work");
  });

  it("treats a different project root as a conflict", async () => {
    const outcome = await linkStart(startResponse({ root: "/elsewhere" }));
    expect(outcome.kind).toBe("conflict");
    expect(outcome.kind !== "linked" && outcome.diagnostics[0]?.code).toBe(
      "identity_mismatch",
    );
  });

  it("accepts an equivalent root spelling", async () => {
    expect((await linkStart(startResponse({ root: "/repo/./" }))).kind).toBe(
      "linked",
    );
  });

  it("reports every drifted identity in one diagnostic", async () => {
    const outcome = await linkStart(
      startResponse({
        item: { ...item, id: "RM-009", status: "active", change: "x" },
        change: { name: "other-change", path: "/repo/c" },
        root: "/elsewhere",
      }),
    );
    const message =
      outcome.kind !== "linked" ? (outcome.diagnostics[0]?.message ?? "") : "";
    expect(message).toContain("item RM-009");
    expect(message).toContain("change other-change");
    expect(message).toContain("root /elsewhere");
  });
});
