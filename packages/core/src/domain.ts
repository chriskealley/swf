import { z } from "zod";
import {
  ArtifactSchema,
  AttemptStatusSchema,
  CheckStatusSchema,
  CheckpointSchema,
  DeliverySchema,
  EventSchema,
  EventTypeSchema,
  GateStatusSchema,
  InvocationSchema,
  PhaseStatusSchema,
  RunSchema,
  RunStatusSchema,
  WorkUnitStatusSchema,
  type DocumentValue,
} from "./schemas.js";

export type RunStatus = z.infer<typeof RunStatusSchema>;
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;
export type WorkUnitStatus = z.infer<typeof WorkUnitStatusSchema>;
export type CheckResultStatus = z.infer<typeof CheckStatusSchema>;
export type GateStatus = z.infer<typeof GateStatusSchema>;
export type Run = DocumentValue<"run">;
export type Artifact = DocumentValue<"artifact">;
export type Invocation = DocumentValue<"invocation">;
export type Checkpoint = DocumentValue<"checkpoint">;
export type Delivery = DocumentValue<"delivery">;

export interface Phase {
  id: string;
  status: PhaseStatus;
  attemptIds: string[];
  workUnits: Record<string, WorkUnit>;
  checks: Record<string, Check>;
  gate?: Gate;
  updatedAt?: string;
}

export interface Attempt {
  attemptId: string;
  phaseId: string;
  number: number;
  kind: "initial" | "retry" | "rerun" | "remediation" | "reset" | "rollback";
  status: AttemptStatus;
  startedAt: string;
  endedAt?: string;
  reason?: string;
}

export interface WorkUnit {
  id: string;
  phaseId: string;
  status: WorkUnitStatus;
  updatedAt: string;
  attemptId?: string;
  outputRef?: string;
}

export interface Check {
  id: string;
  phaseId: string;
  status: CheckResultStatus;
  updatedAt: string;
  artifactId?: string;
  reason?: string;
}

export interface Gate {
  id: string;
  phaseId: string;
  status: GateStatus;
  decidedAt: string;
  reason?: string;
}

export interface RunState {
  run: Run;
  phases: Record<string, Phase>;
  attempts: Record<string, Attempt>;
  artifacts: Record<string, Artifact>;
  invocations: Record<string, Invocation>;
  checkpoints: Record<string, Checkpoint>;
  deliveries: Record<string, Delivery>;
  lastSequence: number;
}

const RunTransitionPayload = z
  .object({
    from: RunStatusSchema,
    to: RunStatusSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();
const PhaseTransitionPayload = z
  .object({
    phaseId: z.string().min(1),
    from: PhaseStatusSchema,
    to: PhaseStatusSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();
const AttemptStartedPayload = z
  .object({
    attemptId: z.string().uuid(),
    phaseId: z.string().min(1),
    number: z.number().int().positive(),
    kind: z.enum([
      "initial",
      "retry",
      "rerun",
      "remediation",
      "reset",
      "rollback",
    ]),
  })
  .strict();
const AttemptCompletedPayload = z
  .object({
    attemptId: z.string().uuid(),
    status: AttemptStatusSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();
const WorkUnitTransitionPayload = z
  .object({
    workUnitId: z.string().min(1),
    phaseId: z.string().min(1),
    from: WorkUnitStatusSchema.optional(),
    to: WorkUnitStatusSchema,
    attemptId: z.string().uuid().optional(),
    outputRef: z.string().min(1).optional(),
  })
  .strict();
const CheckRecordedPayload = z
  .object({
    checkId: z.string().min(1),
    phaseId: z.string().min(1),
    status: CheckStatusSchema,
    artifactId: z.string().uuid().optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();
const GateDecidedPayload = z
  .object({
    gateId: z.string().min(1),
    phaseId: z.string().min(1),
    status: GateStatusSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();
const ArtifactRecordedPayload = z.object({ artifact: ArtifactSchema }).strict();
const InvocationRecordedPayload = z
  .object({ invocation: InvocationSchema })
  .strict();
const CheckpointRecordedPayload = z
  .object({ checkpoint: CheckpointSchema })
  .strict();
const DeliveryRecordedPayload = z.object({ delivery: DeliverySchema }).strict();
const RetryPayload = z
  .object({
    phaseId: z.string().min(1),
    attemptId: z.string().uuid(),
    reason: z.string().min(1).optional(),
  })
  .strict();
const RollbackPayload = z
  .object({
    checkpointId: z.string().uuid(),
    phaseId: z.string().min(1),
    attemptId: z.string().uuid(),
    invalidatedPhaseIds: z.array(z.string().min(1)).default([]),
  })
  .strict();
const RunCreatedPayload = z
  .object({ changeIdentity: z.string().min(1) })
  .strict();

const eventPayloadSchemas = {
  "run.created": RunCreatedPayload,
  "run.transitioned": RunTransitionPayload,
  "phase.transitioned": PhaseTransitionPayload,
  "attempt.started": AttemptStartedPayload,
  "attempt.completed": AttemptCompletedPayload,
  "work-unit.transitioned": WorkUnitTransitionPayload,
  "check.recorded": CheckRecordedPayload,
  "gate.decided": GateDecidedPayload,
  "artifact.recorded": ArtifactRecordedPayload,
  "invocation.recorded": InvocationRecordedPayload,
  "checkpoint.recorded": CheckpointRecordedPayload,
  "delivery.recorded": DeliveryRecordedPayload,
  "run.retried": RetryPayload,
  "phase.rerun": RetryPayload,
  "run.remediated": RetryPayload,
  "run.reset": RetryPayload,
  "run.rolled-back": RollbackPayload,
} as const;

export type EventType = z.infer<typeof EventTypeSchema>;
export type EventPayloadByType = {
  [T in EventType]: z.infer<(typeof eventPayloadSchemas)[T]>;
};

export type RunEvent<T extends EventType = EventType> = T extends EventType
  ? Omit<DocumentValue<"event">, "type" | "data"> & {
      type: T;
      data: EventPayloadByType[T];
    }
  : never;

export type EventDraft<T extends EventType = EventType> = T extends EventType
  ? Omit<
      RunEvent<T>,
      "schemaVersion" | "eventId" | "runId" | "sequence" | "timestamp"
    > & {
      eventId?: string;
      timestamp?: string;
    }
  : never;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export function parseRunEvent(value: unknown): RunEvent {
  const envelope = EventSchema.parse(value);
  const payload = eventPayloadSchemas[envelope.type].parse(envelope.data);
  return deepFreeze({ ...envelope, data: payload }) as RunEvent;
}

export function createRunEvent<T extends EventType>(
  input: Omit<EventDraft<T>, "data"> & {
    runId: string;
    sequence: number;
    data: EventPayloadByType[T];
  },
): RunEvent<T> {
  return parseRunEvent({
    schemaVersion: 1,
    eventId: input.eventId ?? crypto.randomUUID(),
    runId: input.runId,
    sequence: input.sequence,
    timestamp: input.timestamp ?? new Date().toISOString(),
    type: input.type,
    actor: input.actor,
    context: input.context,
    idempotencyKey: input.idempotencyKey,
    data: input.data,
  }) as RunEvent<T>;
}

export function createRunState(run: Run): RunState {
  const parsedRun = RunSchema.parse(run);
  const phases = Object.fromEntries(
    (parsedRun.phaseIds ?? []).map((id) => [
      id,
      {
        id,
        status: "pending" as const,
        attemptIds: [],
        workUnits: {},
        checks: {},
      },
    ]),
  );
  return {
    run: parsedRun,
    phases,
    attempts: {},
    artifacts: {},
    invocations: {},
    checkpoints: {},
    deliveries: {},
    lastSequence: -1,
  };
}

const runTransitions: Record<RunStatus, readonly RunStatus[]> = {
  pending: ["running", "blocked", "cancelled", "skipped"],
  running: ["blocked", "paused", "failed", "cancelled", "skipped", "completed"],
  blocked: ["running", "paused", "failed", "cancelled", "skipped"],
  paused: ["running", "failed", "cancelled", "skipped"],
  failed: ["pending", "running", "cancelled", "skipped"],
  cancelled: ["pending", "skipped"],
  skipped: ["pending"],
  completed: ["pending"],
};

const phaseTransitions: Record<PhaseStatus, readonly PhaseStatus[]> = {
  pending: ["running", "blocked", "cancelled", "skipped"],
  running: ["blocked", "failed", "cancelled", "completed"],
  blocked: ["running", "failed", "cancelled", "skipped"],
  failed: ["pending", "running", "cancelled", "skipped"],
  cancelled: ["pending", "skipped"],
  skipped: ["pending"],
  completed: ["pending"],
};

function assertTransition<T extends string>(
  transitions: Record<T, readonly T[]>,
  from: T,
  to: T,
  subject: string,
): void {
  if (!transitions[from].includes(to))
    throw new Error(`Illegal ${subject} transition: ${from} -> ${to}`);
}

function cloneState(state: RunState): RunState {
  return {
    ...state,
    run: { ...state.run },
    phases: Object.fromEntries(
      Object.entries(state.phases).map(([id, phase]) => [
        id,
        {
          ...phase,
          attemptIds: [...phase.attemptIds],
          workUnits: { ...phase.workUnits },
          checks: { ...phase.checks },
          gate: phase.gate ? { ...phase.gate } : undefined,
        },
      ]),
    ),
    attempts: { ...state.attempts },
    artifacts: { ...state.artifacts },
    invocations: { ...state.invocations },
    checkpoints: { ...state.checkpoints },
    deliveries: { ...state.deliveries },
  };
}

function requirePhase(state: RunState, phaseId: string): Phase {
  const phase = state.phases[phaseId];
  if (!phase) throw new Error(`Event references unknown phase: ${phaseId}`);
  return phase;
}

export function reduceRunState(state: RunState, event: RunEvent): RunState {
  if (event.runId !== state.run.runId)
    throw new Error(`Event ${event.eventId} belongs to another run`);
  if (event.sequence !== state.lastSequence + 1) {
    throw new Error(
      `Expected event sequence ${state.lastSequence + 1}, received ${event.sequence}`,
    );
  }

  const next = cloneState(state);
  switch (event.type) {
    case "run.created":
      if (event.sequence !== 0)
        throw new Error("run.created must be the first event");
      break;
    case "run.transitioned": {
      if (next.run.status !== event.data.from)
        throw new Error(
          `Run transition expected ${event.data.from}, found ${next.run.status}`,
        );
      assertTransition(runTransitions, event.data.from, event.data.to, "run");
      next.run.status = event.data.to;
      break;
    }
    case "phase.transitioned": {
      const phase = requirePhase(next, event.data.phaseId);
      if (phase.status !== event.data.from)
        throw new Error(
          `Phase transition expected ${event.data.from}, found ${phase.status}`,
        );
      assertTransition(
        phaseTransitions,
        event.data.from,
        event.data.to,
        `phase ${phase.id}`,
      );
      phase.status = event.data.to;
      phase.updatedAt = event.timestamp;
      break;
    }
    case "attempt.started": {
      const phase = requirePhase(next, event.data.phaseId);
      if (next.attempts[event.data.attemptId])
        throw new Error(`Attempt already exists: ${event.data.attemptId}`);
      next.attempts[event.data.attemptId] = {
        ...event.data,
        status: "running",
        startedAt: event.timestamp,
      };
      phase.attemptIds.push(event.data.attemptId);
      break;
    }
    case "attempt.completed": {
      const attempt = next.attempts[event.data.attemptId];
      if (!attempt)
        throw new Error(
          `Event references unknown attempt: ${event.data.attemptId}`,
        );
      if (attempt.status !== "running" && attempt.status !== "blocked") {
        throw new Error(`Attempt ${attempt.attemptId} is not active`);
      }
      next.attempts[attempt.attemptId] = {
        ...attempt,
        status: event.data.status,
        endedAt: event.timestamp,
        reason: event.data.reason,
      };
      break;
    }
    case "work-unit.transitioned": {
      const phase = requirePhase(next, event.data.phaseId);
      const previous = phase.workUnits[event.data.workUnitId];
      if (event.data.from && previous?.status !== event.data.from) {
        throw new Error(
          `Work unit transition expected ${event.data.from}, found ${previous?.status ?? "missing"}`,
        );
      }
      phase.workUnits[event.data.workUnitId] = {
        id: event.data.workUnitId,
        phaseId: event.data.phaseId,
        status: event.data.to,
        updatedAt: event.timestamp,
        attemptId: event.data.attemptId,
        outputRef: event.data.outputRef,
      };
      break;
    }
    case "check.recorded": {
      const phase = requirePhase(next, event.data.phaseId);
      phase.checks[event.data.checkId] = {
        id: event.data.checkId,
        phaseId: event.data.phaseId,
        status: event.data.status,
        updatedAt: event.timestamp,
        artifactId: event.data.artifactId,
        reason: event.data.reason,
      };
      break;
    }
    case "gate.decided": {
      const phase = requirePhase(next, event.data.phaseId);
      phase.gate = {
        id: event.data.gateId,
        phaseId: event.data.phaseId,
        status: event.data.status,
        decidedAt: event.timestamp,
        reason: event.data.reason,
      };
      break;
    }
    case "artifact.recorded":
      next.artifacts[event.data.artifact.artifactId] = event.data.artifact;
      break;
    case "invocation.recorded":
      next.invocations[event.data.invocation.invocationId] =
        event.data.invocation;
      break;
    case "checkpoint.recorded":
      next.checkpoints[event.data.checkpoint.checkpointId] =
        event.data.checkpoint;
      break;
    case "delivery.recorded":
      next.deliveries[event.data.delivery.deliveryId] = event.data.delivery;
      break;
    case "run.retried":
    case "phase.rerun":
    case "run.remediated":
    case "run.reset": {
      requirePhase(next, event.data.phaseId);
      const attempt = next.attempts[event.data.attemptId];
      const expectedKind = {
        "run.retried": "retry",
        "phase.rerun": "rerun",
        "run.remediated": "remediation",
        "run.reset": "reset",
      }[event.type];
      if (
        !attempt ||
        attempt.phaseId !== event.data.phaseId ||
        attempt.kind !== expectedKind
      ) {
        throw new Error(`${event.type} must reference its matching attempt`);
      }
      break;
    }
    case "run.rolled-back": {
      requirePhase(next, event.data.phaseId);
      const attempt = next.attempts[event.data.attemptId];
      if (
        !attempt ||
        attempt.phaseId !== event.data.phaseId ||
        attempt.kind !== "rollback"
      ) {
        throw new Error("run.rolled-back must reference a rollback attempt");
      }
      if (!next.checkpoints[event.data.checkpointId])
        throw new Error(
          `Rollback references unknown checkpoint: ${event.data.checkpointId}`,
        );
      for (const phaseId of event.data.invalidatedPhaseIds) {
        const phase = requirePhase(next, phaseId);
        phase.status = "pending";
        phase.updatedAt = event.timestamp;
      }
      break;
    }
  }
  next.lastSequence = event.sequence;
  next.run.updatedAt = event.timestamp;
  return next;
}

export function reconstructRunState(
  run: Run,
  events: readonly RunEvent[],
): RunState {
  let state = createRunState(run);
  for (const event of events) state = reduceRunState(state, event);
  return state;
}
