import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import satisfies from "semver/functions/satisfies.js";
import valid from "semver/functions/valid.js";
import validRange from "semver/ranges/valid.js";
import {
  ProductBuildSchema,
  ProductMetadataSchema,
  type DocumentValue,
  CURRENT_SCHEMA_VERSION,
} from "./schemas.js";

export type ProductMetadata = DocumentValue<"productMetadata">;

/** Written into the assembled package; read back relative to the product. */
export const PRODUCT_METADATA_FILE = "product.json";

export type CompatibilityStatus = "compatible" | "incompatible" | "unknown";

export interface CompatibilityFinding {
  id:
    | "client-range"
    | "api-protocol"
    | "state-schema"
    | "pi-extension"
    | "node-version";
  status: CompatibilityStatus;
  detail: string;
  remediation?: string;
}

export interface CompatibilityReport {
  /** True only when no finding is incompatible. Unknown never blocks reads. */
  compatible: boolean;
  /** Mutations require every checked dimension to be positively compatible. */
  mutationAllowed: boolean;
  findings: CompatibilityFinding[];
}

export interface CompatibilityQuery {
  /** The client asking; usually the installed CLI. */
  clientVersion?: string;
  clientApiProtocolVersion?: number;
  /** The state the client intends to read or write. */
  stateSchemaVersion?: number;
  piExtensionVersion?: string;
  nodeVersion?: string;
}

function rangeFinding(
  id: CompatibilityFinding["id"],
  version: string | undefined,
  range: string,
  subject: string,
  remediation: string,
): CompatibilityFinding {
  if (version === undefined)
    return {
      id,
      status: "unknown",
      detail: `${subject} version was not reported`,
    };
  if (!validRange(range))
    return {
      id,
      status: "incompatible",
      detail: `${subject} range ${range} is not a valid semver range`,
      remediation,
    };
  // Coerce a bare Node build string such as "v24.16.0" before comparison.
  const normalized = version.startsWith("v") ? version.slice(1) : version;
  if (!valid(normalized))
    return {
      id,
      status: "incompatible",
      detail: `${subject} version ${version} is not valid semver`,
      remediation,
    };
  return satisfies(normalized, range, { includePrerelease: true })
    ? {
        id,
        status: "compatible",
        detail: `${subject} ${version} satisfies ${range}`,
      }
    : {
        id,
        status: "incompatible",
        detail: `${subject} ${version} does not satisfy ${range}`,
        remediation,
      };
}

function exactFinding(
  id: CompatibilityFinding["id"],
  actual: number | undefined,
  expected: number,
  subject: string,
  remediation: string,
): CompatibilityFinding {
  if (actual === undefined)
    return {
      id,
      status: "unknown",
      detail: `${subject} was not reported`,
    };
  if (actual === expected)
    return {
      id,
      status: "compatible",
      detail: `${subject} ${actual} matches`,
    };
  return {
    id,
    status: "incompatible",
    detail:
      actual > expected
        ? `${subject} ${actual} is newer than the supported ${expected}`
        : `${subject} ${actual} is older than the required ${expected}`,
    remediation,
  };
}

/**
 * Evaluates a client against a product's declared compatibility. Reads may
 * proceed on `unknown`, but mutations require every dimension to be positively
 * compatible so an unreported version can never be assumed safe.
 */
export function evaluateCompatibility(
  compatibility: ProductMetadata["compatibility"],
  query: CompatibilityQuery,
): CompatibilityReport {
  const findings: CompatibilityFinding[] = [
    rangeFinding(
      "client-range",
      query.clientVersion,
      compatibility.compatibleClientRange,
      "Client",
      "Upgrade the SWF CLI or restart the service on a matching version.",
    ),
    exactFinding(
      "api-protocol",
      query.clientApiProtocolVersion,
      compatibility.apiProtocolVersion,
      "API protocol version",
      "Restart the service so the CLI and service share one API protocol.",
    ),
    exactFinding(
      "state-schema",
      query.stateSchemaVersion,
      compatibility.stateSchemaVersion,
      "State schema version",
      "Preview and apply the required state migration before mutating.",
    ),
  ];
  if (query.piExtensionVersion !== undefined)
    findings.push(
      rangeFinding(
        "pi-extension",
        query.piExtensionVersion,
        compatibility.piExtensionRange,
        "Pi extension",
        "Install the Pi extension version matching this SWF release.",
      ),
    );
  if (query.nodeVersion !== undefined)
    findings.push(
      rangeFinding(
        "node-version",
        query.nodeVersion,
        `>=${compatibility.minimumNodeVersion}`,
        "Node",
        `Install Node >=${compatibility.minimumNodeVersion}.`,
      ),
    );
  const incompatible = findings.some(({ status }) => status === "incompatible");
  return {
    compatible: !incompatible,
    mutationAllowed: findings.every(({ status }) => status === "compatible"),
    findings,
  };
}

/** A downgraded writer must never operate on state it cannot represent. */
export function refusesWriterStartup(
  compatibility: ProductMetadata["compatibility"],
  observedStateSchemaVersion: number,
): boolean {
  return observedStateSchemaVersion > compatibility.stateSchemaVersion;
}

export function parseProductMetadata(value: unknown): ProductMetadata {
  return ProductMetadataSchema.parse(value);
}

/**
 * Resolves packaged metadata relative to this module rather than the current
 * working directory, so an installed product reports correctly from any cwd.
 */
export async function readProductMetadata(
  fromDirectory = dirname(fileURLToPath(import.meta.url)),
): Promise<ProductMetadata> {
  const contents = await readFile(
    join(fromDirectory, PRODUCT_METADATA_FILE),
    "utf8",
  );
  return parseProductMetadata(JSON.parse(contents));
}

export interface BuildMetadataInput {
  productVersion: string;
  sourceCommit: string;
  sourceDirty: boolean;
  channel: DocumentValue<"productMetadata">["build"]["channel"];
  builtAt?: string;
}

/**
 * Builds immutable metadata for an assembled artifact. A dirty tree or a
 * development channel yields a non-publishable build, so release promotion can
 * refuse it without re-deriving the reason. Stable releases additionally
 * require a release-shaped version.
 */
export function createBuildMetadata(
  input: BuildMetadataInput,
): ProductMetadata["build"] {
  const version = input.productVersion.replace(/^v/, "");
  const prerelease = version.includes("-");
  const publishable =
    !input.sourceDirty &&
    input.channel !== "development" &&
    Boolean(valid(version)) &&
    (input.channel === "next" ? prerelease : !prerelease);
  return ProductBuildSchema.parse({
    productVersion: version,
    sourceCommit: input.sourceCommit,
    sourceDirty: input.sourceDirty,
    builtAt: input.builtAt ?? new Date().toISOString(),
    channel: input.channel,
    publishable,
  });
}

/** Composes a complete metadata document for release assembly or preview. */
export function createProductMetadata(
  input: BuildMetadataInput,
  compatibility: ProductMetadata["compatibility"] = PRODUCT_COMPATIBILITY,
): ProductMetadata {
  return ProductMetadataSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    build: createBuildMetadata(input),
    compatibility,
  });
}

export interface SourceIdentity {
  sourceCommit: string;
  sourceDirty: boolean;
}

/**
 * Derives build metadata from a repository checkout. Kept separate from
 * `createBuildMetadata` so assembly can inject an identity from CI without a
 * working tree, and so this module does not depend on a Git client type.
 */
export function buildMetadataFromSource(
  source: SourceIdentity,
  productVersion: string,
  channel: ProductMetadata["build"]["channel"],
  builtAt?: string,
): ProductMetadata["build"] {
  return createBuildMetadata({
    productVersion,
    sourceCommit: source.sourceCommit,
    sourceDirty: source.sourceDirty,
    channel,
    builtAt,
  });
}

/**
 * A stable release must be traceable to an exact clean commit. Preview and
 * development builds may proceed from a dirty tree but are never publishable.
 */
export function assertPublishable(build: ProductMetadata["build"]): void {
  if (build.publishable) return;
  const reasons = [
    build.sourceDirty ? "the working tree is dirty" : undefined,
    build.channel === "development"
      ? "the build channel is development"
      : undefined,
    !valid(build.productVersion)
      ? `version ${build.productVersion} is not valid semver`
      : undefined,
    build.channel === "next" && !build.productVersion.includes("-")
      ? "a next-channel build requires a prerelease version"
      : undefined,
    build.channel === "stable" && build.productVersion.includes("-")
      ? "a stable build must not use a prerelease version"
      : undefined,
  ].filter(Boolean);
  throw new Error(
    `Build ${build.productVersion} (${build.sourceCommit}) is not publishable: ${reasons.join("; ")}`,
  );
}

/** Used when running from a source checkout, where no build was assembled. */
export function developmentProductMetadata(
  overrides: Partial<ProductMetadata["build"]> = {},
): ProductMetadata {
  return ProductMetadataSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    build: {
      productVersion: "0.0.0",
      sourceCommit: "unknown",
      sourceDirty: true,
      builtAt: new Date(0).toISOString(),
      channel: "development",
      publishable: false,
      ...overrides,
    },
    compatibility: PRODUCT_COMPATIBILITY,
  });
}

/**
 * The compatibility contract this source tree implements. Release assembly
 * copies these values into the packaged metadata.
 */
export const PRODUCT_COMPATIBILITY: ProductMetadata["compatibility"] = {
  apiProtocolVersion: 1,
  stateSchemaVersion: CURRENT_SCHEMA_VERSION,
  compatibleClientRange: ">=0.1.0 <0.2.0",
  piExtensionRange: ">=0.1.0 <0.2.0",
  minimumNodeVersion: "24.0.0",
};
