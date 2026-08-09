import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  GuidelineSchema,
  PolicySchema,
  ProfileSchema,
  ProjectConfigSchema,
  WorkflowSchema,
  type DocumentValue,
} from "./schemas.js";

export const SWF_DIRECTORY = ".swf";
export const SWF_STATE_DIRECTORY = ".swf-state";

export interface ProjectLocation {
  root: string;
  configDirectory: string;
  stateDirectory: string;
  gitDirectory: string;
  initialized: boolean;
}

export interface ProjectTrustStore {
  schemaVersion: 1;
  projects: Array<{ root: string; trustedAt: string }>;
}

export interface TrustOptions {
  configHome?: string;
}

function defaultConfigHome(): string {
  return (
    process.env.SWF_CONFIG_HOME ??
    join(process.env.HOME ?? process.cwd(), ".config", "swf")
  );
}

function trustStorePath(options: TrustOptions = {}): string {
  return join(
    options.configHome ?? defaultConfigHome(),
    "trusted-projects.json",
  );
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function hasGitMarker(path: string): Promise<boolean> {
  try {
    await access(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

export async function findProjectRoot(
  cwd: string = process.cwd(),
): Promise<ProjectLocation | undefined> {
  let current = await realpath(resolve(cwd));
  let gitRoot: string | undefined;

  while (true) {
    const configDirectory = join(current, SWF_DIRECTORY);
    if (await isDirectory(configDirectory)) {
      return {
        root: current,
        configDirectory,
        stateDirectory: join(current, SWF_STATE_DIRECTORY),
        gitDirectory: join(current, ".git"),
        initialized: true,
      };
    }
    if (!gitRoot && (await hasGitMarker(current))) gitRoot = current;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (!gitRoot) return undefined;
  return {
    root: gitRoot,
    configDirectory: join(gitRoot, SWF_DIRECTORY),
    stateDirectory: join(gitRoot, SWF_STATE_DIRECTORY),
    gitDirectory: join(gitRoot, ".git"),
    initialized: false,
  };
}

async function readTrustStore(
  options: TrustOptions = {},
): Promise<ProjectTrustStore> {
  try {
    const value = JSON.parse(
      await readFile(trustStorePath(options), "utf8"),
    ) as ProjectTrustStore;
    if (value.schemaVersion === 1 && Array.isArray(value.projects))
      return value;
  } catch {
    // An absent or malformed store is untrusted. It is never interpreted as trusted.
  }
  return { schemaVersion: 1, projects: [] };
}

async function writeAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export async function isProjectTrusted(
  root: string,
  options: TrustOptions = {},
): Promise<boolean> {
  const canonicalRoot = await realpath(root);
  const trustStore = await readTrustStore(options);
  return trustStore.projects.some((project) => project.root === canonicalRoot);
}

export async function trustProject(
  root: string,
  options: TrustOptions = {},
): Promise<void> {
  const canonicalRoot = await realpath(root);
  const trustStore = await readTrustStore(options);
  const existing = trustStore.projects.find(
    (project) => project.root === canonicalRoot,
  );
  if (!existing)
    trustStore.projects.push({
      root: canonicalRoot,
      trustedAt: new Date().toISOString(),
    });
  await writeAtomic(
    trustStorePath(options),
    `${JSON.stringify(trustStore, null, 2)}\n`,
  );
}

const defaultProfiles = [
  ["planner", "Planning specialist", "planning"],
  ["builder", "Implementation specialist", "building"],
  ["reviewer", "Code review specialist", "reviewing"],
  ["verifier", "Verification specialist", "verifying"],
  ["releaser", "Release specialist", "releasing"],
] as const;

const defaultActivities = [
  "designing",
  "testing",
  "documenting",
  "writing",
] as const;

function defaultWorkflow(): DocumentValue<"workflow"> {
  return {
    schemaVersion: 1,
    id: "default",
    description: "Plan, build, review, verify, and release an OpenSpec change.",
    phases: defaultProfiles.map(([id, , guideline]) => ({
      id: guideline,
      title: guideline[0]!.toUpperCase() + guideline.slice(1),
      profile: id,
      guidelines: [guideline],
      requiredCapabilities: ["structured-events"],
      work: [
        { id: `${guideline}-agent`, type: "agent", profile: id, options: {} },
      ],
      checks: [],
      gate: { mode: guideline === "planning" ? "manual" : "automatic" },
    })),
    delivery: { mode: "pull-request", mergeMethod: "merge" },
  };
}

function defaultProjectConfig(): DocumentValue<"projectConfig"> {
  return {
    schemaVersion: 1,
    projectId: randomUUID(),
    defaultWorkflow: "default",
    git: { remote: "origin", targetBranch: "main" },
    paths: { state: SWF_STATE_DIRECTORY },
  };
}

function defaultPolicies(): DocumentValue<"policy">[] {
  return [
    {
      schemaVersion: 1,
      id: "manual",
      approvalMode: "manual",
      maxAttempts: 1,
      riskOverrides: [],
      allowDirectMerge: false,
      deliveryFailureAction: "escalate",
    },
    {
      schemaVersion: 1,
      id: "autonomous",
      approvalMode: "automatic",
      maxAttempts: 2,
      riskOverrides: [],
      allowDirectMerge: false,
      deliveryFailureAction: "remediate",
    },
    {
      schemaVersion: 1,
      id: "security-sensitive",
      approvalMode: "manual",
      maxAttempts: 1,
      riskOverrides: [
        "sensitive-path",
        "secret-finding",
        "destructive-operation",
      ],
      allowDirectMerge: false,
      deliveryFailureAction: "escalate",
    },
  ];
}

function defaultProfile(
  id: string,
  description: string,
  guideline: string,
): DocumentValue<"profile"> {
  return {
    schemaVersion: 1,
    id,
    description,
    harness: "pi",
    guidelines: [guideline],
    capabilities: ["structured-events", "model-selection"],
    options: {},
  };
}

function defaultGuideline(id: string): DocumentValue<"guideline"> {
  return {
    schemaVersion: 1,
    id,
    title: id[0]!.toUpperCase() + id.slice(1),
    content: `Follow the project ${id} guidelines. Preserve deterministic evidence and report unresolved risks.`,
  };
}

function defaultActivity(id: string): DocumentValue<"workflow"> {
  return {
    schemaVersion: 1,
    id,
    description: `Reusable ${id} activity.`,
    phases: [
      {
        id,
        title: id[0]!.toUpperCase() + id.slice(1),
        profile: "builder",
        guidelines: ["building"],
        requiredCapabilities: [],
        work: [],
        checks: [],
        gate: { mode: "manual" },
      },
    ],
    delivery: { mode: "local-branch", mergeMethod: "merge" },
  };
}

function operatorSkill(id: string): string {
  return `---\nname: swf-${id}\ndescription: Use the SWF ${id} operation through the service or swf CLI.\n---\n\nUse \`swf ${id}\` and report the returned durable run state. Do not recreate workflow logic in this skill.\n`;
}

export interface InitializeProjectOptions extends TrustOptions {
  cwd?: string;
  trust?: boolean;
}

export type InitializeProjectResult =
  | { status: "initialized"; project: ProjectLocation; created: string[] }
  | {
      status: "already-initialized";
      project: ProjectLocation;
      conflicts: string[];
    }
  | { status: "untrusted"; project: ProjectLocation };

async function ensureGitignore(root: string): Promise<boolean> {
  const path = join(root, ".gitignore");
  const content = existsSync(path) ? await readFile(path, "utf8") : "";
  const entries = content.split(/\r?\n/).filter(Boolean);
  if (
    entries.includes(`/${SWF_STATE_DIRECTORY}/`) ||
    entries.includes(`${SWF_STATE_DIRECTORY}/`)
  )
    return false;
  await writeFile(
    path,
    `${content.replace(/\s*$/, "")}${content.trim() ? "\n" : ""}/${SWF_STATE_DIRECTORY}/\n`,
    "utf8",
  );
  return true;
}

export async function initializeProject(
  options: InitializeProjectOptions = {},
): Promise<InitializeProjectResult> {
  const project = await findProjectRoot(options.cwd);
  if (!project)
    throw new Error(
      "SWF initialization requires a directory inside a Git worktree.",
    );

  if (!(await isProjectTrusted(project.root, options))) {
    if (!options.trust) return { status: "untrusted", project };
    await trustProject(project.root, options);
  }

  if (existsSync(project.configDirectory)) {
    return {
      status: "already-initialized",
      project: { ...project, initialized: true },
      conflicts: [project.configDirectory],
    };
  }

  const files: Array<[string, string]> = [];
  files.push([
    join(project.configDirectory, "config.yaml"),
    stringifyYaml(defaultProjectConfig()),
  ]);
  files.push([
    join(project.configDirectory, "workflows", "default.yaml"),
    stringifyYaml(defaultWorkflow()),
  ]);
  for (const policy of defaultPolicies())
    files.push([
      join(project.configDirectory, "policies", `${policy.id}.yaml`),
      stringifyYaml(policy),
    ]);
  for (const [id, description, guideline] of defaultProfiles) {
    files.push([
      join(project.configDirectory, "profiles", `${id}.yaml`),
      stringifyYaml(defaultProfile(id, description, guideline)),
    ]);
    files.push([
      join(project.configDirectory, "guidelines", `${guideline}.md`),
      defaultGuideline(guideline).content,
    ]);
  }
  for (const activity of defaultActivities)
    files.push([
      join(project.configDirectory, "activities", `${activity}.yaml`),
      stringifyYaml(defaultActivity(activity)),
    ]);
  for (const skill of [
    "explore",
    "new",
    "run",
    "next",
    "phase",
    "status",
    "approve",
    "artifacts",
  ]) {
    files.push([
      join(project.configDirectory, "skills", `${skill}.md`),
      operatorSkill(skill),
    ]);
  }

  for (const [path, contents] of files) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }
  await mkdir(project.stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(project.stateDirectory, 0o700);
  const ignored = await ensureGitignore(project.root);
  const created = files.map(([path]) => path);
  created.push(project.stateDirectory);
  if (ignored) created.push(join(project.root, ".gitignore"));
  return {
    status: "initialized",
    project: { ...project, initialized: true },
    created,
  };
}

export const configurationPrecedence = [
  "built-in",
  "user",
  "project",
  "workflow",
  "phase",
  "run-time",
] as const;
export type ConfigurationSource = (typeof configurationPrecedence)[number];

export interface ConfigurationLayer {
  name: string;
  value: Record<string, unknown>;
}

export type ConfigurationSources = Partial<
  Record<ConfigurationSource, Record<string, unknown>>
>;

export interface ProvenanceEntry {
  path: string;
  source: string;
  overridden: string[];
}

export interface ResolvedConfiguration {
  value: Record<string, unknown>;
  provenance: Record<string, ProvenanceEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeLayer(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  layer: string,
  provenance: Record<string, ProvenanceEntry>,
  prefix = "",
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, next] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const previous = result[key];
    if (isRecord(next)) {
      result[key] = mergeLayer(
        isRecord(previous) ? previous : {},
        next,
        layer,
        provenance,
        path,
      );
      continue;
    }
    const previousSource = provenance[path]?.source;
    result[key] = next;
    provenance[path] = {
      path,
      source: layer,
      overridden: previousSource
        ? [...(provenance[path]?.overridden ?? []), previousSource]
        : (provenance[path]?.overridden ?? []),
    };
  }
  return result;
}

export function resolveConfiguration(
  layers: ConfigurationLayer[],
): ResolvedConfiguration {
  const provenance: Record<string, ProvenanceEntry> = {};
  let value: Record<string, unknown> = {};
  for (const layer of layers)
    value = mergeLayer(value, layer.value, layer.name, provenance);
  return { value, provenance };
}

export function resolveConfigurationSources(
  sources: ConfigurationSources,
): ResolvedConfiguration {
  return resolveConfiguration(
    configurationPrecedence.flatMap((name) =>
      sources[name] ? [{ name, value: sources[name] }] : [],
    ),
  );
}

export function explainConfiguration(
  resolved: ResolvedConfiguration,
  path: string,
): ProvenanceEntry | undefined {
  return resolved.provenance[path];
}

export interface ConfigurationIssue {
  path: string;
  message: string;
}

async function parseYamlFile(path: string): Promise<unknown> {
  return parseYaml(await readFile(path, "utf8"));
}

export async function readProjectConfig(
  project: ProjectLocation,
): Promise<DocumentValue<"projectConfig">> {
  return ProjectConfigSchema.parse(
    await parseYamlFile(join(project.configDirectory, "config.yaml")),
  );
}

export async function loadProjectDeliverySettings(
  project: ProjectLocation,
  workflowId: string,
  policyId = "manual",
): Promise<{
  config: DocumentValue<"projectConfig">;
  workflow: DocumentValue<"workflow">;
  policy: DocumentValue<"policy">;
}> {
  const config = await readProjectConfig(project);
  const workflow = WorkflowSchema.parse(
    await parseYamlFile(
      join(project.configDirectory, "workflows", `${workflowId}.yaml`),
    ),
  );
  const policy = PolicySchema.parse(
    await parseYamlFile(
      join(project.configDirectory, "policies", `${policyId}.yaml`),
    ),
  );
  return { config, workflow, policy };
}

export async function loadProjectExecutionSettings(
  project: ProjectLocation,
  workflowId: string,
  policyId = "manual",
): Promise<{
  config: DocumentValue<"projectConfig">;
  workflow: DocumentValue<"workflow">;
  policy: DocumentValue<"policy">;
  profiles: Record<string, DocumentValue<"profile">>;
  guidelines: Record<string, string>;
}> {
  const settings = await loadProjectDeliverySettings(
    project,
    workflowId,
    policyId,
  );
  const profiles: Record<string, DocumentValue<"profile">> = {};
  for (const entry of await readdir(
    join(project.configDirectory, "profiles"),
  )) {
    if (!entry.endsWith(".yaml")) continue;
    const profile = ProfileSchema.parse(
      await parseYamlFile(join(project.configDirectory, "profiles", entry)),
    );
    profiles[profile.id] = profile;
  }
  const guidelines: Record<string, string> = {};
  for (const entry of await readdir(
    join(project.configDirectory, "guidelines"),
  )) {
    if (!entry.endsWith(".md")) continue;
    guidelines[entry.slice(0, -3)] = await readFile(
      join(project.configDirectory, "guidelines", entry),
      "utf8",
    );
  }
  return { ...settings, profiles, guidelines };
}

export async function validateProjectConfiguration(
  project: ProjectLocation,
): Promise<ConfigurationIssue[]> {
  const issues: ConfigurationIssue[] = [];
  const configPath = join(project.configDirectory, "config.yaml");
  let config: DocumentValue<"projectConfig">;
  try {
    config = ProjectConfigSchema.parse(await parseYamlFile(configPath));
  } catch (error) {
    return [
      {
        path: configPath,
        message:
          error instanceof Error
            ? error.message
            : "invalid project configuration",
      },
    ];
  }

  const workflowsDirectory = join(project.configDirectory, "workflows");
  const workflowPath = join(
    workflowsDirectory,
    `${config.defaultWorkflow}.yaml`,
  );
  let workflow: DocumentValue<"workflow">;
  try {
    workflow = WorkflowSchema.parse(await parseYamlFile(workflowPath));
  } catch (error) {
    return [
      {
        path: workflowPath,
        message: error instanceof Error ? error.message : "invalid workflow",
      },
    ];
  }

  const profiles = new Map<string, DocumentValue<"profile">>();
  const profilesDirectory = join(project.configDirectory, "profiles");
  try {
    for (const entry of await readdir(profilesDirectory)) {
      if (!entry.endsWith(".yaml")) continue;
      const path = join(profilesDirectory, entry);
      try {
        const profile = ProfileSchema.parse(await parseYamlFile(path));
        if (profiles.has(profile.id))
          issues.push({ path, message: `duplicate profile ${profile.id}` });
        profiles.set(profile.id, profile);
      } catch (error) {
        issues.push({
          path,
          message: error instanceof Error ? error.message : "invalid profile",
        });
      }
    }
  } catch (error) {
    issues.push({
      path: profilesDirectory,
      message:
        error instanceof Error
          ? error.message
          : "profiles directory is missing",
    });
  }

  const guidelineIds = new Set<string>();
  const guidelinesDirectory = join(project.configDirectory, "guidelines");
  try {
    for (const entry of await readdir(guidelinesDirectory)) {
      if (!entry.endsWith(".md")) continue;
      const id = entry.slice(0, -".md".length);
      const path = join(guidelinesDirectory, entry);
      try {
        guidelineIds.add(
          GuidelineSchema.parse({
            schemaVersion: 1,
            id,
            title: id,
            content: await readFile(path, "utf8"),
          }).id,
        );
      } catch (error) {
        issues.push({
          path,
          message: error instanceof Error ? error.message : "invalid guideline",
        });
      }
    }
  } catch (error) {
    issues.push({
      path: guidelinesDirectory,
      message:
        error instanceof Error
          ? error.message
          : "guidelines directory is missing",
    });
  }

  const policiesDirectory = join(project.configDirectory, "policies");
  try {
    for (const entry of await readdir(policiesDirectory)) {
      if (!entry.endsWith(".yaml")) continue;
      const path = join(policiesDirectory, entry);
      try {
        PolicySchema.parse(await parseYamlFile(path));
      } catch (error) {
        issues.push({
          path,
          message: error instanceof Error ? error.message : "invalid policy",
        });
      }
    }
  } catch (error) {
    issues.push({
      path: policiesDirectory,
      message:
        error instanceof Error
          ? error.message
          : "policies directory is missing",
    });
  }

  for (const phase of workflow.phases) {
    const profile = profiles.get(phase.profile);
    if (!profile) {
      issues.push({
        path: workflowPath,
        message: `phase ${phase.id} references missing profile ${phase.profile}`,
      });
    } else {
      for (const capability of phase.requiredCapabilities) {
        if (!profile.capabilities.includes(capability)) {
          issues.push({
            path: workflowPath,
            message: `phase ${phase.id} requires unavailable ${capability} capability from ${phase.profile}`,
          });
        }
      }
    }
    for (const guideline of phase.guidelines) {
      if (!guidelineIds.has(guideline)) {
        issues.push({
          path: workflowPath,
          message: `phase ${phase.id} references missing guideline ${guideline}`,
        });
      }
    }
    for (const unit of phase.work) {
      if (unit.profile && !profiles.has(unit.profile)) {
        issues.push({
          path: workflowPath,
          message: `work ${unit.id} references missing profile ${unit.profile}`,
        });
      }
    }
    for (const check of phase.checks) {
      if (check.profile && !profiles.has(check.profile)) {
        issues.push({
          path: workflowPath,
          message: `check ${check.id} references missing profile ${check.profile}`,
        });
      }
    }
  }
  return issues;
}
