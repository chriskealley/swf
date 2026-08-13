export type CostQuality = "exact" | "estimated" | "unknown";

export interface CostSummary {
  exactUsd: number;
  estimatedUsd: number;
  unknown: number;
}

export interface Invocation {
  schemaVersion: 1;
  invocationId: string;
  runId: string;
  phaseId: string;
  harness: string;
  modelTier?: string;
  model?: string;
  modelRoute?: Record<string, unknown>;
  contractFingerprint?: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  outputRef?: string;
  cost: { amountUsd?: number; quality: CostQuality };
}

export interface ProjectSummary {
  projectId: string;
  displayName: string;
  root: string;
  stateDirectory: string;
  lastSeenAt: string;
  availability: "available" | "unavailable" | "permission-denied";
  unavailableReason?: string;
  activeRuns: number;
  waitingGates: number;
  failures: number;
  recentInvocations: Invocation[];
  costs: CostSummary;
}

export interface BudgetDecision {
  scope: "invocation" | "phase" | "run" | "project" | "service";
  scopeId: string;
  status: "available" | "exhausted" | "indeterminate";
  allowed: boolean;
  reasons: string[];
  consumed: { costUsd: number; tokens: number };
  limits: { maxCostUsd?: number; maxTokens?: number; strictUnknown?: boolean };
}

export interface AdapterDiagnostic {
  id: string;
  available: boolean;
  errors: string[];
  capabilities: {
    structuredEvents: boolean;
    modelSelection: boolean;
    toolSelection: boolean;
    cancellation: boolean;
    blockedInput: boolean;
    resume: boolean;
    usage: boolean;
  };
}

export interface DashboardOverview {
  projects: ProjectSummary[];
  totals: CostSummary & {
    projects: number;
    activeRuns: number;
    waitingGates: number;
    failures: number;
  };
}

export interface Run {
  runId: string;
  projectId: string;
  changeName: string;
  changeIdentity?: string;
  workflowId: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunDetail {
  state: {
    run: Run;
    phases: Record<
      string,
      {
        id: string;
        status: string;
        attemptIds: string[];
        workUnits: Record<
          string,
          { id: string; status: string; outputRef?: string }
        >;
        checks: Record<string, { id: string; status: string; reason?: string }>;
        gate?: {
          id: string;
          status: string;
          reason?: string;
          decidedAt: string;
        };
      }
    >;
    attempts: Record<
      string,
      {
        attemptId: string;
        phaseId: string;
        number: number;
        kind: string;
        status: string;
        startedAt: string;
        endedAt?: string;
        reason?: string;
      }
    >;
    invocations: Record<string, Invocation>;
    artifacts: Record<
      string,
      {
        artifactId: string;
        type: string;
        phaseId: string;
        status: string;
        createdAt: string;
        outputRef: string;
        rawOutputRef?: string;
        summary?: string;
      }
    >;
    checkpoints: Record<string, unknown>;
    deliveries: Record<
      string,
      {
        deliveryId: string;
        executionStatus: string;
        status: string;
        mode: string;
        branch: string;
        targetBranch: string;
        pullRequestUrl?: string;
        mergeMethod: string;
        mergeState?: string;
        autoMergeRequested: boolean;
        hostedChecks: Array<{
          name: string;
          status: string;
          conclusion?: string;
          url?: string;
        }>;
        reviews: Array<{ actor: string; state: string }>;
        cleanup?: { branchDeleted: boolean; recordedAt: string };
        failureReason?: string;
        failureAction?: "remediate" | "escalate" | "fail";
        cleanupState?: {
          status: string;
          removedResources: string[];
          retainedResources: string[];
        };
        preflight?: {
          valid: boolean;
          sourceCommit: string;
          targetCommit: string;
          checks: Array<{ id: string; status: string; detail: string }>;
        };
      }
    >;
  };
  runtime?: { branch?: string; worktreePath?: string };
  costs: CostSummary;
}

export interface OutputResult {
  ref: string;
  available: boolean;
  content?: string;
  reason?: string;
  bytes?: number;
  returnedBytes?: number;
  truncated?: boolean;
  raw?: boolean;
}

export interface ServiceEvent {
  id: number;
  timestamp: string;
  type: string;
  projectId?: string;
  runId?: string;
  data: Record<string, unknown>;
}

export interface PruningPreview {
  schemaVersion: 1;
  confirmationId: string;
  criteria: { ageDays?: number; runId?: string; budgetBytes?: number };
  candidates: Array<{
    runId: string;
    ref: string;
    bytes: number;
    modifiedAt: string;
  }>;
  totalBytes: number;
  expiresAt: string;
}
import type { OperatorProjection } from "@swf/core";

export type { OperatorProjection };
