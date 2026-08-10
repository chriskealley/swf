import { createHash, randomUUID } from "node:crypto";
import type { ArtifactStore } from "./artifacts.js";
import type { Artifact, Delivery, RunStatus } from "./domain.js";
import { DeliverySchema } from "./schemas.js";
import type { ReleasePreflight } from "./release.js";

export type DeliveryMode = "pull-request" | "local-branch" | "direct-merge";
export type MergeMethod = "merge" | "squash" | "rebase" | "repository-default";
export type DeliveryFailureAction = "remediate" | "escalate" | "fail";

export interface HostingPreflightInput {
  cwd: string;
  mode: DeliveryMode;
  remote: string;
  targetBranch: string;
  sourceBranch: string;
  requireMergePermission: boolean;
  requireAutoMerge: boolean;
}

export interface HostingPreflightCheck {
  id:
    | "remote"
    | "repository"
    | "network"
    | "target-branch"
    | "authentication"
    | "push"
    | "pull-request"
    | "merge"
    | "auto-merge";
  status: "passed" | "failed" | "skipped";
  detail: string;
  remediation?: string;
}

export interface HostingPreflightResult {
  valid: boolean;
  skipped: boolean;
  repository?: string;
  checks: HostingPreflightCheck[];
}

export interface PullRequestRequest {
  cwd: string;
  repository: string;
  remote: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string;
}

export interface PullRequestReference {
  number: number;
  url: string;
  sourceBranch: string;
  targetBranch: string;
  created: boolean;
}

export interface HostedCheck {
  name: string;
  status: string;
  conclusion?: string;
  url?: string;
}

export interface HostedReview {
  actor: string;
  state: string;
  submittedAt?: string;
}

export interface PullRequestObservation extends PullRequestReference {
  state: "open" | "closed" | "merged";
  mergeState: string;
  reviewDecision?: string;
  checks: HostedCheck[];
  reviews: HostedReview[];
  autoMergeEnabled: boolean;
}

export interface HostingAdapter {
  readonly id: string;
  preflight(input: HostingPreflightInput): Promise<HostingPreflightResult>;
  createOrUpdatePullRequest(
    input: PullRequestRequest,
  ): Promise<PullRequestReference>;
  observePullRequest(input: {
    cwd: string;
    repository: string;
    number: number;
  }): Promise<PullRequestObservation>;
  requestAutoMerge(input: {
    cwd: string;
    repository: string;
    number: number;
    method: MergeMethod;
  }): Promise<void>;
  mergePullRequest(input: {
    cwd: string;
    repository: string;
    number: number;
    method: MergeMethod;
  }): Promise<void>;
  directMerge(input: {
    cwd: string;
    repository: string;
    sourceBranch: string;
    targetBranch: string;
    method: MergeMethod;
  }): Promise<void>;
  cleanupBranch(input: {
    cwd: string;
    remote: string;
    branch: string;
  }): Promise<void>;
}

export interface DeliveryAuthorization {
  approvalMode: "manual" | "automatic";
  delegatedAuthorization: boolean;
  directMergeAuthorized: boolean;
}

export interface DeliveryPlan {
  mode: DeliveryMode;
  mergeMethod: MergeMethod;
  action:
    | "record-local-branch"
    | "open-pull-request"
    | "open-pull-request-and-auto-merge"
    | "direct-merge";
  requiresHostingPreflight: boolean;
}

export function resolveDeliveryPlan(input: {
  configuredMode: DeliveryMode;
  mergeMethod?: MergeMethod;
  explicitlyConfigured: boolean;
  authorization: DeliveryAuthorization;
}): DeliveryPlan {
  const mergeMethod = input.mergeMethod ?? "merge";
  if (input.configuredMode === "local-branch") {
    if (!input.explicitlyConfigured)
      throw new Error(
        "Local-branch delivery requires explicit workflow configuration",
      );
    return {
      mode: "local-branch",
      mergeMethod,
      action: "record-local-branch",
      requiresHostingPreflight: false,
    };
  }
  if (input.configuredMode === "direct-merge") {
    if (!input.explicitlyConfigured)
      throw new Error("Direct merge requires explicit workflow configuration");
    if (!input.authorization.directMergeAuthorized)
      throw new Error("Direct merge is not authorized by resolved policy");
    return {
      mode: "direct-merge",
      mergeMethod,
      action: "direct-merge",
      requiresHostingPreflight: true,
    };
  }
  const automatic = input.authorization.approvalMode === "automatic";
  if (automatic && !input.authorization.delegatedAuthorization)
    throw new Error(
      "Automatic delivery requires recorded delegated authorization",
    );
  return {
    mode: "pull-request",
    mergeMethod,
    action: automatic
      ? "open-pull-request-and-auto-merge"
      : "open-pull-request",
    requiresHostingPreflight: true,
  };
}

export class DeliveryPreflightError extends Error {
  constructor(readonly result: HostingPreflightResult) {
    super(
      result.checks
        .filter(({ status }) => status === "failed")
        .map(({ detail }) => detail)
        .join("; ") || "Delivery preflight failed",
    );
    this.name = "DeliveryPreflightError";
  }
}

export interface DeliveryRequest {
  cwd: string;
  remote: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string;
  runId: string;
  deliveryId?: string;
  executionStatus: RunStatus;
  sourceCommit: string;
  phaseId?: string;
  plan: DeliveryPlan;
  failureAction: DeliveryFailureAction;
  preflight?: ReleasePreflight;
  authorizationId?: string;
  dossierRef?: string;
  resultingCommit?: string;
}

export interface DeliveryUpdate {
  delivery: Delivery;
  kind:
    | "pull-request"
    | "checks"
    | "reviews"
    | "merge"
    | "cleanup"
    | "local-branch"
    | "failure";
  action?: DeliveryFailureAction;
}

function deliveryFrom(
  input: DeliveryRequest,
  values: Partial<Delivery>,
): Delivery {
  return DeliverySchema.parse({
    schemaVersion: 1,
    deliveryId: input.deliveryId ?? randomUUID(),
    runId: input.runId,
    provider: input.plan.mode === "local-branch" ? "local" : "github",
    mode: input.plan.mode,
    executionStatus: input.executionStatus,
    status: "pending",
    remote: input.remote,
    branch: input.sourceBranch,
    targetBranch: input.targetBranch,
    mergeMethod: input.plan.mergeMethod,
    hostedChecks: [],
    reviews: [],
    autoMergeRequested: false,
    preflight: input.preflight,
    authorizationId: input.authorizationId,
    dossierRef: input.dossierRef,
    resultingCommit: input.resultingCommit,
    updatedAt: new Date().toISOString(),
    ...values,
  });
}

function hasFailedChecks(observation: PullRequestObservation): boolean {
  return observation.checks.some(({ conclusion, status }) =>
    [conclusion, status].some(
      (value) =>
        value &&
        [
          "failure",
          "failed",
          "cancelled",
          "timed_out",
          "action_required",
        ].includes(value.toLowerCase()),
    ),
  );
}

function reviewRejected(observation: PullRequestObservation): boolean {
  return (
    observation.reviewDecision === "CHANGES_REQUESTED" ||
    observation.reviews.some(
      ({ state }) => state.toUpperCase() === "CHANGES_REQUESTED",
    )
  );
}

export class DeliveryOrchestrator {
  constructor(
    readonly adapter: HostingAdapter,
    private readonly record: (
      update: DeliveryUpdate,
    ) => Promise<void> = async () => undefined,
    private readonly wait: (
      milliseconds: number,
      signal?: AbortSignal,
    ) => Promise<void> = (milliseconds, signal) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }),
  ) {}

  async start(input: DeliveryRequest): Promise<Delivery> {
    if (input.plan.action === "record-local-branch") {
      const delivery = deliveryFrom(input, { status: "local-branch" });
      await this.record({ delivery, kind: "local-branch" });
      return delivery;
    }
    const preflight = await this.adapter.preflight({
      cwd: input.cwd,
      mode: input.plan.mode,
      remote: input.remote,
      targetBranch: input.targetBranch,
      sourceBranch: input.sourceBranch,
      requireMergePermission: input.plan.action !== "open-pull-request",
      requireAutoMerge:
        input.plan.action === "open-pull-request-and-auto-merge",
    });
    if (!preflight.valid || !preflight.repository)
      throw new DeliveryPreflightError(preflight);
    if (input.plan.action === "direct-merge") {
      await this.adapter.directMerge({
        cwd: input.cwd,
        repository: preflight.repository,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        method: input.plan.mergeMethod,
      });
      const delivery = deliveryFrom(input, {
        status: "merged",
        mergeState: "direct-merged",
      });
      await this.record({ delivery, kind: "merge" });
      return delivery;
    }
    const pullRequest = await this.adapter.createOrUpdatePullRequest({
      ...input,
      repository: preflight.repository,
    });
    let delivery = deliveryFrom(input, {
      status: "awaiting-merge",
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.url,
    });
    await this.record({ delivery, kind: "pull-request" });
    if (input.plan.action === "open-pull-request-and-auto-merge") {
      await this.adapter.requestAutoMerge({
        cwd: input.cwd,
        repository: preflight.repository,
        number: pullRequest.number,
        method: input.plan.mergeMethod,
      });
      delivery = DeliverySchema.parse({
        ...delivery,
        status: "auto-merge-requested",
        autoMergeRequested: true,
        updatedAt: new Date().toISOString(),
      });
      await this.record({ delivery, kind: "merge" });
    }
    return delivery;
  }

  async monitor(
    input: DeliveryRequest & {
      delivery: Delivery;
      pollIntervalMs?: number;
      signal?: AbortSignal;
      maxPolls?: number;
    },
  ): Promise<Delivery> {
    if (
      !input.delivery.pullRequestNumber ||
      input.delivery.provider !== "github"
    )
      return input.delivery;
    const pullRequestNumber = input.delivery.pullRequestNumber;
    const preflight = await this.adapter.preflight({
      cwd: input.cwd,
      mode: "pull-request",
      remote: input.remote,
      targetBranch: input.targetBranch,
      sourceBranch: input.sourceBranch,
      requireMergePermission: input.delivery.autoMergeRequested,
      requireAutoMerge: input.delivery.autoMergeRequested,
    });
    if (!preflight.valid || !preflight.repository)
      throw new DeliveryPreflightError(preflight);
    let polls = 0;
    while (
      !input.signal?.aborted &&
      polls < (input.maxPolls ?? Number.POSITIVE_INFINITY)
    ) {
      polls += 1;
      const observation = await this.adapter.observePullRequest({
        cwd: input.cwd,
        repository: preflight.repository,
        number: pullRequestNumber,
      });
      if (input.signal?.aborted) return input.delivery;
      const base = {
        ...input.delivery,
        pullRequestUrl: observation.url,
        mergeState: observation.mergeState,
        hostedChecks: observation.checks,
        reviews: observation.reviews,
        updatedAt: new Date().toISOString(),
      };
      if (observation.state === "merged") {
        let delivery = DeliverySchema.parse({ ...base, status: "merged" });
        await this.record({ delivery, kind: "merge" });
        await this.adapter.cleanupBranch({
          cwd: input.cwd,
          remote: input.remote,
          branch: input.sourceBranch,
        });
        delivery = DeliverySchema.parse({
          ...delivery,
          cleanup: {
            branchDeleted: true,
            recordedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
        });
        await this.record({ delivery, kind: "cleanup" });
        return delivery;
      }
      if (hasFailedChecks(observation)) {
        const delivery = DeliverySchema.parse({
          ...base,
          status: "checks-failed",
          failureReason: "Hosted checks failed",
          failureAction: input.failureAction,
        });
        await this.record({
          delivery,
          kind: "checks",
          action: input.failureAction,
        });
        return delivery;
      }
      if (reviewRejected(observation)) {
        const delivery = DeliverySchema.parse({
          ...base,
          status: "rejected",
          failureReason: "Pull request changes were requested",
          failureAction: input.failureAction,
        });
        await this.record({
          delivery,
          kind: "reviews",
          action: input.failureAction,
        });
        return delivery;
      }
      if (observation.state === "closed") {
        const delivery = DeliverySchema.parse({
          ...base,
          status: "closed",
          failureReason: "Pull request was closed without merge",
          failureAction: input.failureAction,
        });
        await this.record({
          delivery,
          kind: "failure",
          action: input.failureAction,
        });
        return delivery;
      }
      const delivery = DeliverySchema.parse({
        ...base,
        status: input.delivery.autoMergeRequested
          ? "auto-merge-requested"
          : "awaiting-merge",
      });
      await this.record({
        delivery,
        kind: observation.reviews.length ? "reviews" : "checks",
      });
      input.delivery = delivery;
      await this.wait(input.pollIntervalMs ?? 30_000, input.signal);
    }
    return input.delivery;
  }
}

export async function retainDeliveryUpdate(input: {
  artifacts: ArtifactStore;
  update: DeliveryUpdate;
  sourceCommit: string;
  phaseId?: string;
}): Promise<Artifact> {
  const artifactId = randomUUID();
  const serialized = `${JSON.stringify(input.update, null, 2)}\n`;
  const outputRef = await input.artifacts.retainRaw(
    `delivery/${artifactId}.json`,
    serialized,
  );
  const artifact: Artifact = {
    schemaVersion: 1,
    artifactId,
    runId: input.update.delivery.runId,
    type: `delivery-${input.update.kind}`,
    phaseId: input.phaseId ?? "releasing",
    sourceCommit: input.sourceCommit,
    inputFingerprint: createHash("sha256").update(serialized).digest("hex"),
    status: ["failed", "closed", "checks-failed", "rejected"].includes(
      input.update.delivery.status,
    )
      ? "invalid"
      : "valid",
    createdAt: new Date().toISOString(),
    outputRef,
    rawOutputRef: outputRef,
    summary: `${input.update.delivery.status}: ${input.update.delivery.pullRequestUrl ?? input.update.delivery.branch}`,
    consumers: [],
    invalidReason: input.update.delivery.failureReason,
  };
  await input.artifacts.record(artifact);
  return artifact;
}
