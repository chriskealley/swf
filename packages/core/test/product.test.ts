import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRODUCT_COMPATIBILITY,
  assertPublishable,
  buildMetadataFromSource,
  createBuildMetadata,
  createProductMetadata,
  developmentProductMetadata,
  evaluateCompatibility,
  parseProductMetadata,
  readProductMetadata,
  refusesWriterStartup,
} from "../src/product.js";

const compatibility = {
  apiProtocolVersion: 2,
  stateSchemaVersion: 3,
  compatibleClientRange: ">=0.1.0 <0.2.0",
  piExtensionRange: ">=0.1.0 <0.2.0",
  minimumNodeVersion: "24.0.0",
};

function finding(report: ReturnType<typeof evaluateCompatibility>, id: string) {
  return report.findings.find((entry) => entry.id === id);
}

describe("compatibility evaluation", () => {
  it("accepts a client inside every declared range", () => {
    const report = evaluateCompatibility(compatibility, {
      clientVersion: "0.1.4",
      clientApiProtocolVersion: 2,
      stateSchemaVersion: 3,
      piExtensionVersion: "0.1.0",
      nodeVersion: "v24.16.0",
    });
    expect(report.compatible).toBe(true);
    expect(report.mutationAllowed).toBe(true);
  });

  it("rejects a client outside the compatible range", () => {
    const report = evaluateCompatibility(compatibility, {
      clientVersion: "0.2.0",
      clientApiProtocolVersion: 2,
      stateSchemaVersion: 3,
    });
    expect(report.compatible).toBe(false);
    expect(finding(report, "client-range")).toMatchObject({
      status: "incompatible",
      remediation: expect.stringContaining("Upgrade"),
    });
  });

  it("distinguishes an older service from a newer one", () => {
    const older = evaluateCompatibility(compatibility, {
      clientApiProtocolVersion: 1,
    });
    expect(finding(older, "api-protocol")?.detail).toContain("older");
    const newer = evaluateCompatibility(compatibility, {
      clientApiProtocolVersion: 3,
    });
    expect(finding(newer, "api-protocol")?.detail).toContain("newer");
  });

  it("blocks mutation when a version is unreported but does not call it incompatible", () => {
    const report = evaluateCompatibility(compatibility, {
      clientVersion: "0.1.4",
      clientApiProtocolVersion: 2,
    });
    expect(finding(report, "state-schema")?.status).toBe("unknown");
    expect(report.compatible).toBe(true);
    expect(report.mutationAllowed).toBe(false);
  });

  it("reports a state schema mismatch with migration remediation", () => {
    const report = evaluateCompatibility(compatibility, {
      clientVersion: "0.1.4",
      clientApiProtocolVersion: 2,
      stateSchemaVersion: 2,
    });
    expect(finding(report, "state-schema")).toMatchObject({
      status: "incompatible",
      remediation: expect.stringContaining("migration"),
    });
    expect(report.mutationAllowed).toBe(false);
  });

  it("checks the Pi extension only when a version is supplied", () => {
    expect(
      finding(evaluateCompatibility(compatibility, {}), "pi-extension"),
    ).toBeUndefined();
    expect(
      finding(
        evaluateCompatibility(compatibility, { piExtensionVersion: "0.3.0" }),
        "pi-extension",
      )?.status,
    ).toBe("incompatible");
  });

  it("normalizes a v-prefixed Node version", () => {
    expect(
      finding(
        evaluateCompatibility(compatibility, { nodeVersion: "v24.16.0" }),
        "node-version",
      )?.status,
    ).toBe("compatible");
    expect(
      finding(
        evaluateCompatibility(compatibility, { nodeVersion: "v22.19.0" }),
        "node-version",
      )?.status,
    ).toBe("incompatible");
  });

  it("treats an unparseable version or range as incompatible, not compatible", () => {
    expect(
      finding(
        evaluateCompatibility(compatibility, {
          clientVersion: "not-a-version",
        }),
        "client-range",
      )?.status,
    ).toBe("incompatible");
    expect(
      finding(
        evaluateCompatibility(
          { ...compatibility, compatibleClientRange: ">>bad range" },
          { clientVersion: "0.1.0" },
        ),
        "client-range",
      )?.status,
    ).toBe("incompatible");
  });

  it("matches a prerelease against its own range", () => {
    expect(
      finding(
        evaluateCompatibility(compatibility, { clientVersion: "0.1.5-next.2" }),
        "client-range",
      )?.status,
    ).toBe("compatible");
  });
});

describe("writer startup safety", () => {
  it("refuses a writer facing a future state schema", () => {
    expect(refusesWriterStartup(compatibility, 4)).toBe(true);
  });

  it("allows a writer at or below its supported schema", () => {
    expect(refusesWriterStartup(compatibility, 3)).toBe(false);
    expect(refusesWriterStartup(compatibility, 2)).toBe(false);
  });
});

describe("product metadata", () => {
  it("marks a development build non-publishable", () => {
    const metadata = developmentProductMetadata();
    expect(metadata.build.publishable).toBe(false);
    expect(metadata.build.channel).toBe("development");
  });

  it("round trips through persistence", () => {
    const metadata = developmentProductMetadata();
    expect(parseProductMetadata(JSON.parse(JSON.stringify(metadata)))).toEqual(
      metadata,
    );
  });

  it("rejects an unknown release channel", () => {
    const metadata = developmentProductMetadata() as unknown as {
      build: { channel: string };
    };
    expect(() =>
      parseProductMetadata({
        ...metadata,
        build: { ...metadata.build, channel: "beta" },
      }),
    ).toThrow();
  });

  it("declares a Node baseline of 24", () => {
    expect(PRODUCT_COMPATIBILITY.minimumNodeVersion).toBe("24.0.0");
  });
});

describe("build metadata generation", () => {
  const clean = {
    productVersion: "0.2.0",
    sourceCommit: "a".repeat(40),
    sourceDirty: false,
    builtAt: "2026-08-17T00:00:00.000Z",
  };

  it("marks a clean stable build publishable", () => {
    const build = createBuildMetadata({ ...clean, channel: "stable" });
    expect(build.publishable).toBe(true);
    expect(() => assertPublishable(build)).not.toThrow();
  });

  it("refuses a stable build from a dirty tree", () => {
    const build = createBuildMetadata({
      ...clean,
      sourceDirty: true,
      channel: "stable",
    });
    expect(build.publishable).toBe(false);
    expect(() => assertPublishable(build)).toThrow("working tree is dirty");
  });

  it("requires a prerelease version on the next channel", () => {
    expect(createBuildMetadata({ ...clean, channel: "next" }).publishable).toBe(
      false,
    );
    expect(
      createBuildMetadata({
        ...clean,
        productVersion: "0.3.0-next.2",
        channel: "next",
      }).publishable,
    ).toBe(true);
  });

  it("refuses a prerelease version on the stable channel", () => {
    const build = createBuildMetadata({
      ...clean,
      productVersion: "0.3.0-next.2",
      channel: "stable",
    });
    expect(build.publishable).toBe(false);
    expect(() => assertPublishable(build)).toThrow("must not use a prerelease");
  });

  it("never marks a development build publishable", () => {
    const build = createBuildMetadata({ ...clean, channel: "development" });
    expect(build.publishable).toBe(false);
    expect(() => assertPublishable(build)).toThrow("development");
  });

  it("rejects a version that is not semver", () => {
    const build = createBuildMetadata({
      ...clean,
      productVersion: "release-two",
      channel: "stable",
    });
    expect(build.publishable).toBe(false);
    expect(() => assertPublishable(build)).toThrow("not valid semver");
  });

  it("normalizes a v-prefixed version", () => {
    expect(
      createBuildMetadata({
        ...clean,
        productVersion: "v0.2.0",
        channel: "stable",
      }).productVersion,
    ).toBe("0.2.0");
  });

  it("derives metadata from a source identity", () => {
    const build = buildMetadataFromSource(
      { sourceCommit: "b".repeat(40), sourceDirty: false },
      "0.2.0",
      "stable",
      clean.builtAt,
    );
    expect(build).toMatchObject({
      sourceCommit: "b".repeat(40),
      publishable: true,
    });
  });

  it("composes a full metadata document", () => {
    const metadata = createProductMetadata({ ...clean, channel: "stable" });
    expect(parseProductMetadata(metadata)).toEqual(metadata);
    expect(metadata.compatibility.minimumNodeVersion).toBe("24.0.0");
  });
});

describe("packaged metadata resolution", () => {
  async function stage(relativeEntry: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "swf product "));
    const metadata = createProductMetadata({
      productVersion: "0.2.0",
      sourceCommit: "c".repeat(40),
      sourceDirty: false,
      channel: "stable",
      builtAt: "2026-08-17T00:00:00.000Z",
    });
    await writeFile(
      join(root, "product.json"),
      JSON.stringify(metadata, null, 2),
    );
    const entry = join(root, relativeEntry);
    await mkdir(entry, { recursive: true });
    return entry;
  }

  it("finds metadata beside a shallow entry", async () => {
    const metadata = await readProductMetadata(await stage("bin"));
    expect(metadata.build.productVersion).toBe("0.2.0");
  });

  it("finds metadata above a deeply nested bundler entry", async () => {
    const metadata = await readProductMetadata(
      await stage(join("service", "server", "chunks", "nitro")),
    );
    expect(metadata.build.channel).toBe("stable");
  });

  it("resolves from a path containing spaces", async () => {
    const entry = await stage(join("service", "server"));
    expect(entry).toContain(" ");
    await expect(readProductMetadata(entry)).resolves.toMatchObject({
      build: { publishable: true },
    });
  });

  it("reports a clear error when no metadata exists", async () => {
    const empty = await mkdtemp(join(tmpdir(), "swf-empty-"));
    await expect(readProductMetadata(empty)).rejects.toThrow(
      "No product.json was found",
    );
  });
});
