import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  HarnessSchema,
  ModelMappingSchema,
  ModelRouteSchema,
  ModelRoutingSchema,
  ModelTierSchema,
  type DocumentValue,
} from "./schemas.js";
import type {
  AdapterCapabilities,
  AdapterValidation,
  HarnessAdapter,
} from "./scheduler.js";
import type { ConfigurationSources, ResolvedConfiguration } from "./project.js";
import { resolveConfigurationSources } from "./project.js";
import type {
  BudgetConfiguration,
  BudgetDecision,
  BudgetUsage,
} from "./budgets.js";
import { assertBudgetsAvailable, evaluateBudgets } from "./budgets.js";

export type HarnessId = DocumentValue<"profile">["harness"];
export type ModelTier = string;
export type ModelMapping =
  DocumentValue<"modelRouting">["modelTiers"][string][string];

export interface ModelRouteInput {
  harness: string;
  model?: string;
  modelTier?: string;
  sources?: ConfigurationSources;
}

export interface ResolvedModelRoute {
  harness: string;
  requestedTier?: string;
  concreteModel?: string;
  source: string;
  overriddenSources: string[];
  fallback?: string;
  allowHarnessDefault: boolean;
  mappingPath?: string;
  fingerprint: string;
}

export interface ModelRouteResolution {
  route: ResolvedModelRoute;
  configuration: ResolvedConfiguration;
}

export interface ModelRouteDiagnostic {
  tier: string;
  harness: string;
  path: string;
  status: "resolved" | "unresolved";
  model?: string;
  source?: string;
  message?: string;
}

export interface ModelMappingPreview {
  tier: string;
  harness: string;
  model: string;
  path: string;
  requiresConfirmation: true;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceForPath(
  resolved: ResolvedConfiguration,
  path: string,
): { source: string; overridden: string[] } {
  const entry =
    resolved.provenance[path] ??
    Object.entries(resolved.provenance).find(([key]) =>
      key.startsWith(`${path}.`),
    )?.[1];
  return {
    source: entry?.source ?? "built-in",
    overridden: entry?.overridden ?? [],
  };
}

export function resolveModelRoute(
  input: ModelRouteInput,
): ModelRouteResolution {
  const resolved = resolveConfigurationSources(input.sources ?? {});
  // Configuration layers are flattened by resolveConfigurationSources; keep
  // support for nested callers as well as the normal phase/runtime layers.
  const phase = isRecord(resolved.value.phase)
    ? resolved.value.phase
    : resolved.value;
  const profile = isRecord(resolved.value.profile)
    ? resolved.value.profile
    : {};
  const runtime = isRecord(resolved.value["run-time"])
    ? resolved.value["run-time"]
    : resolved.value;
  const harness = input.harness;
  const explicitModel =
    input.model ??
    (typeof runtime.model === "string" ? runtime.model : undefined) ??
    (typeof phase.model === "string" ? phase.model : undefined) ??
    (typeof profile.model === "string" ? profile.model : undefined);
  const requestedTier =
    input.modelTier ??
    (typeof runtime.modelTier === "string" ? runtime.modelTier : undefined) ??
    (typeof phase.modelTier === "string" ? phase.modelTier : undefined) ??
    (typeof profile.modelTier === "string" ? profile.modelTier : undefined);

  if (explicitModel) {
    const provenance = sourceForPath(resolved, "model");
    const route: ResolvedModelRoute = {
      harness,
      requestedTier,
      concreteModel: explicitModel,
      source: provenance.source,
      overriddenSources: provenance.overridden,
      allowHarnessDefault: false,
      fingerprint: fingerprint({
        harness,
        requestedTier,
        concreteModel: explicitModel,
        source: provenance.source,
      }),
    };
    return { route, configuration: resolved };
  }

  if (!requestedTier) {
    // Profiles created before model tiers remain readable. New tier-based
    // profiles must opt into a concrete mapping or harness default below.
    const route: ResolvedModelRoute = {
      harness,
      source: "legacy-profile",
      overriddenSources: [],
      allowHarnessDefault: true,
      fingerprint: fingerprint({ harness, source: "legacy-profile" }),
    };
    return { route, configuration: resolved };
  }
  if (!ModelTierSchema.safeParse(requestedTier).success)
    throw new Error(
      `No concrete model or valid model tier is configured for harness ${harness}`,
    );

  const modelTiers = isRecord(resolved.value.modelTiers)
    ? resolved.value.modelTiers
    : {};
  const tier = modelTiers[requestedTier];
  const mapping = isRecord(tier) ? tier[harness] : undefined;
  const parsed = mapping ? ModelMappingSchema.safeParse(mapping) : undefined;
  if (!parsed?.success)
    throw new Error(
      `No model mapping is configured for tier ${requestedTier} and harness ${harness}`,
    );
  const mappingValue = parsed.data;
  const provenance = sourceForPath(
    resolved,
    `modelTiers.${requestedTier}.${harness}`,
  );
  const concreteModel = mappingValue.model ?? mappingValue.fallback[0];
  const fallback =
    mappingValue.model && mappingValue.fallback.length
      ? mappingValue.fallback[0]
      : undefined;
  if (!concreteModel && !mappingValue.allowHarnessDefault)
    throw new Error(
      `Model tier ${requestedTier} has no concrete model for harness ${harness}; configure an explicit mapping or opt into the harness default`,
    );
  const route: ResolvedModelRoute = {
    harness,
    requestedTier,
    concreteModel,
    source: provenance.source,
    overriddenSources: provenance.overridden,
    fallback,
    allowHarnessDefault: mappingValue.allowHarnessDefault,
    mappingPath: `modelTiers.${requestedTier}.${harness}`,
    fingerprint: fingerprint({
      harness,
      requestedTier,
      mappingValue,
      source: provenance.source,
    }),
  };
  return { route, configuration: resolved };
}

export function validateModelRouteCapabilities(
  route: ResolvedModelRoute,
  adapter: Pick<HarnessAdapter, "capabilities" | "validate">,
  requiredCapabilities: string[] = [],
): AdapterValidation {
  const errors: string[] = [];
  if (route.concreteModel === undefined && !route.allowHarnessDefault)
    errors.push(
      `Model route for ${route.harness} has no concrete model and harness defaults are disabled`,
    );
  for (const capability of requiredCapabilities) {
    const key = capability.replace(/-([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    ) as keyof AdapterCapabilities;
    if (!(key in adapter.capabilities) || !adapter.capabilities[key])
      errors.push(
        `Harness ${route.harness} does not advertise required capability: ${capability}`,
      );
  }
  return { valid: errors.length === 0, errors };
}

export function admitModelRouteToBudgets(input: {
  route: ResolvedModelRoute;
  configuration: BudgetConfiguration;
  usage: BudgetUsage[];
  target: {
    projectId: string;
    runId: string;
    phaseId?: string;
    invocationId?: string;
  };
}): BudgetDecision[] {
  const decisions = evaluateBudgets(
    input.configuration,
    input.usage,
    input.target,
  );
  assertBudgetsAvailable(decisions);
  return decisions;
}

export function modelRouteExplanation(
  route: ResolvedModelRoute,
): DocumentValue<"modelRoute"> {
  return ModelRouteSchema.parse({
    harness: route.harness,
    modelTier: route.requestedTier,
    model: route.concreteModel,
    source: route.source,
    overriddenSources: route.overriddenSources,
    fallback: route.fallback,
    allowHarnessDefault: route.allowHarnessDefault,
    mappingPath: route.mappingPath,
    fingerprint: route.fingerprint,
  });
}

/** Return actionable diagnostics without launching a harness or consulting its defaults. */
export function diagnoseModelRoutes(input: {
  tiers: string[];
  harnesses: string[];
  sources?: ConfigurationSources;
}): ModelRouteDiagnostic[] {
  const resolved = resolveConfigurationSources(input.sources ?? {});
  return input.tiers.flatMap((tier) =>
    input.harnesses.map((harness) => {
      const path = `modelTiers.${tier}.${harness}`;
      const mapping =
        isRecord(resolved.value.modelTiers) &&
        isRecord(resolved.value.modelTiers[tier])
          ? resolved.value.modelTiers[tier][harness]
          : undefined;
      const parsed = mapping
        ? ModelMappingSchema.safeParse(mapping)
        : undefined;
      const provenance = sourceForPath(resolved, path);
      if (!parsed?.success)
        return {
          tier,
          harness,
          path,
          status: "unresolved",
          message: `Configure ${path} with a concrete model or explicitly enable the harness default`,
        };
      const model = parsed.data.model ?? parsed.data.fallback[0];
      if (!model && !parsed.data.allowHarnessDefault)
        return {
          tier,
          harness,
          path,
          status: "unresolved",
          source: provenance.source,
          message: `No concrete model is configured at ${path}`,
        };
      return {
        tier,
        harness,
        path,
        status: "resolved",
        model,
        source: provenance.source,
      };
    }),
  );
}

/** Build the exact, reviewable change for a mapping wizard. This function does not write files. */
export function previewModelMapping(input: {
  tier: string;
  harness: string;
  model: string;
  path?: string;
}): ModelMappingPreview {
  if (!ModelTierSchema.safeParse(input.tier).success)
    throw new Error(`Invalid model tier: ${input.tier}`);
  if (!input.model.trim())
    throw new Error("A concrete model identifier is required");
  return {
    tier: input.tier,
    harness: input.harness,
    model: input.model.trim(),
    path: input.path ?? `modelTiers.${input.tier}.${input.harness}`,
    requiresConfirmation: true,
  };
}

export async function applyModelMapping(input: {
  root: string;
  tier: string;
  harness: string;
  model: string;
  confirmed: boolean;
  configPath?: string;
}): Promise<{ path: string; mapping: ModelMappingPreview }> {
  if (!input.confirmed)
    throw new Error("Model mapping requires explicit confirmation");
  const mapping = previewModelMapping(input);
  const path = join(input.root, input.configPath ?? ".swf/models.yaml");
  let value: Record<string, unknown> = { schemaVersion: 1, modelTiers: {} };
  try {
    value = parseYaml(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const tiers: Record<string, unknown> =
    value.modelTiers && isRecord(value.modelTiers) ? value.modelTiers : {};
  const currentValue = tiers[input.tier];
  const current: Record<string, unknown> = isRecord(currentValue)
    ? currentValue
    : {};
  tiers[input.tier] = {
    ...current,
    [input.harness]: {
      model: input.model.trim(),
      fallback: [],
      allowHarnessDefault: false,
      capabilities: [],
    },
  };
  value.modelTiers = tiers;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.mapping.tmp`;
  await writeFile(temporary, stringifyYaml(value), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
  return { path, mapping };
}

export {
  HarnessSchema,
  ModelMappingSchema,
  ModelRouteSchema,
  ModelRoutingSchema,
  ModelTierSchema,
};
