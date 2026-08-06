import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GitClient, type RunWorktree } from "./git.js";
import {
  HerdrClient,
  type HerdrIdentifiers,
  type HerdrLaunch,
} from "./herdr.js";

export type OwnedResourceKind =
  "workspace" | "worktree" | "tab" | "pane" | "terminal" | "process";

export interface OwnedResource {
  resourceId: string;
  kind: OwnedResourceKind;
  createdAt: string;
  parentId?: string;
  metadata?: Record<string, string>;
}

export interface RunRuntimeOwnership {
  schemaVersion: 1;
  runId: string;
  projectRoot: string;
  branch: string;
  worktreePath: string;
  resources: OwnedResource[];
  createdAt: string;
  updatedAt: string;
}

async function writeAtomically(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export class RuntimeOwnershipStore {
  constructor(readonly stateDirectory: string) {}

  private path(runId: string): string {
    return join(this.stateDirectory, "runs", runId, "runtime.json");
  }

  async load(runId: string): Promise<RunRuntimeOwnership | undefined> {
    try {
      return JSON.parse(
        await readFile(this.path(runId), "utf8"),
      ) as RunRuntimeOwnership;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(ownership: RunRuntimeOwnership): Promise<RunRuntimeOwnership> {
    const next = { ...ownership, updatedAt: new Date().toISOString() };
    await writeAtomically(
      this.path(ownership.runId),
      `${JSON.stringify(next, null, 2)}\n`,
    );
    return next;
  }

  async addResources(
    runId: string,
    identifiers: HerdrIdentifiers,
    parentId?: string,
  ): Promise<RunRuntimeOwnership> {
    const ownership = await this.load(runId);
    if (!ownership)
      throw new Error(`No runtime ownership exists for run ${runId}`);
    const resources: Array<[OwnedResourceKind, string | undefined]> = [
      ["workspace", identifiers.workspaceId],
      ["worktree", identifiers.worktreeId],
      ["tab", identifiers.tabId],
      ["pane", identifiers.paneId],
      ["terminal", identifiers.terminalId],
      ["process", identifiers.processId],
    ];
    const next = {
      ...ownership,
      resources: [...ownership.resources],
    };
    for (const [kind, resourceId] of resources) {
      if (
        resourceId &&
        !next.resources.some(
          (resource) =>
            resource.kind === kind && resource.resourceId === resourceId,
        )
      ) {
        next.resources.push({
          resourceId,
          kind,
          parentId,
          createdAt: new Date().toISOString(),
        });
      }
    }
    return this.save(next);
  }
}

export interface PreparedRunRuntime {
  ownership: RunRuntimeOwnership;
  worktree: RunWorktree;
  workspaceId: string;
}

export class RunRuntime {
  constructor(
    readonly git: GitClient,
    readonly herdr: HerdrClient,
    readonly ownership: RuntimeOwnershipStore,
  ) {}

  async prepare(input: {
    runId: string;
    stateDirectory: string;
    base?: string;
  }): Promise<PreparedRunRuntime> {
    const existing = await this.ownership.load(input.runId);
    if (existing) {
      const workspace = existing.resources.find(
        (resource) => resource.kind === "workspace",
      );
      if (!workspace)
        throw new Error(`Run ${input.runId} has no owned Herdr workspace`);
      return {
        ownership: existing,
        worktree: {
          branch: existing.branch,
          path: existing.worktreePath,
          base: input.base ?? "HEAD",
        },
        workspaceId: workspace.resourceId,
      };
    }

    const projectRoot = await this.git.repositoryRoot();
    const branch = `swf/${input.runId}`;
    const worktreePath = join(input.stateDirectory, "worktrees", input.runId);
    const worktree = await this.git.createWorktree({
      path: worktreePath,
      branch,
      base: input.base,
    });
    const workspace = await this.herdr.createWorkspace({
      cwd: projectRoot,
      label: `swf-${input.runId}`,
    });
    const opened = await this.herdr.openWorktree({
      workspaceId: workspace.workspaceId!,
      path: worktreePath,
      label: `swf-${input.runId}`,
    });
    const now = new Date().toISOString();
    const created: RunRuntimeOwnership = {
      schemaVersion: 1,
      runId: input.runId,
      projectRoot,
      branch,
      worktreePath,
      resources: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.ownership.save(created);
    await this.ownership.addResources(input.runId, workspace);
    const ownership = await this.ownership.addResources(
      input.runId,
      opened,
      workspace.workspaceId,
    );
    return {
      ownership,
      worktree,
      workspaceId: workspace.workspaceId!,
    };
  }

  async launch(
    runId: string,
    input: Omit<HerdrLaunch, "workspaceId">,
  ): Promise<HerdrIdentifiers> {
    const runtime = await this.ownership.load(runId);
    if (!runtime)
      throw new Error(`No runtime ownership exists for run ${runId}`);
    const workspace = runtime.resources.find(
      (resource) => resource.kind === "workspace",
    );
    if (!workspace)
      throw new Error(`Run ${runId} has no owned Herdr workspace`);
    const observation = await this.herdr.launch({
      ...input,
      workspaceId: workspace.resourceId,
    });
    await this.ownership.addResources(runId, observation, workspace.resourceId);
    return observation;
  }

  async reconcile(runId: string): Promise<{
    status: "active" | "completed" | "blocked" | "unknown" | "missing";
    paneId?: string;
  }> {
    const runtime = await this.ownership.load(runId);
    if (!runtime) return { status: "missing" };
    const pane = runtime.resources.find((resource) => resource.kind === "pane");
    if (!pane) return { status: "unknown" };
    const status = await this.herdr.reconcilePane(pane.resourceId);
    if (status === "missing") return { status, paneId: pane.resourceId };
    if (status === "blocked")
      return { status: "blocked", paneId: pane.resourceId };
    if (status === "working")
      return { status: "active", paneId: pane.resourceId };
    if (status === "idle" || status === "done")
      return { status: "completed", paneId: pane.resourceId };
    return { status: "unknown", paneId: pane.resourceId };
  }

  async cleanup(runId: string): Promise<string[]> {
    const runtime = await this.ownership.load(runId);
    if (!runtime) return [];
    const cleaned: string[] = [];
    for (const resource of [...runtime.resources].reverse()) {
      if (resource.kind === "pane") {
        await this.herdr.closePane(resource.resourceId);
        cleaned.push(resource.resourceId);
      } else if (resource.kind === "tab") {
        await this.herdr.closeTab(resource.resourceId);
        cleaned.push(resource.resourceId);
      } else if (resource.kind === "worktree") {
        const workspace = runtime.resources.find(
          (candidate) => candidate.kind === "workspace",
        );
        if (workspace) {
          await this.herdr.removeWorktree(workspace.resourceId);
          cleaned.push(resource.resourceId);
        }
      } else if (resource.kind === "workspace") {
        await this.herdr.closeWorkspace(resource.resourceId);
        cleaned.push(resource.resourceId);
      }
    }
    await this.git.removeWorktree(runtime.worktreePath);
    await rm(
      join(this.ownership.stateDirectory, "runs", runId, "runtime.json"),
      { force: true },
    );
    return cleaned;
  }
}
