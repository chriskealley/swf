import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const loader = join(
  process.cwd(),
  "apps/cli/node_modules/tsx/dist/loader.mjs",
);
const main = join(process.cwd(), "apps/cli/src/main.ts");

async function cli(args: string[], environment: Record<string, string> = {}) {
  try {
    const result = await execute(
      process.execPath,
      ["--import", loader, main, ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "production",
          VITEST: undefined,
          CONSOLA_LEVEL: "5",
          NO_COLOR: "1",
          ...environment,
        },
      },
    );
    return { ...result, code: 0 };
  } catch (error) {
    return error as { stdout: string; stderr: string; code: number };
  }
}

describe("CLI subprocess contracts", () => {
  it("writes exactly one versioned JSON result document", async () => {
    const result = await cli(["setup", "herdr", "--json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ schemaVersion: 1 });
    expect(parsed.result.plan).toBeDefined();
    expect(result.stderr).toBe("");
  });

  it("writes one classified JSON error and exits nonzero", async () => {
    const serviceHome = await mkdtemp(join(tmpdir(), "swf-cli-json-error-"));
    const result = await cli(["service", "status", "--json"], {
      SWF_SERVICE_HOME: serviceHome,
    });
    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      error: {
        schemaVersion: 1,
        code: "SWF_ERROR",
        category: "infrastructure",
        retryable: false,
      },
    });
  });

  it("keeps non-TTY human output line-oriented and ANSI-free", async () => {
    const result = await cli(["setup", "herdr"]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(String.fromCharCode(27));
    expect(result.stdout.trim()).not.toBe("");
    expect(result.stdout).not.toContain("\r");
  });
});
