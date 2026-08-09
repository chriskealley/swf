import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  DeliveryOrchestrator,
  resolveDeliveryPlan,
  retainDeliveryUpdate,
  type DeliveryRequest,
  type DeliveryUpdate,
  type HostingAdapter,
  type PullRequestObservation,
} from "../src/index.js";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  ),
);

function observation(
  values: Partial<PullRequestObservation> = {},
): PullRequestObservation {
  return {
    number: 7,
    url: "https://github.com/acme/repo/pull/7",
    sourceBranch: "swf/run",
    targetBranch: "main",
    created: false,
    state: "open",
    mergeState: "CLEAN",
    checks: [],
    reviews: [],
    autoMergeEnabled: false,
    ...values,
  };
}

class FakeHosting implements HostingAdapter {
  readonly id = "fake";
  calls: string[] = [];
  observations: PullRequestObservation[] = [observation()];
  preflightResult = {
    valid: true,
    skipped: false,
    repository: "acme/repo",
    checks: [],
  };
  async preflight() {
    this.calls.push("preflight");
    return this.preflightResult;
  }
  async createOrUpdatePullRequest() {
    this.calls.push("upsert");
    return observation({ created: true });
  }
  async observePullRequest() {
    this.calls.push("observe");
    return this.observations.shift() ?? observation();
  }
  async requestAutoMerge() {
    this.calls.push("auto-merge");
  }
  async mergePullRequest() {
    this.calls.push("merge");
  }
  async directMerge() {
    this.calls.push("direct-merge");
  }
  async cleanupBranch() {
    this.calls.push("cleanup");
  }
}

function request(
  plan = resolveDeliveryPlan({
    configuredMode: "pull-request",
    explicitlyConfigured: true,
    authorization: {
      approvalMode: "manual",
      delegatedAuthorization: false,
      directMergeAuthorized: false,
    },
  }),
): DeliveryRequest {
  return {
    cwd: "/repo",
    remote: "origin",
    sourceBranch: "swf/run",
    targetBranch: "main",
    title: "Change",
    body: "Body",
    runId: "8c86919c-3569-4e97-9f09-1bba7b49ed3d",
    executionStatus: "completed",
    sourceCommit: "abc",
    phaseId: "releasing",
    plan,
    failureAction: "escalate",
  };
}

describe("pull-request delivery policy", () => {
  it("requires explicit and authorized alternative delivery modes", () => {
    expect(() =>
      resolveDeliveryPlan({
        configuredMode: "local-branch",
        explicitlyConfigured: false,
        authorization: {
          approvalMode: "manual",
          delegatedAuthorization: false,
          directMergeAuthorized: false,
        },
      }),
    ).toThrow("explicit workflow");
    expect(() =>
      resolveDeliveryPlan({
        configuredMode: "direct-merge",
        explicitlyConfigured: true,
        authorization: {
          approvalMode: "automatic",
          delegatedAuthorization: true,
          directMergeAuthorized: false,
        },
      }),
    ).toThrow("not authorized");
    expect(
      resolveDeliveryPlan({
        configuredMode: "local-branch",
        explicitlyConfigured: true,
        authorization: {
          approvalMode: "manual",
          delegatedAuthorization: false,
          directMergeAuthorized: false,
        },
      }),
    ).toMatchObject({
      action: "record-local-branch",
      requiresHostingPreflight: false,
    });
  });

  it("requires recorded delegation before automatic merge", () => {
    expect(() =>
      resolveDeliveryPlan({
        configuredMode: "pull-request",
        explicitlyConfigured: true,
        authorization: {
          approvalMode: "automatic",
          delegatedAuthorization: false,
          directMergeAuthorized: false,
        },
      }),
    ).toThrow("recorded delegated authorization");
    expect(
      resolveDeliveryPlan({
        configuredMode: "pull-request",
        mergeMethod: "squash",
        explicitlyConfigured: true,
        authorization: {
          approvalMode: "automatic",
          delegatedAuthorization: true,
          directMergeAuthorized: false,
        },
      }),
    ).toMatchObject({
      action: "open-pull-request-and-auto-merge",
      mergeMethod: "squash",
    });
  });

  it("executes explicitly authorized local and direct alternatives", async () => {
    const localAdapter = new FakeHosting();
    const localPlan = resolveDeliveryPlan({
      configuredMode: "local-branch",
      explicitlyConfigured: true,
      authorization: {
        approvalMode: "manual",
        delegatedAuthorization: false,
        directMergeAuthorized: false,
      },
    });
    await expect(
      new DeliveryOrchestrator(localAdapter).start(request(localPlan)),
    ).resolves.toMatchObject({ status: "local-branch", provider: "local" });
    expect(localAdapter.calls).toEqual([]);

    const directAdapter = new FakeHosting();
    const directPlan = resolveDeliveryPlan({
      configuredMode: "direct-merge",
      mergeMethod: "merge",
      explicitlyConfigured: true,
      authorization: {
        approvalMode: "automatic",
        delegatedAuthorization: true,
        directMergeAuthorized: true,
      },
    });
    await expect(
      new DeliveryOrchestrator(directAdapter).start(request(directPlan)),
    ).resolves.toMatchObject({ status: "merged", mode: "direct-merge" });
    expect(directAdapter.calls).toEqual(["preflight", "direct-merge"]);
  });

  it("opens a manual pull request without merging and requests autonomous auto-merge", async () => {
    const manualAdapter = new FakeHosting();
    const manual = await new DeliveryOrchestrator(manualAdapter).start(
      request(),
    );
    expect(manual).toMatchObject({
      executionStatus: "completed",
      status: "awaiting-merge",
    });
    expect(manualAdapter.calls).toEqual(["preflight", "upsert"]);

    const automaticAdapter = new FakeHosting();
    const plan = resolveDeliveryPlan({
      configuredMode: "pull-request",
      mergeMethod: "rebase",
      explicitlyConfigured: true,
      authorization: {
        approvalMode: "automatic",
        delegatedAuthorization: true,
        directMergeAuthorized: false,
      },
    });
    const automatic = await new DeliveryOrchestrator(automaticAdapter).start(
      request(plan),
    );
    expect(automatic).toMatchObject({
      status: "auto-merge-requested",
      autoMergeRequested: true,
      mergeMethod: "rebase",
    });
    expect(automaticAdapter.calls).toEqual([
      "preflight",
      "upsert",
      "auto-merge",
    ]);
  });

  it("monitors after execution, records hosted state, and cleans up only after merge", async () => {
    const adapter = new FakeHosting();
    adapter.observations = [
      observation({
        state: "merged",
        mergeState: "MERGED",
        checks: [{ name: "test", status: "completed", conclusion: "success" }],
        reviews: [{ actor: "reviewer", state: "APPROVED" }],
      }),
    ];
    const updates: DeliveryUpdate[] = [];
    const orchestrator = new DeliveryOrchestrator(
      adapter,
      async (update) => {
        updates.push(update);
      },
      async () => undefined,
    );
    const started = await orchestrator.start(request());
    const final = await orchestrator.monitor({
      ...request(),
      delivery: started,
      maxPolls: 1,
      pollIntervalMs: 0,
    });
    expect(final).toMatchObject({
      executionStatus: "completed",
      status: "merged",
      cleanup: { branchDeleted: true },
      hostedChecks: [{ name: "test" }],
      reviews: [{ actor: "reviewer" }],
    });
    expect(adapter.calls).toContain("cleanup");
    expect(updates.map(({ kind }) => kind)).toEqual([
      "pull-request",
      "merge",
      "cleanup",
    ]);
  });

  it("applies configured escalation when hosted checks fail or review rejects", async () => {
    const adapter = new FakeHosting();
    adapter.observations = [
      observation({
        checks: [{ name: "ci", status: "completed", conclusion: "failure" }],
      }),
    ];
    const updates: DeliveryUpdate[] = [];
    const orchestrator = new DeliveryOrchestrator(adapter, async (update) => {
      updates.push(update);
    });
    const started = await orchestrator.start(request());
    const failed = await orchestrator.monitor({
      ...request(),
      delivery: started,
      maxPolls: 1,
    });
    expect(failed.status).toBe("checks-failed");
    expect(updates.at(-1)).toMatchObject({
      kind: "checks",
      action: "escalate",
    });
  });

  it("escalates rejected and closed pull requests without reporting a merge", async () => {
    const rejectedAdapter = new FakeHosting();
    rejectedAdapter.observations = [
      observation({
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [{ actor: "reviewer", state: "CHANGES_REQUESTED" }],
      }),
    ];
    const rejectedStart = await new DeliveryOrchestrator(rejectedAdapter).start(
      request(),
    );
    await expect(
      new DeliveryOrchestrator(rejectedAdapter).monitor({
        ...request(),
        delivery: rejectedStart,
        maxPolls: 1,
      }),
    ).resolves.toMatchObject({ status: "rejected" });

    const closedAdapter = new FakeHosting();
    closedAdapter.observations = [observation({ state: "closed" })];
    const closedStart = await new DeliveryOrchestrator(closedAdapter).start(
      request(),
    );
    await expect(
      new DeliveryOrchestrator(closedAdapter).monitor({
        ...request(),
        delivery: closedStart,
        maxPolls: 1,
      }),
    ).resolves.toMatchObject({ status: "closed" });
    expect(closedAdapter.calls).not.toContain("cleanup");
  });

  it("retains typed delivery artifacts separately from execution status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "swf-delivery-"));
    directories.push(directory);
    const adapter = new FakeHosting();
    const delivery = await new DeliveryOrchestrator(adapter).start(request());
    const artifacts = new ArtifactStore(directory, delivery.runId);
    const artifact = await retainDeliveryUpdate({
      artifacts,
      update: { delivery, kind: "pull-request" },
      sourceCommit: "abc",
    });
    expect(artifact).toMatchObject({
      type: "delivery-pull-request",
      status: "valid",
      sourceCommit: "abc",
    });
    await expect(artifacts.load()).resolves.toMatchObject({
      artifacts: [{ artifactId: artifact.artifactId }],
    });
  });
});
