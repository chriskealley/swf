<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { actionCommandType } from "@swf/core/operator-actions";
import { DashboardApi, StaleClientError } from "./api.js";
import {
  activeStatuses,
  aggregateCosts,
  bytes,
  formatAggregateCosts,
  formatInvocationCost,
  normalizedHarnessProgress,
} from "./model.js";
import type {
  AdapterDiagnostic,
  BudgetDecision,
  DashboardOverview,
  OutputResult,
  OperatorProjection,
  PruningPreview,
  ProjectSummary,
  Run,
  RunDetail,
} from "./types.js";

const endpoint = ref("http://127.0.0.1:34671");
const credential = ref("");
const api = ref<DashboardApi>();
const overview = ref<DashboardOverview>();
const adapters = ref<AdapterDiagnostic[]>([]);
const project = ref<ProjectSummary>();
const runs = ref<Run[]>([]);
const detail = ref<RunDetail>();
const guidance = ref<OperatorProjection>();
const budgetDecisions = ref<BudgetDecision[]>([]);
const output = ref<OutputResult>();
const pruning = ref<PruningPreview>();
const ageDays = ref<number>();
const budgetMiB = ref<number>();
const pruneRunId = ref("");
const loading = ref(false);
const message = ref("Enter the local service credential to connect.");
const error = ref("");
const liveState = ref<
  "offline" | "connecting" | "live" | "reconnecting" | "closed"
>("offline");
const recentHarnessProgress = ref<string[]>([]);
let unsubscribe: (() => void) | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

const activeRuns = computed(() =>
  runs.value.filter((run) => activeStatuses.has(run.status)),
);
const historicalRuns = computed(() =>
  runs.value.filter((run) => !activeStatuses.has(run.status)),
);
const invocations = computed(() =>
  detail.value
    ? Object.values(detail.value.state.invocations).sort((a, b) =>
        b.startedAt.localeCompare(a.startedAt),
      )
    : [],
);
const artifacts = computed(() =>
  detail.value
    ? Object.values(detail.value.state.artifacts).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      )
    : [],
);

function report(problem: unknown) {
  error.value =
    problem instanceof Error ? problem.message : "Unexpected dashboard error";
  if (problem instanceof StaleClientError)
    message.value =
      "This dashboard is stale. Upgrade or reload the matching SWF dashboard.";
}

async function busy<T>(operation: () => Promise<T>): Promise<T | undefined> {
  loading.value = true;
  error.value = "";
  try {
    return await operation();
  } catch (problem) {
    report(problem);
    return undefined;
  } finally {
    loading.value = false;
  }
}

async function loadOverview() {
  if (!api.value) return;
  const result = await busy(() =>
    Promise.all([
      api.value!.query<DashboardOverview>("overview"),
      api.value!.query<AdapterDiagnostic[]>("adapters"),
    ]),
  );
  if (result) {
    overview.value = result[0];
    adapters.value = result[1];
  }
}

async function connect() {
  try {
    api.value = new DashboardApi(endpoint.value, credential.value);
    credential.value = "";
  } catch (problem) {
    report(problem);
    return;
  }
  await loadOverview();
  if (!overview.value) {
    api.value = undefined;
    return;
  }
  message.value = "Connected to the local SWF service.";
  unsubscribe?.();
  unsubscribe = api.value.subscribe(
    (event) => {
      if (
        event.projectId === project.value?.projectId &&
        event.runId === detail.value?.state.run.runId
      ) {
        const progress = normalizedHarnessProgress(event);
        if (progress && recentHarnessProgress.value.at(-1) !== progress)
          recentHarnessProgress.value = [
            ...recentHarnessProgress.value.slice(-7),
            progress,
          ];
      }
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void refreshCurrent(), 100);
    },
    (state) => {
      liveState.value = state;
    },
  );
}

async function refreshCurrent() {
  await loadOverview();
  if (project.value) await openProject(project.value.projectId, false);
  if (project.value && detail.value)
    await openRun(detail.value.state.run.runId, false);
}

async function openProject(projectId: string, clearRun = true) {
  const selected = overview.value?.projects.find(
    (candidate) => candidate.projectId === projectId,
  );
  if (!selected) return;
  project.value = selected;
  if (clearRun) {
    detail.value = undefined;
    guidance.value = undefined;
    budgetDecisions.value = [];
    output.value = undefined;
    pruning.value = undefined;
  }
  if (selected.availability !== "available") {
    runs.value = [];
    return;
  }
  const loaded = await busy(() =>
    api.value!.query<Run[]>("runs", { projectId }),
  );
  if (loaded)
    runs.value = loaded.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function openRun(runId: string, clearOutput = true) {
  if (!project.value) return;
  if (clearOutput) recentHarnessProgress.value = [];
  const loaded = await busy(() =>
    Promise.all([
      api.value!.query<RunDetail>("run", {
        projectId: project.value!.projectId,
        runId,
      }),
      api.value!.query<BudgetDecision[]>("budgets", {
        projectId: project.value!.projectId,
        runId,
      }),
      api.value!.query<OperatorProjection>("operator-projection", {
        projectId: project.value!.projectId,
        runId,
      }),
    ]),
  );
  if (loaded) {
    detail.value = loaded[0];
    budgetDecisions.value = loaded[1];
    guidance.value = loaded[2];
  }
  if (clearOutput) output.value = undefined;
}

async function inspectOutput(ref: string, raw = false) {
  if (!project.value || !detail.value) return;
  const loaded = await busy(() =>
    api.value!.query<OutputResult>("output", {
      projectId: project.value!.projectId,
      runId: detail.value!.state.run.runId,
      ref,
      raw,
    }),
  );
  if (loaded) output.value = loaded;
}

async function runCommand(type: "start" | "pause" | "resume" | "cancel") {
  if (!project.value || !detail.value) return;
  if (
    type === "cancel" &&
    !window.confirm("Cancel this run? Partial output will be retained.")
  )
    return;
  await busy(() =>
    api.value!.command({
      type,
      projectId: project.value!.projectId,
      runId: detail.value!.state.run.runId,
    }),
  );
  message.value = `${type} command accepted.`;
  await refreshCurrent();
}

async function deliveryCommand(type: "deliver" | "refresh-delivery") {
  if (!project.value || !detail.value) return;
  if (
    type === "deliver" &&
    !window.confirm(
      "Start the configured delivery? This may push the run branch and create or update a pull request.",
    )
  )
    return;
  await busy(() =>
    api.value!.command({
      type,
      projectId: project.value!.projectId,
      runId: detail.value!.state.run.runId,
    }),
  );
  message.value = `${type === "deliver" ? "Delivery started" : "Delivery refreshed"}.`;
  await refreshCurrent();
}

async function runSemanticAction(
  action: OperatorProjection["allowedActions"][number],
) {
  if (!api.value) return;
  if (
    action.requiresConfirmation &&
    !window.confirm(
      `${action.label}? The service will revalidate current state.`,
    )
  )
    return;
  const reason = ["request-changes", "reject"].includes(action.type)
    ? window.prompt("Reason", "") || undefined
    : undefined;
  if (["request-changes", "reject"].includes(action.type) && !reason) return;
  const type = actionCommandType(action);
  if (!type) {
    message.value = `${action.label}. Use the referenced artifacts, branch, or project configuration below.`;
    return;
  }
  const response =
    action.type === "reply-to-invocation"
      ? window.prompt("Reply to the blocked agent", "") || undefined
      : undefined;
  if (action.type === "reply-to-invocation" && !response) return;
  const result = await busy(() =>
    api.value!.command<{ projection?: OperatorProjection }>({
      type,
      ...action.parameters,
      actorId: "dashboard-operator",
      reason,
      response,
    }),
  );
  if (result?.projection) guidance.value = result.projection;
  message.value = `${action.label} completed.`;
  await refreshCurrent();
}

async function previewPruning() {
  if (!project.value) return;
  const criteria = {
    ageDays: ageDays.value,
    runId: pruneRunId.value || undefined,
    budgetBytes:
      budgetMiB.value === undefined
        ? undefined
        : Math.round(budgetMiB.value * 1024 * 1024),
  };
  const result = await busy(() =>
    api.value!.previewPruning(project.value!.projectId, criteria),
  );
  if (result) pruning.value = result;
}

async function confirmPruning() {
  if (!project.value || !pruning.value) return;
  if (
    !window.confirm(
      `Permanently prune ${pruning.value.candidates.length} raw outputs (${bytes(pruning.value.totalBytes)})? Audit summaries will remain.`,
    )
  )
    return;
  const result = await busy(() =>
    api.value!.confirmPruning(
      project.value!.projectId,
      pruning.value!.confirmationId,
    ),
  );
  if (result)
    message.value = `Pruned ${result.pruned} raw outputs (${bytes(result.bytes)}).`;
  pruning.value = undefined;
  await refreshCurrent();
}

function backToProjects() {
  project.value = undefined;
  detail.value = undefined;
  guidance.value = undefined;
  output.value = undefined;
  pruning.value = undefined;
}
function backToRuns() {
  detail.value = undefined;
  guidance.value = undefined;
  output.value = undefined;
}
function capabilityNames(adapter: AdapterDiagnostic): string {
  const labels: Record<string, string> = {
    structuredEvents: "events",
    modelSelection: "models",
    toolSelection: "tools",
    cancellation: "cancel",
    blockedInput: "input",
    resume: "resume",
    usage: "usage",
  };
  return Object.entries(adapter.capabilities)
    .filter(([, enabled]) => enabled)
    .map(([name]) => labels[name] ?? name)
    .join(" · ");
}

function phaseCosts(phaseId: string) {
  return formatAggregateCosts(
    aggregateCosts(
      invocations.value.filter((item) => item.phaseId === phaseId),
    ),
  ).join(" · ");
}

onUnmounted(() => {
  unsubscribe?.();
  if (refreshTimer) clearTimeout(refreshTimer);
});
</script>

<template>
  <a class="skip-link" href="#content">Skip to content</a>
  <header class="topbar">
    <button
      class="brand"
      type="button"
      @click="backToProjects"
      aria-label="SWF project index"
    >
      SWF <span>Control Room</span>
    </button>
    <div v-if="api" class="connection" :data-state="liveState">
      <span aria-hidden="true"></span>{{ liveState }}
    </div>
  </header>

  <main id="content" tabindex="-1">
    <p class="sr-only" aria-live="polite">{{ message }}</p>
    <div v-if="error" class="alert" role="alert">
      <strong>Unable to continue</strong><span>{{ error }}</span>
    </div>

    <section v-if="!api" class="auth-shell" aria-labelledby="auth-title">
      <div class="eyebrow">Local authenticated service</div>
      <h1 id="auth-title">
        Your software factory,<br /><em>under control.</em>
      </h1>
      <p>
        Connect directly to the user-scoped SWF service. Credentials remain in
        memory and are never persisted by this dashboard.
      </p>
      <form @submit.prevent="connect" class="auth-form">
        <label
          >Service endpoint<input
            v-model="endpoint"
            inputmode="url"
            autocomplete="url"
            required
        /></label>
        <label
          >Service credential<input
            v-model="credential"
            type="password"
            autocomplete="off"
            required
        /></label>
        <button class="primary" type="submit" :disabled="loading">
          {{ loading ? "Connecting…" : "Connect securely" }}
        </button>
      </form>
    </section>

    <template v-else-if="overview">
      <section v-if="!project" aria-labelledby="projects-title">
        <div class="page-heading">
          <div>
            <div class="eyebrow">Global overview</div>
            <h1 id="projects-title">Registered projects</h1>
          </div>
          <button type="button" @click="loadOverview" :disabled="loading">
            Refresh
          </button>
        </div>
        <div class="metrics" aria-label="Factory totals">
          <article>
            <span>Projects</span><strong>{{ overview.totals.projects }}</strong>
          </article>
          <article>
            <span>Active runs</span
            ><strong>{{ overview.totals.activeRuns }}</strong>
          </article>
          <article>
            <span>Waiting gates</span
            ><strong>{{ overview.totals.waitingGates }}</strong>
          </article>
          <article>
            <span>Failures</span><strong>{{ overview.totals.failures }}</strong>
          </article>
          <article class="wide">
            <span>Aggregate spend</span
            ><strong>{{
              formatAggregateCosts(overview.totals).join(" · ")
            }}</strong>
          </article>
        </div>
        <section class="adapter-panel" aria-labelledby="adapters-title">
          <div>
            <div class="eyebrow">Harness capability report</div>
            <h2 id="adapters-title">Installed adapters</h2>
          </div>
          <div class="adapter-grid">
            <article v-for="adapter in adapters" :key="adapter.id">
              <header>
                <strong>{{ adapter.id }}</strong>
                <span
                  class="status"
                  :data-status="adapter.available ? 'available' : 'unavailable'"
                  >{{ adapter.available ? "ready" : "unavailable" }}</span
                >
              </header>
              <p>
                {{ capabilityNames(adapter) || "No advertised capabilities" }}
              </p>
              <small v-if="adapter.errors.length">{{
                adapter.errors.join(" · ")
              }}</small>
            </article>
          </div>
        </section>
        <div class="project-grid">
          <article
            v-for="item in overview.projects"
            :key="item.projectId"
            class="project-card"
            :class="{ unavailable: item.availability !== 'available' }"
          >
            <div class="card-top">
              <span class="status" :data-status="item.availability">{{
                item.availability
              }}</span
              ><span>{{ new Date(item.lastSeenAt).toLocaleString() }}</span>
            </div>
            <h2>{{ item.displayName }}</h2>
            <code>{{ item.root }}</code>
            <dl>
              <div>
                <dt>Active</dt>
                <dd>{{ item.activeRuns }}</dd>
              </div>
              <div>
                <dt>Gates</dt>
                <dd>{{ item.waitingGates }}</dd>
              </div>
              <div>
                <dt>Failures</dt>
                <dd>{{ item.failures }}</dd>
              </div>
            </dl>
            <p class="cost">
              {{ formatAggregateCosts(item.costs).join(" · ") }}
            </p>
            <p v-if="item.unavailableReason" class="muted">
              {{ item.unavailableReason }}
            </p>
            <h3>Recent invocations</h3>
            <ul class="compact-list">
              <li
                v-for="call in item.recentInvocations"
                :key="call.invocationId"
              >
                <span>{{ call.phaseId }} · {{ call.harness }}</span
                ><small>{{ formatInvocationCost(call) }}</small>
              </li>
              <li v-if="!item.recentInvocations.length" class="muted">
                No retained invocations
              </li>
            </ul>
            <button
              type="button"
              class="card-action"
              @click="openProject(item.projectId)"
            >
              View project <span aria-hidden="true">→</span>
            </button>
          </article>
        </div>
      </section>

      <section v-else-if="!detail" aria-labelledby="runs-title">
        <nav aria-label="Breadcrumb">
          <button type="button" class="text-button" @click="backToProjects">
            Projects</button
          ><span>/</span><span>{{ project.displayName }}</span>
        </nav>
        <div class="page-heading">
          <div>
            <div class="eyebrow">{{ project.availability }}</div>
            <h1 id="runs-title">{{ project.displayName }}</h1>
            <code>{{ project.root }}</code>
          </div>
          <button type="button" @click="openProject(project.projectId)">
            Refresh
          </button>
        </div>
        <div
          v-if="project.availability !== 'available'"
          class="empty"
          role="status"
        >
          <h2>Project unavailable</h2>
          <p>
            {{
              project.unavailableReason ||
              "The registered path cannot currently be accessed."
            }}
          </p>
        </div>
        <template v-else>
          <div class="split-runs">
            <section aria-labelledby="active-title">
              <h2 id="active-title">
                Active runs <span>{{ activeRuns.length }}</span>
              </h2>
              <div class="run-list">
                <button
                  v-for="run in activeRuns"
                  :key="run.runId"
                  type="button"
                  @click="openRun(run.runId)"
                >
                  <span
                    ><strong>{{ run.changeName }}</strong
                    ><small>{{ run.description }}</small></span
                  ><span class="status" :data-status="run.status">{{
                    run.status
                  }}</span>
                </button>
                <p v-if="!activeRuns.length" class="empty">No active runs.</p>
              </div>
            </section>
            <section aria-labelledby="history-title">
              <h2 id="history-title">
                History <span>{{ historicalRuns.length }}</span>
              </h2>
              <div class="run-list">
                <button
                  v-for="run in historicalRuns"
                  :key="run.runId"
                  type="button"
                  @click="openRun(run.runId)"
                >
                  <span
                    ><strong>{{ run.changeName }}</strong
                    ><small>{{
                      new Date(run.updatedAt).toLocaleString()
                    }}</small></span
                  ><span class="status" :data-status="run.status">{{
                    run.status
                  }}</span>
                </button>
                <p v-if="!historicalRuns.length" class="empty">
                  No historical runs.
                </p>
              </div>
            </section>
          </div>
          <section class="storage" aria-labelledby="storage-title">
            <div>
              <div class="eyebrow">Retention</div>
              <h2 id="storage-title">Raw output storage</h2>
              <p>
                Preview eligible data before permanent pruning. Run history,
                summaries, costs, and evidence remain.
              </p>
            </div>
            <form @submit.prevent="previewPruning">
              <label
                >Older than (days)<input
                  v-model.number="ageDays"
                  type="number"
                  min="0" /></label
              ><label
                >Selected run<select v-model="pruneRunId">
                  <option value="">All runs</option>
                  <option
                    v-for="run in runs"
                    :key="run.runId"
                    :value="run.runId"
                  >
                    {{ run.changeName }}
                  </option>
                </select></label
              ><label
                >Storage budget (MiB)<input
                  v-model.number="budgetMiB"
                  type="number"
                  min="0"
                  step="0.1" /></label
              ><button type="submit">Preview pruning</button>
            </form>
            <div v-if="pruning" class="prune-preview" aria-live="polite">
              <strong
                >{{ pruning.candidates.length }} outputs ·
                {{ bytes(pruning.totalBytes) }}</strong
              ><span
                >Preview expires
                {{ new Date(pruning.expiresAt).toLocaleTimeString() }}</span
              ><button
                type="button"
                class="danger"
                @click="confirmPruning"
                :disabled="!pruning.candidates.length"
              >
                Confirm permanent pruning
              </button>
            </div>
          </section>
        </template>
      </section>

      <section v-else aria-labelledby="run-title">
        <nav aria-label="Breadcrumb">
          <button type="button" class="text-button" @click="backToProjects">
            Projects</button
          ><span>/</span
          ><button type="button" class="text-button" @click="backToRuns">
            {{ project.displayName }}</button
          ><span>/</span><span>{{ detail.state.run.changeName }}</span>
        </nav>
        <div class="run-hero">
          <div>
            <div class="eyebrow">OpenSpec change</div>
            <h1 id="run-title">{{ detail.state.run.changeName }}</h1>
            <p>{{ detail.state.run.description }}</p>
          </div>
          <span class="status large" :data-status="detail.state.run.status">{{
            detail.state.run.status
          }}</span>
        </div>
        <div class="run-meta">
          <div>
            <span>Identity</span
            ><code>{{
              detail.state.run.changeIdentity || detail.state.run.changeName
            }}</code>
          </div>
          <div>
            <span>Workflow</span
            ><strong>{{ detail.state.run.workflowId }}</strong>
          </div>
          <div>
            <span>Branch</span
            ><code>{{
              detail.runtime?.branch || `swf/${detail.state.run.runId}`
            }}</code>
          </div>
          <div>
            <span>Worktree</span
            ><code>{{
              detail.runtime?.worktreePath || "Not established"
            }}</code>
          </div>
          <div>
            <span>Run spend</span
            ><strong>{{
              formatAggregateCosts(detail.costs).join(" · ")
            }}</strong>
          </div>
          <div>
            <span>Budget status</span
            ><strong>{{
              budgetDecisions.length
                ? budgetDecisions.every((decision) => decision.allowed)
                  ? "available"
                  : budgetDecisions
                      .filter((decision) => !decision.allowed)
                      .map(
                        (decision) => `${decision.scope}: ${decision.status}`,
                      )
                      .join(" · ")
                : "not configured"
            }}</strong>
          </div>
        </div>
        <section
          v-if="guidance"
          class="gate"
          aria-labelledby="operator-guidance-title"
        >
          <h2 id="operator-guidance-title">Operator guidance</h2>
          <p>{{ guidance.summary }}</p>
          <ul v-if="guidance.attention.length" class="compact-list">
            <li v-for="item in guidance.attention" :key="item.attentionId">
              <strong>{{ item.title }}</strong
              ><span>{{ item.reason }}</span>
            </li>
          </ul>
          <div class="controls" aria-label="Recommended actions">
            <button
              v-for="action in guidance.allowedActions"
              :key="action.actionId"
              type="button"
              :class="{ primary: action.recommended }"
              @click="runSemanticAction(action)"
            >
              {{ action.label }}
            </button>
          </div>
        </section>
        <div class="controls" aria-label="Run controls">
          <button type="button" @click="runCommand('start')">Start</button
          ><button type="button" @click="runCommand('pause')">Pause</button
          ><button type="button" @click="runCommand('resume')">Resume</button>
          <button
            v-if="detail.state.run.status === 'completed'"
            type="button"
            @click="deliveryCommand('deliver')"
          >
            Deliver
          </button>
          <button
            v-if="Object.keys(detail.state.deliveries).length"
            type="button"
            @click="deliveryCommand('refresh-delivery')"
          >
            Refresh delivery
          </button>
          <button type="button" class="danger" @click="runCommand('cancel')">
            Cancel
          </button>
        </div>

        <section
          v-if="recentHarnessProgress.length"
          aria-labelledby="harness-progress-title"
          aria-live="polite"
        >
          <h2 id="harness-progress-title">Live harness progress</h2>
          <ul class="compact-list">
            <li v-for="(progress, index) in recentHarnessProgress" :key="index">
              <span>{{ progress }}</span>
            </li>
          </ul>
        </section>

        <section aria-labelledby="timeline-title">
          <h2 id="timeline-title">Phase timeline</h2>
          <ol class="timeline">
            <li v-for="phase in detail.state.phases" :key="phase.id">
              <div class="node" :data-status="phase.status"></div>
              <article>
                <header>
                  <div>
                    <h3>{{ phase.id }}</h3>
                    <span class="status" :data-status="phase.status">{{
                      phase.status
                    }}</span>
                  </div>
                  <small>{{ phaseCosts(phase.id) }}</small>
                </header>
                <p>
                  {{ phase.attemptIds.length }} attempt{{
                    phase.attemptIds.length === 1 ? "" : "s"
                  }}
                  · {{ Object.keys(phase.checks).length }} checks
                </p>
                <ul class="compact-list">
                  <li v-for="work in phase.workUnits" :key="work.id">
                    <span>Output · {{ work.id }}</span>
                    <button
                      v-if="work.outputRef"
                      type="button"
                      @click="inspectOutput(work.outputRef)"
                    >
                      Inspect
                    </button>
                    <span v-else class="status" :data-status="work.status">{{
                      work.status
                    }}</span>
                  </li>
                  <li v-for="check in phase.checks" :key="check.id">
                    <span>Check · {{ check.id }}</span
                    ><span class="status" :data-status="check.status">{{
                      check.status
                    }}</span>
                  </li>
                </ul>
                <div v-if="phase.gate" class="gate">
                  <span>Gate {{ phase.gate.id }} · {{ phase.gate.status }}</span
                  ><span v-if="phase.gate.reason">{{ phase.gate.reason }}</span>
                </div>
              </article>
            </li>
          </ol>
        </section>

        <div class="detail-grid">
          <section aria-labelledby="attempts-title">
            <h2 id="attempts-title">Attempts</h2>
            <ul class="record-list">
              <li
                v-for="attempt in detail.state.attempts"
                :key="attempt.attemptId"
              >
                <div>
                  <strong>{{ attempt.phaseId }} #{{ attempt.number }}</strong
                  ><span>{{ attempt.kind }}</span>
                </div>
                <span class="status" :data-status="attempt.status">{{
                  attempt.status
                }}</span
                ><small>{{
                  new Date(attempt.startedAt).toLocaleString()
                }}</small>
              </li>
              <li
                v-if="!Object.keys(detail.state.attempts).length"
                class="empty"
              >
                No attempts recorded.
              </li>
            </ul>
          </section>
          <section aria-labelledby="delivery-title">
            <h2 id="delivery-title">Delivery & decisions</h2>
            <ul class="record-list">
              <li
                v-for="delivery in detail.state.deliveries"
                :key="delivery.deliveryId"
              >
                <div>
                  <strong
                    >Execution {{ delivery.executionStatus }} · Delivery
                    {{ delivery.status }}</strong
                  >
                  <span
                    >{{ delivery.mode }} · {{ delivery.mergeMethod }} ·
                    {{ delivery.branch }} → {{ delivery.targetBranch }}</span
                  >
                  <span v-if="delivery.mergeState"
                    >Merge state: {{ delivery.mergeState }}</span
                  >
                  <span v-if="delivery.hostedChecks.length"
                    >{{ delivery.hostedChecks.length }} hosted checks ·
                    {{
                      delivery.hostedChecks
                        .map((check) => check.conclusion || check.status)
                        .join(", ")
                    }}</span
                  >
                  <span v-if="delivery.reviews.length"
                    >Reviews:
                    {{
                      delivery.reviews
                        .map((review) => `${review.actor} ${review.state}`)
                        .join(", ")
                    }}</span
                  >
                  <span v-if="delivery.failureReason"
                    >{{ delivery.failureReason }} ·
                    {{ delivery.failureAction || "escalate" }}</span
                  >
                  <span v-if="delivery.cleanup?.branchDeleted"
                    >Source branch cleaned up</span
                  >
                  <span v-if="delivery.preflight"
                    >Release preflight:
                    {{ delivery.preflight.valid ? "passed" : "blocked" }} ·
                    {{ delivery.preflight.sourceCommit }} →
                    {{ delivery.preflight.targetCommit }}</span
                  >
                  <span v-if="delivery.cleanupState"
                    >Owned cleanup: {{ delivery.cleanupState.status }} ({{
                      delivery.cleanupState.removedResources.length
                    }}
                    removed)</span
                  >
                </div>
                <a
                  v-if="delivery.pullRequestUrl"
                  :href="delivery.pullRequestUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  >Open pull request</a
                >
              </li>
              <li
                v-if="!Object.keys(detail.state.deliveries).length"
                class="empty"
              >
                No delivery record.
              </li>
            </ul>
          </section>
        </div>

        <div class="detail-grid">
          <section aria-labelledby="invocations-title">
            <h2 id="invocations-title">Invocations & retained output</h2>
            <ul class="record-list">
              <li v-for="call in invocations" :key="call.invocationId">
                <div>
                  <strong>{{ call.phaseId }} · {{ call.harness }}</strong
                  ><span
                    >{{ call.modelTier || "no tier" }} ·
                    {{ call.model || "harness default" }} ·
                    {{ formatInvocationCost(call) }}</span
                  >
                </div>
                <span class="status" :data-status="call.status">{{
                  call.status
                }}</span
                ><button
                  v-if="call.outputRef"
                  type="button"
                  @click="inspectOutput(call.outputRef)"
                >
                  Inspect output
                </button>
              </li>
              <li v-if="!invocations.length" class="empty">
                No invocations recorded.
              </li>
            </ul>
          </section>
          <section aria-labelledby="artifacts-title">
            <h2 id="artifacts-title">Artifacts</h2>
            <ul class="record-list">
              <li v-for="artifact in artifacts" :key="artifact.artifactId">
                <div>
                  <strong>{{ artifact.type }}</strong
                  ><span
                    >{{ artifact.phaseId }} ·
                    {{ artifact.summary || artifact.outputRef }}</span
                  >
                </div>
                <span class="status" :data-status="artifact.status">{{
                  artifact.status
                }}</span>
                <div>
                  <button
                    type="button"
                    @click="inspectOutput(artifact.outputRef)"
                  >
                    Inspect</button
                  ><button
                    v-if="artifact.rawOutputRef"
                    type="button"
                    @click="inspectOutput(artifact.rawOutputRef)"
                  >
                    Raw output
                  </button>
                </div>
              </li>
              <li v-if="!artifacts.length" class="empty">
                No artifacts recorded.
              </li>
            </ul>
          </section>
        </div>

        <section
          v-if="output"
          class="output-panel"
          aria-labelledby="output-title"
        >
          <header>
            <div>
              <div class="eyebrow">Retained output</div>
              <h2 id="output-title">{{ output.ref }}</h2>
            </div>
            <span v-if="output.available"
              >{{ bytes(output.returnedBytes || 0) }} of
              {{ bytes(output.bytes || 0) }}</span
            >
          </header>
          <div v-if="!output.available" class="empty">{{ output.reason }}</div>
          <template v-else
            ><p v-if="output.truncated" class="notice">
              This view is explicitly truncated. Request raw output to retrieve
              up to the service safety limit.
            </p>
            <pre tabindex="0">{{ output.content }}</pre>
            <button
              v-if="output.truncated && !output.raw"
              type="button"
              @click="inspectOutput(output.ref, true)"
            >
              Retrieve raw output
            </button></template
          >
        </section>
      </section>
    </template>
  </main>
</template>
