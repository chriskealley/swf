import {
  findProjectRoot,
  readProjectConfig,
  type OperatorAction,
  type OperatorAttention,
  type OperatorProjection,
  type SwfServiceClient,
} from "@swf/core";

export class AmbiguousOperatorContextError extends Error {
  constructor(
    message: string,
    readonly alternatives: Array<Record<string, string | undefined>>,
  ) {
    super(message);
    this.name = "AmbiguousOperatorContextError";
  }
}

export interface OperatorContext {
  projectId: string;
  runId: string;
  changeName: string;
  projection: OperatorProjection;
  root?: string;
}

export async function resolveOperatorContext(input: {
  client: SwfServiceClient;
  cwd?: string;
  projectId?: string;
  runId?: string;
  changeName?: string;
}): Promise<OperatorContext> {
  let projectId = input.projectId;
  let root: string | undefined;
  if (!projectId) {
    const project = await findProjectRoot(input.cwd ?? process.cwd());
    if (!project?.initialized)
      throw new Error(
        "No initialized SWF project was found. Run from the project or pass --project.",
      );
    projectId = (await readProjectConfig(project)).projectId;
    root = project.root;
  }
  let runId = input.runId;
  if (!runId) {
    if (!input.changeName)
      throw new Error("A change name or explicit --run selector is required");
    const runs = await input.client.query<
      Array<{ runId: string; changeName: string; updatedAt?: string }>
    >("runs", { projectId });
    const matching = runs.filter(
      ({ changeName }) => changeName === input.changeName,
    );
    if (!matching.length)
      throw new Error(`No run is bound to ${input.changeName}`);
    if (matching.length > 1)
      throw new AmbiguousOperatorContextError(
        `More than one run is bound to ${input.changeName}; pass --run.`,
        matching.map(({ runId, changeName }) => ({ runId, changeName })),
      );
    runId = matching[0]!.runId;
  }
  const projection = await input.client.query<OperatorProjection>(
    "operator-projection",
    { projectId, runId },
  );
  if (input.changeName && projection.changeName !== input.changeName)
    throw new Error(
      `Run ${runId} belongs to ${projection.changeName}, not ${input.changeName}`,
    );
  return {
    projectId,
    runId,
    changeName: projection.changeName,
    projection,
    root,
  };
}

export function resolveUniqueAction(
  projection: OperatorProjection,
  types: OperatorAction["type"][],
): OperatorAction {
  const matches = projection.allowedActions.filter(({ type }) =>
    types.includes(type),
  );
  if (matches.length === 1) return matches[0]!;
  if (!matches.length)
    throw new AmbiguousOperatorContextError(
      `No current attention item permits ${types.join(" or ")}.`,
      projection.attention.map(attentionAlternative),
    );
  throw new AmbiguousOperatorContextError(
    `More than one current attention item permits ${types.join(" or ")}; use the explicit selector shown below.`,
    matches.map(({ type, parameters }) => ({
      action: type,
      phaseId: parameters.phaseId,
      gateId: parameters.gateId,
      invocationId: parameters.invocationId,
    })),
  );
}

function attentionAlternative(
  attention: OperatorAttention,
): Record<string, string | undefined> {
  return {
    attention: attention.type,
    phaseId: attention.phaseId,
    gateId: attention.gateId,
    invocationId: attention.invocationId,
  };
}
