import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRODUCT_COMPATIBILITY, requirements } from "@swf/core";
import {
  MINIMUM_NODE_MAJOR,
  assertSupportedNode,
  nodeVersionFailure,
} from "../src/node-guard.js";

describe("node version guard", () => {
  it("accepts the supported baseline and newer", () => {
    expect(nodeVersionFailure("v24.0.0", 24)).toBeUndefined();
    expect(nodeVersionFailure("v24.16.0", 24)).toBeUndefined();
    expect(nodeVersionFailure("v26.1.0", 24)).toBeUndefined();
  });

  it("rejects an older runtime with an actionable message", () => {
    const failure = nodeVersionFailure("v22.19.0", 24);
    expect(failure).toContain("requires Node >=24");
    expect(failure).toContain("v22.19.0");
  });

  it("accepts a version without the v prefix", () => {
    expect(nodeVersionFailure("24.16.0", 24)).toBeUndefined();
    expect(nodeVersionFailure("22.19.0", 24)).toBeDefined();
  });

  it("fails closed on an unparseable version", () => {
    expect(nodeVersionFailure("not-a-version", 24)).toContain(
      "could not determine",
    );
  });

  it("exits through the supplied failure handler", () => {
    const messages: string[] = [];
    const fail = ((message: string) => {
      messages.push(message);
      throw new Error("exited");
    }) as (message: string) => never;
    expect(() => assertSupportedNode("v20.0.0", 24, fail)).toThrow("exited");
    expect(messages[0]).toContain("requires Node >=24");
  });

  it("does not exit on a supported runtime", () => {
    const fail = (() => {
      throw new Error("should not be called");
    }) as (message: string) => never;
    expect(() => assertSupportedNode("v24.16.0", 24, fail)).not.toThrow();
  });

  it("declares a baseline matching the packaged product", () => {
    expect(MINIMUM_NODE_MAJOR).toBe(24);
  });
});

describe("node baseline is declared consistently", () => {
  // A user must never be able to install a product its own diagnostics reject,
  // so every place the baseline is encoded has to agree.
  const rootManifest = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { engines?: { node?: string } };

  function major(version: string): number {
    return Number.parseInt(version.replace(/^\D*/, "").split(".")[0] ?? "", 10);
  }

  it("agrees across engines, diagnostics, product metadata, and the guard", () => {
    const engines = rootManifest.engines?.node;
    expect(engines).toBeDefined();
    const declared = [
      major(engines as string),
      major(requirements.node.minimumVersion as string),
      major(PRODUCT_COMPATIBILITY.minimumNodeVersion),
      MINIMUM_NODE_MAJOR,
    ];
    expect(new Set(declared).size, `baselines disagree: ${declared}`).toBe(1);
  });

  it("rejects the runtime that installation diagnostics would reject", () => {
    const belowBaseline = `v${MINIMUM_NODE_MAJOR - 1}.0.0`;
    expect(nodeVersionFailure(belowBaseline, MINIMUM_NODE_MAJOR)).toBeDefined();
  });
});
