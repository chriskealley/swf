import { describe, expect, it } from "vitest";
import {
  CHANNEL_POLICIES,
  auditReleaseWorkflow,
  createSbom,
  detectProvenanceContext,
  evaluateVersionPolicy,
  guardPublication,
  isTrustedReleaseEnvironment,
  publicationPlan,
  renderChecksumFile,
  rollbackPlan,
} from "../src/index.js";

const validReleaseWorkflow = `
on:
  workflow_dispatch:
jobs:
  publish:
    environment: release
    permissions:
      id-token: write
    steps:
      - run: if [ "$GITHUB_REF" != "refs/heads/main" ]; then exit 1; fi
      - run: npm publish "dist/release/$TARBALL" --tag latest
      - run: npm publish "dist/release/$TARBALL" --tag latest
      - run: git tag v0.2.0
      - run: gh release create v0.2.0
`;

const trustedInputs = {
  publishable: true,
  provenanceAvailable: true,
  authorized: true,
  trustedEnvironment: true,
};

describe("channel policy", () => {
  it("maps each channel to a distinct registry tag", () => {
    expect(CHANNEL_POLICIES.stable.registryTag).toBe("latest");
    expect(CHANNEL_POLICIES.next.registryTag).toBe("next");
    expect(CHANNEL_POLICIES.next.githubPrerelease).toBe(true);
  });

  it("requires explicit authorization only for stable", () => {
    expect(CHANNEL_POLICIES.stable.requiresAuthorization).toBe(true);
    expect(CHANNEL_POLICIES.next.requiresAuthorization).toBe(false);
  });
});

describe("version policy", () => {
  it("accepts a stable release version", () => {
    const result = evaluateVersionPolicy("0.2.0", "stable");
    expect(result.valid).toBe(true);
    expect(result.preOneZero).toBe(true);
    expect(result.notes.join(" ")).toContain("pre-1.0");
  });

  it("rejects a prerelease on the stable channel", () => {
    expect(evaluateVersionPolicy("0.3.0-next.1", "stable").valid).toBe(false);
  });

  it("requires a prerelease on the next channel", () => {
    expect(evaluateVersionPolicy("0.3.0", "next").valid).toBe(false);
    expect(evaluateVersionPolicy("0.3.0-next.1", "next").valid).toBe(true);
  });

  it("notes an unconventional prerelease identifier without rejecting it", () => {
    const result = evaluateVersionPolicy("0.3.0-beta.1", "next");
    expect(result.valid).toBe(true);
    expect(result.notes.join(" ")).toContain("next.<n>");
  });

  it("rejects a version that is not SemVer", () => {
    expect(evaluateVersionPolicy("release-two", "stable").valid).toBe(false);
  });

  it("accepts a v-prefixed tag name", () => {
    expect(evaluateVersionPolicy("v0.2.0", "stable").valid).toBe(true);
  });

  it("stops noting pre-1.0 once past 1.0.0", () => {
    const result = evaluateVersionPolicy("1.2.3", "stable");
    expect(result.preOneZero).toBe(false);
    expect(result.notes.join(" ")).not.toContain("pre-1.0");
  });
});

describe("publication order", () => {
  it("publishes before tagging so a failed publish leaves no dangling tag", () => {
    const steps = publicationPlan("0.2.0", "stable").map(({ id }) => id);
    expect(steps.indexOf("publish-product")).toBeLessThan(steps.indexOf("tag"));
    expect(steps.indexOf("verify")).toBe(0);
  });

  it("marks only registry publication irreversible", () => {
    const plan = publicationPlan("0.2.0", "stable");
    expect(
      plan.filter(({ irreversible }) => irreversible).map(({ id }) => id),
    ).toEqual(["publish-product", "publish-extension"]);
  });

  it("always passes an explicit registry tag", () => {
    for (const channel of ["stable", "next"] as const)
      for (const item of publicationPlan("0.2.0", channel))
        if (item.command.includes("npm publish"))
          expect(item.command).toContain(
            `--tag ${CHANNEL_POLICIES[channel].registryTag}`,
          );
  });

  it("marks a next release as a GitHub prerelease", () => {
    expect(
      publicationPlan("0.3.0-next.1", "next").find(
        ({ id }) => id === "github-release",
      )?.command,
    ).toContain("--prerelease");
  });

  it("accepts only an explicitly dispatched publish-before-tag workflow", () => {
    expect(auditReleaseWorkflow(validReleaseWorkflow)).toEqual([]);
  });

  it("rejects tag-triggered publication", () => {
    const workflow = validReleaseWorkflow.replace(
      "workflow_dispatch:",
      'push:\n    tags: ["v*"]',
    );
    expect(auditReleaseWorkflow(workflow).join(" ")).toContain(
      "cannot happen before tagging",
    );
  });

  it("rejects tagging before both package publications", () => {
    const workflow = validReleaseWorkflow
      .replace("      - run: git tag v0.2.0\n", "")
      .replace(
        '      - run: npm publish "dist/release/$TARBALL" --tag latest\n',
        '      - run: git tag v0.2.0\n      - run: npm publish "dist/release/$TARBALL" --tag latest\n',
      );
    expect(auditReleaseWorkflow(workflow).join(" ")).toContain(
      "after both registry publications",
    );
  });

  it("rejects repacking a directory during publication", () => {
    const workflow = validReleaseWorkflow.replace(
      'npm publish "dist/release/$TARBALL"',
      "npm publish dist/product",
    );
    expect(auditReleaseWorkflow(workflow).join(" ")).toContain(
      "exact verified tarballs",
    );
  });
});

describe("publication guard", () => {
  it("allows a correct stable release", () => {
    expect(
      guardPublication({
        version: "0.2.0",
        channel: "stable",
        ...trustedInputs,
      }).allowed,
    ).toBe(true);
  });

  it("refuses a non-publishable artifact", () => {
    const guard = guardPublication({
      version: "0.2.0",
      channel: "stable",
      ...trustedInputs,
      publishable: false,
    });
    expect(guard.allowed).toBe(false);
    expect(guard.reasons.join(" ")).toContain("not publishable");
  });

  it("refuses outside a trusted environment", () => {
    expect(
      guardPublication({
        version: "0.2.0",
        channel: "stable",
        ...trustedInputs,
        trustedEnvironment: false,
      }).reasons.join(" "),
    ).toContain("trusted environment");
  });

  it("refuses a stable release without provenance or authorization", () => {
    expect(
      guardPublication({
        version: "0.2.0",
        channel: "stable",
        ...trustedInputs,
        provenanceAvailable: false,
      }).allowed,
    ).toBe(false);
    expect(
      guardPublication({
        version: "0.2.0",
        channel: "stable",
        ...trustedInputs,
        authorized: false,
      }).allowed,
    ).toBe(false);
  });

  it("refuses a prerelease published to the latest tag", () => {
    const guard = guardPublication({
      version: "0.3.0-next.1",
      channel: "next",
      registryTag: "latest",
      ...trustedInputs,
    });
    expect(guard.allowed).toBe(false);
    expect(guard.reasons.join(" ")).toContain("does not match");
  });

  it("refuses to reuse an already published version", () => {
    expect(
      guardPublication({
        version: "0.2.0",
        channel: "stable",
        ...trustedInputs,
        alreadyPublishedVersions: ["0.1.0", "0.2.0"],
      }).reasons.join(" "),
    ).toContain("can never be reused");
  });
});

describe("rollback", () => {
  it("never proposes overwriting a published version", () => {
    const plan = rollbackPlan({
      version: "0.2.0",
      channel: "stable",
      productPublished: true,
      extensionPublished: true,
      tagPushed: true,
    });
    expect(plan.steps.join(" ")).toContain("superseding version");
    expect(plan.steps.join(" ")).not.toContain("npm unpublish");
    expect(plan.warnings.join(" ")).toContain("must not be reused");
  });

  it("warns when product and extension are out of step", () => {
    const plan = rollbackPlan({
      version: "0.2.0",
      channel: "stable",
      productPublished: true,
      extensionPublished: false,
      tagPushed: false,
    });
    expect(plan.warnings.join(" ")).toContain("out of step");
  });

  it("moves the dist-tag back to the previous stable version", () => {
    const plan = rollbackPlan({
      version: "0.2.0",
      channel: "stable",
      productPublished: true,
      extensionPublished: true,
      tagPushed: false,
      previousStableVersion: "0.1.9",
    });
    expect(plan.steps.join(" ")).toContain("dist-tag add");
    expect(plan.steps.join(" ")).toContain("0.1.9");
  });

  it("deletes a tag that references an unpublished version", () => {
    const plan = rollbackPlan({
      version: "0.2.0",
      channel: "stable",
      productPublished: false,
      extensionPublished: false,
      tagPushed: true,
    });
    expect(plan.steps.join(" ")).toContain("push --delete");
    expect(plan.warnings.join(" ")).toContain("never published");
  });
});

describe("supply chain context", () => {
  it("reports provenance unavailable outside GitHub Actions", () => {
    expect(detectProvenanceContext({}).available).toBe(false);
  });

  it("requires an OIDC token request for provenance", () => {
    const context = detectProvenanceContext({ GITHUB_ACTIONS: "true" });
    expect(context.available).toBe(false);
    expect(context.reason).toContain("id-token: write");
  });

  it("reports provenance available with an OIDC token request", () => {
    expect(
      detectProvenanceContext({
        GITHUB_ACTIONS: "true",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid",
      }).available,
    ).toBe(true);
  });

  it("never trusts a pull-request workflow", () => {
    expect(
      isTrustedReleaseEnvironment({
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_PROTECTED: "true",
      }).trusted,
    ).toBe(false);
  });

  it("only trusts a manually dispatched protected main-branch run", () => {
    expect(
      isTrustedReleaseEnvironment({
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_PROTECTED: "true",
      }).trusted,
    ).toBe(false);
    expect(
      isTrustedReleaseEnvironment({
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/release-candidate",
        GITHUB_REF_PROTECTED: "true",
      }).trusted,
    ).toBe(false);
    expect(
      isTrustedReleaseEnvironment({
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_PROTECTED: "false",
      }).trusted,
    ).toBe(false);
    expect(
      isTrustedReleaseEnvironment({
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_PROTECTED: "true",
      }).trusted,
    ).toBe(true);
  });

  it("renders sha256sum-compatible checksums", () => {
    expect(
      renderChecksumFile([{ filename: "a.tgz", sha256: "a".repeat(64) }]),
    ).toBe(`${"a".repeat(64)}  a.tgz\n`);
  });

  it("builds a CycloneDX document from the resolved closure", () => {
    const sbom = createSbom({
      name: "@chriskealley/swf",
      version: "0.2.0",
      license: "MIT",
      closure: {
        declared: { zod: "^4.4.3" },
        resolved: [
          { name: "zod", version: "4.4.3", license: "MIT", direct: true },
        ],
        totalPackages: 1,
        licenses: { MIT: 1 },
        unknownLicenses: [],
      },
      createdAt: "2026-08-17T00:00:00.000Z",
    });
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.components).toHaveLength(1);
    expect(sbom.metadata.component.licenses[0]?.license.id).toBe("MIT");
  });
});
