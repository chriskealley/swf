import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument, validateJsonDocument } from "../src/schemas.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
}

describe("versioned document schemas", () => {
  it("accepts a valid run fixture with Zod and Ajv", () => {
    const value = fixture("run.valid.json");
    expect(parseDocument("run", value)).toEqual(value);
    expect(validateJsonDocument("run", value)).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("rejects invalid runtime fixtures", () => {
    const value = fixture("run.invalid.json");
    expect(() => parseDocument("run", value)).toThrow();
    expect(validateJsonDocument("run", value).valid).toBe(false);
  });

  it("rejects forward-incompatible schema fixtures", () => {
    const value = fixture("run.future.json");
    expect(() => parseDocument("run", value)).toThrow();
    expect(validateJsonDocument("run", value).valid).toBe(false);
  });
});
