import { spawn } from "node:child_process";
import { access, cp, mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const staging = join(repositoryRoot, "dist", "product");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runNode(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1 }));
  });
}

const assembled = await exists(join(staging, "bin", "swf.mjs"));

// The assembled product is a build output, not a committed artifact. Skip
// rather than fail when a checkout has not run `pnpm build:product`.
describe.skipIf(!assembled)("assembled product entry", () => {
  it("declares no workspace protocol or development-only dependency", async () => {
    const manifest = JSON.parse(
      await readFile(join(staging, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      bin?: Record<string, string>;
    };
    const dependencies = Object.entries(manifest.dependencies ?? {});
    expect(dependencies.length).toBeGreaterThan(0);
    for (const [name, range] of dependencies) {
      expect(range, `${name} must not use the workspace protocol`).not.toMatch(
        /^workspace:/,
      );
      expect(name).not.toMatch(/^@swf\//);
    }
    for (const forbidden of ["tsx", "nitropack", "esbuild", "vite", "vitest"])
      expect(Object.keys(manifest.dependencies ?? {})).not.toContain(forbidden);
  });

  it("points bin at compiled JavaScript rather than TypeScript source", async () => {
    const manifest = JSON.parse(
      await readFile(join(staging, "package.json"), "utf8"),
    ) as { bin?: Record<string, string> };
    const target = manifest.bin?.swf;
    expect(target).toBeDefined();
    expect(target).toMatch(/\.mjs$/);
    expect(await exists(join(staging, target as string))).toBe(true);
  });

  it("carries a shebang exactly once", async () => {
    const source = await readFile(join(staging, "bin", "swf.mjs"), "utf8");
    expect(source.split("\n").filter((l) => l.startsWith("#!"))).toHaveLength(
      1,
    );
    expect(source.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("inlines internal packages instead of importing them", async () => {
    const source = await readFile(join(staging, "bin", "swf.mjs"), "utf8");
    expect(source).not.toMatch(/from\s+["']@swf\//);
    expect(source).not.toMatch(/from\s+["']tsx["']/);
  });

  it("ships the compiled service entry and dashboard assets", async () => {
    expect(await exists(join(staging, "service", "server", "index.mjs"))).toBe(
      true,
    );
    expect(
      await exists(
        join(staging, "service", "public", "dashboard", "index.html"),
      ),
    ).toBe(true);
  });

  describe("installed from the assembled package", () => {
    // Dependencies are declared rather than bundled, so the staged layout is
    // only executable once installed. Installing into a spaced path also
    // exercises argument and path handling end to end.
    let installed: string | undefined;

    beforeAll(async () => {
      const root = join(await mkdtemp(join(tmpdir(), "swf-")), "install dir");
      await mkdir(root, { recursive: true });
      await cp(staging, root, { recursive: true });
      const install = await runCommand(
        "npm",
        ["install", "--omit=dev", "--no-audit", "--no-fund", "--silent"],
        root,
      );
      if (install.code === 0) installed = root;
    }, 300_000);

    it("runs from an unrelated working directory", async () => {
      if (!installed) return;
      const elsewhere = await mkdtemp(join(tmpdir(), "swf-cwd-"));
      const result = await runNode(
        [join(installed, "bin", "swf.mjs"), "--version"],
        elsewhere,
      );
      expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(result.stdout.trim().length).toBeGreaterThan(0);
    });

    it("runs from a working directory containing spaces", async () => {
      if (!installed) return;
      const spaced = join(await mkdtemp(join(tmpdir(), "swf-")), "a dir");
      await mkdir(spaced, { recursive: true });
      const result = await runNode(
        [join(installed, "bin", "swf.mjs"), "--version"],
        spaced,
      );
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      expect(result.stderr).not.toContain("Cannot find");
    });

    it("resolves no module or asset from the source workspace", async () => {
      if (!installed) return;
      const elsewhere = await mkdtemp(join(tmpdir(), "swf-cwd-"));
      const result = await runNode(
        [join(installed, "bin", "swf.mjs"), "--version"],
        elsewhere,
      );
      expect(result.stdout).not.toContain(repositoryRoot);
      expect(result.stderr).not.toContain(repositoryRoot);
    });
  });
});
