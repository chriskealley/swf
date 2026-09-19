export type ReleaseChannel = "stable" | "next";

export interface ChannelPolicy {
  channel: ReleaseChannel;
  /** npm dist-tag. Publishing without this makes a prerelease the default. */
  registryTag: string;
  /** Git tag format, `v`-prefixed by GitHub convention. */
  tagFormat: string;
  githubPrerelease: boolean;
  requiresProvenance: boolean;
  requiresAuthorization: boolean;
}

export const CHANNEL_POLICIES: Record<ReleaseChannel, ChannelPolicy> = {
  stable: {
    channel: "stable",
    registryTag: "latest",
    tagFormat: "v<version>",
    githubPrerelease: false,
    requiresProvenance: true,
    requiresAuthorization: true,
  },
  next: {
    channel: "next",
    registryTag: "next",
    tagFormat: "v<version>",
    githubPrerelease: true,
    requiresProvenance: true,
    requiresAuthorization: false,
  },
};

export interface VersionPolicyResult {
  valid: boolean;
  prerelease: boolean;
  preOneZero: boolean;
  reasons: string[];
  notes: string[];
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-.]+))?$/;

/**
 * Validates a version against its channel.
 *
 * Pre-1.0 releases are expected: under SemVer a `0.y.z` minor may introduce
 * breaking changes, which is the contract this product ships under until it
 * commits to `1.0.0`.
 */
export function evaluateVersionPolicy(
  version: string,
  channel: ReleaseChannel,
): VersionPolicyResult {
  const reasons: string[] = [];
  const notes: string[] = [];
  const normalized = version.startsWith("v") ? version.slice(1) : version;
  const match = SEMVER.exec(normalized);

  if (!match) {
    return {
      valid: false,
      prerelease: false,
      preOneZero: false,
      reasons: [`${version} is not a valid SemVer version`],
      notes,
    };
  }

  const major = Number(match[1]);
  const prerelease = match[4] !== undefined;
  const preOneZero = major === 0;

  if (channel === "stable" && prerelease)
    reasons.push(
      `a stable release must not use a prerelease version (${normalized})`,
    );
  if (channel === "next" && !prerelease)
    reasons.push(
      `a next release requires a prerelease version such as ${normalized}-next.1`,
    );
  if (channel === "next" && prerelease && !/^next\./.test(match[4] ?? ""))
    notes.push(
      `prerelease identifier "${match[4]}" does not use the next.<n> convention`,
    );
  if (preOneZero)
    notes.push(
      "pre-1.0: a minor increment may introduce breaking changes; release notes must say so",
    );

  return {
    valid: reasons.length === 0,
    prerelease,
    preOneZero,
    reasons,
    notes,
  };
}

export interface PublishStep {
  order: number;
  id: string;
  description: string;
  command: string;
  /** True when the effect cannot be undone. */
  irreversible: boolean;
}

/**
 * The publication order.
 *
 * A registry version can never be republished, while a Git tag can be deleted
 * and re-cut. Publishing first therefore means a failed publish never leaves a
 * tag pointing at a version that does not exist. The registry tag is always
 * explicit so a prerelease cannot silently become the default install.
 */
export function publicationPlan(
  version: string,
  channel: ReleaseChannel,
): PublishStep[] {
  const policy = CHANNEL_POLICIES[channel];
  const tag = policy.tagFormat.replace("<version>", version);
  return [
    {
      order: 1,
      id: "verify",
      description:
        "Verify the exact artifact: contents, packed tarball, clean-install smoke, and evidence.",
      command: `pnpm verify:release --channel=${channel}`,
      irreversible: false,
    },
    {
      order: 2,
      id: "publish-product",
      description: `Publish the product to the ${policy.registryTag} registry tag.`,
      command: `npm publish --tag ${policy.registryTag} --provenance`,
      irreversible: true,
    },
    {
      order: 3,
      id: "publish-extension",
      description: `Publish the Pi extension to the ${policy.registryTag} registry tag.`,
      command: `npm publish --tag ${policy.registryTag} --provenance`,
      irreversible: true,
    },
    {
      order: 4,
      id: "tag",
      description:
        "Create the immutable Git tag only after both packages are published.",
      command: `git tag ${tag} && git push origin ${tag}`,
      irreversible: false,
    },
    {
      order: 5,
      id: "github-release",
      description: `Create the GitHub ${policy.githubPrerelease ? "prerelease" : "release"} with archives, checksums, SBOM, and notes.`,
      command: `gh release create ${tag} ${policy.githubPrerelease ? "--prerelease " : ""}--notes-file release-notes.md`,
      irreversible: false,
    },
  ];
}

export interface PublicationGuard {
  allowed: boolean;
  reasons: string[];
}

const SECRET_REFERENCE = /\$\{\{\s*secrets\./;
const PUBLISH_COMMAND = /npm\s+publish|gh\s+release\s+create/;

/**
 * Ways a long-lived npm publication credential reaches a workflow: a secret
 * whose name reads as an npm token, the variable npm reads it from, and the
 * `.npmrc` entry that `setup-node`'s `registry-url` generates. Any of them
 * suppresses trusted publishing, because npm only mints a short-lived identity
 * when no credential is already configured for the registry.
 */
const LONG_LIVED_NPM_CREDENTIALS: ReadonlyArray<
  readonly [name: string, pattern: RegExp]
> = [
  [
    "an npm publication secret",
    /\$\{\{\s*secrets\.[A-Za-z0-9_]*NPM[A-Za-z0-9_]*TOKEN/,
  ],
  ["a NODE_AUTH_TOKEN assignment", /^\s*NODE_AUTH_TOKEN\s*:/m],
  ["an .npmrc _authToken entry", /_authToken\s*=/],
  [
    "a setup-node registry-url, which generates an .npmrc auth entry",
    /^\s*registry-url\s*:/m,
  ],
];

/** The first npm release able to publish through a trusted publisher. */
const TRUSTED_PUBLISHING_NPM_BASELINE = [11, 5, 1] as const;

/**
 * The lowest npm version a `npm@<spec>` range can resolve to, or undefined for
 * a spec with no floor (`latest`, a tag, a URL). A floor is required rather
 * than inferred: `latest` happens to satisfy the baseline today, but it states
 * no minimum, so it cannot be audited.
 */
function npmSpecFloor(spec: string): [number, number, number] | undefined {
  const match = /^(?:\^|~|>=|>)?v?(\d+)\.(\d+)\.(\d+)/.exec(spec.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function meetsBaseline(floor: readonly [number, number, number]): boolean {
  for (const [index, required] of TRUSTED_PUBLISHING_NPM_BASELINE.entries()) {
    const actual = floor[index] ?? 0;
    if (actual !== required) return actual > required;
  }
  return true;
}

/**
 * Statically verifies the release workflow's trust boundary and irreversible
 * operation order. The checks intentionally inspect the workflow source: they
 * run on untrusted pull requests before GitHub can expose release credentials.
 */
export function auditReleaseWorkflow(contents: string): string[] {
  const violations: string[] = [];
  const triggeredByPullRequest =
    /^\s*(?:pull_request|pull_request_target):/m.test(contents);
  const referencesSecret = SECRET_REFERENCE.test(contents);
  const publishes = PUBLISH_COMMAND.test(contents);
  const manuallyTriggered = /^\s*workflow_dispatch:/m.test(contents);
  const automaticallyTriggered =
    /^\s*(?:push|schedule|repository_dispatch|workflow_run):/m.test(contents);
  const tagTriggered = /^\s*tags:/m.test(contents);
  const usesEnvironment = /^\s*environment:/m.test(contents);
  const npmPublishOffsets = [...contents.matchAll(/npm\s+publish\b/g)].map(
    ({ index }) => index,
  );
  const gitTagOffset = contents.search(/\bgit\s+tag\b/);
  const githubReleaseOffset = contents.search(/\bgh\s+release\s+create\b/);

  if (triggeredByPullRequest && referencesSecret)
    violations.push(
      "a pull-request-triggered workflow references a secret; untrusted code must never reach publication credentials",
    );
  if (triggeredByPullRequest && publishes)
    violations.push("a pull-request-triggered workflow runs a publish command");
  if (publishes && !manuallyTriggered)
    violations.push("a publishing workflow is not explicitly dispatched");
  if (publishes && automaticallyTriggered)
    violations.push(
      "a publishing workflow has an automatic trigger; publication must be explicitly dispatched",
    );
  if (publishes && tagTriggered)
    violations.push(
      "a publishing workflow is triggered by a tag, so publication cannot happen before tagging",
    );
  if (publishes && !contents.includes('GITHUB_REF" != "refs/heads/main"'))
    violations.push("a publishing workflow does not restrict dispatch to main");
  if (publishes && !usesEnvironment)
    violations.push(
      "a publishing workflow does not use a protected environment",
    );
  if (publishes && !/id-token:\s*write/.test(contents))
    violations.push(
      "a publishing workflow does not request an OIDC token; provenance would be unavailable",
    );
  for (const [name, pattern] of LONG_LIVED_NPM_CREDENTIALS)
    if (publishes && pattern.test(contents))
      violations.push(
        `a publishing workflow references ${name}; registry publication must use short-lived trusted-publishing credentials`,
      );

  if (publishes) {
    const installedNpmSpecs = [
      ...contents.matchAll(
        /npm\s+(?:install|i)\s+(?:-g|--global)\s+npm@(\S+)/g,
      ),
    ].map(([, spec]) => (spec ?? "").replace(/^["']|["']$/g, ""));
    const floors = installedNpmSpecs
      .map(npmSpecFloor)
      .filter(
        (floor): floor is [number, number, number] => floor !== undefined,
      );
    if (floors.length === 0 || !floors.every(meetsBaseline))
      violations.push(
        `a publishing workflow does not install npm >=${TRUSTED_PUBLISHING_NPM_BASELINE.join(".")}, which trusted publishing requires`,
      );
  }

  if (publishes && npmPublishOffsets.length !== 2)
    violations.push(
      "a publishing workflow must publish exactly the product and Pi extension",
    );
  if (
    publishes &&
    npmPublishOffsets.some(
      (offset) =>
        !contents
          .slice(offset, contents.indexOf("\n", offset))
          .includes('"dist/release/$TARBALL"'),
    )
  )
    violations.push(
      "a publishing workflow does not publish the exact verified tarballs",
    );
  if (
    publishes &&
    (gitTagOffset < 0 ||
      npmPublishOffsets.some((offset) => offset > gitTagOffset))
  )
    violations.push(
      "a publishing workflow does not create the Git tag after both registry publications",
    );
  if (
    publishes &&
    (githubReleaseOffset < 0 || githubReleaseOffset < gitTagOffset)
  )
    violations.push(
      "a publishing workflow does not create the GitHub release after the Git tag",
    );

  return violations;
}

/**
 * Refuses publication that would violate the channel contract. Every check is
 * a hard failure rather than a warning: a mistake here is unrecoverable
 * because a published version can never be reused.
 */
export function guardPublication(input: {
  version: string;
  channel: ReleaseChannel;
  registryTag?: string;
  publishable: boolean;
  provenanceAvailable: boolean;
  authorized: boolean;
  trustedEnvironment: boolean;
  alreadyPublishedVersions?: string[];
}): PublicationGuard {
  const policy = CHANNEL_POLICIES[input.channel];
  const reasons: string[] = [];

  const versionPolicy = evaluateVersionPolicy(input.version, input.channel);
  reasons.push(...versionPolicy.reasons);

  if (!input.publishable)
    reasons.push("the artifact is not publishable; see release verification");
  if (!input.trustedEnvironment)
    reasons.push(
      "publication credentials are unavailable outside a trusted environment",
    );
  if (policy.requiresProvenance && !input.provenanceAvailable)
    reasons.push("registry provenance is required but unavailable");
  if (policy.requiresAuthorization && !input.authorized)
    reasons.push("a stable release requires explicit release authorization");

  const requestedTag = input.registryTag ?? policy.registryTag;
  if (requestedTag !== policy.registryTag)
    reasons.push(
      `registry tag ${requestedTag} does not match the ${input.channel} channel tag ${policy.registryTag}`,
    );

  const normalized = input.version.replace(/^v/, "");
  if (input.alreadyPublishedVersions?.includes(normalized))
    reasons.push(
      `${normalized} is already published; a registry version can never be reused`,
    );

  return { allowed: reasons.length === 0, reasons };
}

export interface RollbackPlan {
  /** Published versions are immutable; recovery is always forward. */
  steps: string[];
  warnings: string[];
}

/**
 * Recovery for a failed or partial publication.
 *
 * Nothing here overwrites a published version, because npm forbids it and
 * because consumers may already have installed it. A broken release is
 * superseded, and its dist-tag is moved back so it stops being the default.
 */
export function rollbackPlan(input: {
  version: string;
  channel: ReleaseChannel;
  productPublished: boolean;
  extensionPublished: boolean;
  tagPushed: boolean;
  previousStableVersion?: string;
}): RollbackPlan {
  const policy = CHANNEL_POLICIES[input.channel];
  const steps: string[] = [];
  const warnings: string[] = [];

  if (input.productPublished !== input.extensionPublished) {
    warnings.push(
      "product and Pi extension are out of step; consumers may pair incompatible versions",
    );
    steps.push(
      input.productPublished
        ? "Publish the matching Pi extension version, or move the dist-tag back until it exists."
        : "Publish the matching product version, or remove the extension's dist-tag until it exists.",
    );
  }

  if (input.productPublished && input.previousStableVersion)
    steps.push(
      `npm dist-tag add @chriskealley/swf@${input.previousStableVersion} ${policy.registryTag}`,
    );

  if (input.tagPushed && !input.productPublished) {
    warnings.push(
      "a Git tag references a version that was never published; publish before tagging next time",
    );
    steps.push(`git push --delete origin v${input.version}`);
  }

  steps.push(
    `Release a superseding version; ${input.version} remains published and immutable.`,
  );
  if (input.productPublished)
    warnings.push(
      `${input.version} cannot be unpublished reliably and must not be reused`,
    );

  return { steps, warnings };
}
