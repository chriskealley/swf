import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { RunSchema, jsonSchemas, parseDocument } from "../src/schemas.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
}

describe("versioned document schemas", () => {
  it("accepts a valid run fixture", () => {
    const value = fixture("run.valid.json");
    expect(parseDocument("run", value)).toEqual(value);
    expect(RunSchema.safeParse(value).success).toBe(true);
  });

  it("rejects invalid runtime fixtures", () => {
    const value = fixture("run.invalid.json");
    expect(() => parseDocument("run", value)).toThrow();
    const result = RunSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.length).toBeGreaterThan(0);
  });

  it("rejects forward-incompatible schema fixtures", () => {
    const value = fixture("run.future.json");
    expect(() => parseDocument("run", value)).toThrow();
    const result = RunSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(
        result.error.issues.some((issue) =>
          issue.path.includes("schemaVersion"),
        ),
      ).toBe(true);
  });
});

describe("published JSON Schemas", () => {
  // Zod is the runtime validation authority; these schemas are a derived
  // export. This proves the derivation stays usable by outside tooling.
  it("compiles every generated schema with a standards-compliant validator", () => {
    const names = Object.keys(jsonSchemas);
    expect(names.length).toBeGreaterThan(0);
    for (const [name, schema] of Object.entries(jsonSchemas)) {
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      expect(() => ajv.compile(schema), `${name} must compile`).not.toThrow();
    }
  });

  it("fails when a generated schema is malformed", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    expect(() => ajv.compile({ type: "not-a-real-type" })).toThrow();
  });
});
