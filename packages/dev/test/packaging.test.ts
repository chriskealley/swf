import { describe, expect, it } from "vitest";
import {
  classifyDifference,
  compareReproducibility,
  createReleaseEvidence,
  decidePublishability,
  inspectPackedArtifact,
  type PackedArtifact,
} from "../src/index.js";

const packed: PackedArtifact = {
  name: "@chriskealley/swf",
  version: "0.2.0",
  filename: "chriskealley-swf-0.2.0.tgz",
  tarballPath: "/tmp/chriskealley-swf-0.2.0.tgz",
  shasum: "a".repeat(40),
  integrity: "sha512-abc",
  sha256: "b".repeat(64),
  entryCount: 3,
  unpackedBytes: 1_000,
  files: [
    { path: "package.json", bytes: 500 },
    { path: "LICENSE", bytes: 100 },
    { path: "bin/swf.mjs", bytes: 400 },
  ],
};

const expectations = {
  forbiddenPatterns: [/\.ts$/, /(^|\/)node_modules\//],
  requiredPaths: ["package.json", "LICENSE", "bin/swf.mjs"],
  maximumBytes: 4 * 1024 * 1024,
  expectedName: "@chriskealley/swf",
};

describe("packed artifact inspection", () => {
  it("accepts a well-formed tarball", () => {
    expect(inspectPackedArtifact(packed, expectations).violations).toEqual([]);
  });

  it("rejects a missing required path", () => {
    const { violations } = inspectPackedArtifact(
      { ...packed, files: packed.files.filter((f) => f.path !== "LICENSE") },
      expectations,
    );
    expect(violations.some((v) => v.includes("LICENSE"))).toBe(true);
  });

  it("rejects forbidden content in the tarball", () => {
    const { violations } = inspectPackedArtifact(
      {
        ...packed,
        files: [...packed.files, { path: "src/main.ts", bytes: 10 }],
      },
      expectations,
    );
    expect(violations.some((v) => v.includes("src/main.ts"))).toBe(true);
  });

  it("rejects a package over its size budget", () => {
    const { violations } = inspectPackedArtifact(
      { ...packed, unpackedBytes: 8 * 1024 * 1024 },
      expectations,
    );
    expect(violations.some((v) => v.includes("exceeds"))).toBe(true);
  });

  it("rejects an unexpected package name", () => {
    const { violations } = inspectPackedArtifact(
      { ...packed, name: "swf" },
      expectations,
    );
    expect(violations.some((v) => v.includes("does not match"))).toBe(true);
  });

  it("rejects a malformed digest", () => {
    const { violations } = inspectPackedArtifact(
      { ...packed, sha256: "not-a-digest" },
      expectations,
    );
    expect(violations.some((v) => v.includes("SHA-256"))).toBe(true);
  });
});

describe("publishability", () => {
  it("accepts a clean stable release", () => {
    expect(
      decidePublishability({
        channel: "stable",
        sourceDirty: false,
        version: "0.2.0",
      }),
    ).toMatchObject({ publishable: true, label: "publishable" });
  });

  it("labels a dirty tree development-only", () => {
    const decision = decidePublishability({
      channel: "stable",
      sourceDirty: true,
      version: "0.2.0",
    });
    expect(decision.publishable).toBe(false);
    expect(decision.label).toBe("development-only");
    expect(decision.reasons).toContain("the working tree is dirty");
  });

  it("requires a prerelease version on the next channel", () => {
    expect(
      decidePublishability({
        channel: "next",
        sourceDirty: false,
        version: "0.3.0",
      }).publishable,
    ).toBe(false);
    expect(
      decidePublishability({
        channel: "next",
        sourceDirty: false,
        version: "0.3.0-next.2",
      }).publishable,
    ).toBe(true);
  });

  it("refuses a prerelease version on the stable channel", () => {
    expect(
      decidePublishability({
        channel: "stable",
        sourceDirty: false,
        version: "0.3.0-next.2",
      }).reasons,
    ).toContain("a stable release must not use a prerelease version");
  });

  it("never marks a development build publishable", () => {
    expect(
      decidePublishability({
        channel: "development",
        sourceDirty: false,
        version: "0.2.0",
      }).publishable,
    ).toBe(false);
  });
});

describe("reproducibility comparison", () => {
  const first = [
    { path: "a.mjs", sha256: "1" },
    { path: "b.mjs", sha256: "2" },
  ];

  it("reports identical builds", () => {
    const report = compareReproducibility(first, first, true);
    expect(report.identical).toBe(true);
    expect(report.matchedFiles).toBe(2);
    expect(report.knownNondeterminism).toEqual([]);
  });

  it("reports differing file content", () => {
    const report = compareReproducibility(
      first,
      [
        { path: "a.mjs", sha256: "1" },
        { path: "b.mjs", sha256: "changed" },
      ],
      false,
    );
    expect(report.identical).toBe(false);
    expect(report.differingFiles).toEqual(["b.mjs"]);
  });

  it("reports files present in only one build", () => {
    const report = compareReproducibility(
      first,
      [{ path: "a.mjs", sha256: "1" }],
      false,
    );
    expect(report.differingFiles).toContain("b.mjs (missing in second)");
  });

  it("explains an archive digest mismatch when every file matches", () => {
    const report = compareReproducibility(first, first, false);
    expect(report.identical).toBe(true);
    expect(report.knownNondeterminism[0]).toContain("modification times");
  });
});

describe("difference classification", () => {
  it("treats identical content as timestamps-only", () => {
    expect(classifyDifference("same", "same")).toBe("timestamps-only");
  });

  it("recognises a difference confined to embedded timestamps", () => {
    expect(
      classifyDifference(
        '{"mtime":"2026-08-17T05:46:32.172Z","size":10}',
        '{"mtime":"2026-08-17T05:47:48.260Z","size":10}',
      ),
    ).toBe("timestamps-only");
  });

  it("reports a real content difference", () => {
    expect(
      classifyDifference(
        '{"mtime":"2026-08-17T05:46:32.172Z","size":10}',
        '{"mtime":"2026-08-17T05:46:32.172Z","size":11}',
      ),
    ).toBe("content");
  });

  it("does not excuse a difference that merely contains a timestamp", () => {
    expect(
      classifyDifference(
        'const build = "2026-08-17T05:46:32.172Z"; export const a = 1;',
        'const build = "2026-08-17T05:47:48.260Z"; export const a = 2;',
      ),
    ).toBe("content");
  });
});

describe("release evidence", () => {
  it("records source, toolchain, artifacts, and destinations", () => {
    const evidence = createReleaseEvidence({
      createdAt: "2026-08-17T00:00:00.000Z",
      source: { commit: "c".repeat(40), dirty: false },
      toolchain: { node: "v24.16.0", packageManager: "npm" },
      lockfile: { path: "pnpm-lock.yaml", sha256: "d".repeat(64) },
      product: {
        name: "@chriskealley/swf",
        version: "0.2.0",
        channel: "stable",
        publishable: true,
      },
      artifacts: [
        {
          name: "@chriskealley/swf",
          filename: "chriskealley-swf-0.2.0.tgz",
          sha256: "e".repeat(64),
          integrity: "sha512-x",
          entryCount: 28,
          unpackedBytes: 1_431_250,
        },
      ],
      tests: [{ suite: "version", passed: true }],
      provenance: { requested: true },
      destinations: ["npm:@chriskealley/swf"],
    });
    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.source.commit).toHaveLength(40);
    expect(evidence.artifacts[0]?.sha256).toHaveLength(64);
    expect(evidence.destinations).toContain("npm:@chriskealley/swf");
  });
});
