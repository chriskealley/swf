import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const loader = join(process.cwd(), "apps/cli/node_modules/tsx/dist/loader.mjs");
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

describe("roadmap entry CLI surface", () => {
  it("exposes explicit Planning-only and automatic roadmap entry", async () => {
    const help = await cli(["roadmap", "--help"]);
    expect(help.stdout).toContain("swf roadmap new|run|reconcile");
    expect(help.stdout).toContain(
      "Start the next eligible roadmap item, execute Planning, and stop",
    );
    expect(help.stdout).toContain("automatic progression");
  });

  it("takes no change argument, unlike direct entry", async () => {
    const roadmapHelp = await cli(["roadmap", "new", "--help"]);
    expect(roadmapHelp.stdout).not.toContain("CHANGE");
    const directHelp = await cli(["new", "--help"]);
    expect(directHelp.stdout).toContain("CHANGE");
  });

  it("keeps the required change argument on direct entry commands", async () => {
    for (const command of ["new", "run", "next"]) {
      const result = await cli([command]);
      expect(result.code).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/change/i);
    }
  });

  it("reports OpenRoad readiness only when roadmap intake is requested", async () => {
    const plain = await cli(["doctor", "--json"]);
    const withRoadmap = await cli(["doctor", "--roadmap", "--json"]);
    const ids = (raw: string) =>
      (
        JSON.parse(raw) as { result: { checks: Array<{ id: string }> } }
      ).result.checks.map(({ id }) => id);
    expect(ids(plain.stdout)).not.toContain("roadmap.openroad");
    expect(ids(withRoadmap.stdout)).toContain("roadmap.openroad");
    expect(ids(withRoadmap.stdout)).toContain("tool.openroad");
  });
});

describe("roadmap entry documentation", () => {
  it("documents only commands and flags the CLI actually accepts", async () => {
    const docs = await readFile(
      join(process.cwd(), "docs/roadmap-intake.md"),
      "utf8",
    );
    const documented = [
      ...docs.matchAll(/^swf ((?:roadmap [a-z]+|doctor)[^\n|]*)$/gm),
    ].map(([, invocation]) => invocation!.split("|")[0]!.trim());
    expect(documented.length).toBeGreaterThan(3);

    for (const invocation of new Set(documented)) {
      const args = invocation
        .split(/\s+/)
        .filter((arg) => !arg.startsWith("--"));
      const help = await cli([...args, "--help"]);
      expect(help.code, `swf ${invocation}`).toBe(0);
      for (const flag of invocation.match(/--[a-z-]+/g) ?? [])
        expect(help.stdout, `swf ${invocation}`).toContain(flag);
    }
  });

  it("documents the intake classifications the service can return", async () => {
    const docs = await readFile(
      join(process.cwd(), "docs/roadmap-intake.md"),
      "utf8",
    );
    for (const classification of [
      "selected",
      "resumed",
      "recovered",
      "no-eligible-work",
      "invalid-roadmap",
      "conflict",
    ])
      expect(docs).toContain(`\`${classification}\``);
  });
});
