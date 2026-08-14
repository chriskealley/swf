import { randomUUID } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

export interface RedactionOptions {
  sensitiveValues?: string[];
  patterns?: Array<string | RegExp>;
  replacement?: string;
}

const secretKey =
  /^(?:password|passwd|secret|credential|authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|thinking[-_]?signature|signature|encrypted[-_]?content)$/i;
const defaultPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|token)\s*[=:]\s*[^\s,;]+/gi,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Redactor {
  readonly replacement: string;
  private readonly patterns: RegExp[];

  constructor(options: RedactionOptions = {}) {
    this.replacement = options.replacement ?? "[REDACTED]";
    this.patterns = [
      ...defaultPatterns,
      ...(options.sensitiveValues ?? [])
        .filter(Boolean)
        .map((value) => new RegExp(escapeRegExp(value), "g")),
      ...(options.patterns ?? []).map((pattern) =>
        typeof pattern === "string" ? new RegExp(pattern, "gi") : pattern,
      ),
    ];
  }

  text(value: string): string {
    return this.patterns.reduce(
      (result, pattern) => result.replace(pattern, this.replacement),
      value,
    );
  }

  value<T>(value: T): T {
    return this.walk(value, new WeakSet()) as T;
  }

  private walk(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return this.text(value);
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const result = Array.isArray(value)
      ? value.map((entry) => this.walk(entry, seen))
      : Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            secretKey.test(key) ? this.replacement : this.walk(entry, seen),
          ]),
        );
    seen.delete(value);
    return result;
  }
}

export interface AuditRecord {
  schemaVersion: 1;
  auditId: string;
  timestamp: string;
  operation: string;
  actor: { type: string; id: string };
  projectId?: string;
  runId?: string;
  outcome: "accepted" | "rejected" | "completed" | "failed";
  details: Record<string, unknown>;
}

export class AuditLog {
  constructor(
    readonly path: string,
    readonly redactor = new Redactor(),
  ) {}

  async append(
    input: Omit<AuditRecord, "schemaVersion" | "auditId" | "timestamp">,
  ): Promise<AuditRecord> {
    const record = this.redactor.value<AuditRecord>({
      schemaVersion: 1,
      auditId: randomUUID(),
      timestamp: new Date().toISOString(),
      ...input,
    });
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await chmod(this.path, 0o600);
    } finally {
      await handle.close();
    }
    return record;
  }
}

export async function enforcePrivatePermissions(input: {
  directories?: string[];
  files?: string[];
}): Promise<void> {
  for (const directory of input.directories ?? []) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  for (const file of input.files ?? []) await chmod(file, 0o600);
}

export function assertLoopbackHttpEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "::1"].includes(hostname)
  )
    throw new Error("SWF service endpoint must use loopback HTTP");
  return url;
}
