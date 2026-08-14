export interface ProgressEvent {
  id: number;
  type: string;
  projectId?: string;
  runId?: string;
  data: Record<string, unknown>;
}

const milestonePatterns = [
  /^run\./,
  /^phase\./,
  /^work-unit\./,
  /^harness\./,
  /^agent\./,
  /^attempt\./,
  /^check\./,
  /^gate\./,
  /^checkpoint\./,
  /^delivery\./,
];

export function progressMilestone(event: ProgressEvent): string | undefined {
  if (!milestonePatterns.some((pattern) => pattern.test(event.type)))
    return undefined;
  const durable =
    event.data.event && typeof event.data.event === "object"
      ? (event.data.event as {
          context?: { phaseId?: unknown };
          data?: { phaseId?: unknown };
        })
      : undefined;
  const phaseId =
    typeof event.data.phaseId === "string"
      ? event.data.phaseId
      : typeof durable?.context?.phaseId === "string"
        ? durable.context.phaseId
        : typeof durable?.data?.phaseId === "string"
          ? durable.data.phaseId
          : undefined;
  const phase = phaseId ? ` ${phaseId}` : "";
  if (event.type === "harness.progress") {
    const normalizedType =
      durable &&
      "type" in durable &&
      typeof (durable as { type?: unknown }).type === "string"
        ? (durable as { type: string }).type
        : undefined;
    const harness =
      durable &&
      "harness" in durable &&
      typeof (durable as { harness?: unknown }).harness === "string"
        ? ` ${(durable as { harness: string }).harness}`
        : "";
    if (normalizedType) return `harness.${normalizedType}${phase}${harness}`;
  }
  return `${event.type}${phase}`;
}

export class OrderedProgressSubscriber {
  lastEventId = 0;
  readonly milestones: string[] = [];

  constructor(
    private readonly emit: (line: string) => void,
    private readonly filter: { projectId?: string; runId?: string } = {},
  ) {}

  accept(event: ProgressEvent): void {
    if (event.id <= this.lastEventId) return;
    this.lastEventId = event.id;
    if (this.filter.projectId && event.projectId !== this.filter.projectId)
      return;
    if (this.filter.runId && event.runId !== this.filter.runId) return;
    const milestone = progressMilestone(event);
    if (!milestone || this.milestones.at(-1) === milestone) return;
    this.milestones.push(milestone);
    this.emit(milestone);
  }

  async follow(
    connect: (after: number) => AsyncIterable<ProgressEvent>,
    options: { attempts?: number } = {},
  ): Promise<{ connected: boolean; lastEventId: number }> {
    const attempts = options.attempts ?? 3;
    let connected = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        for await (const event of connect(this.lastEventId)) {
          connected = true;
          this.accept(event);
        }
        break;
      } catch {
        if (attempt === attempts - 1) break;
      }
    }
    return { connected, lastEventId: this.lastEventId };
  }
}

export function renderProgressLine(line: string, tty: boolean): string {
  return tty ? `… ${line}` : line;
}
