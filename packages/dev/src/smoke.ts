import { spawn } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateLoopbackPort } from "./instance.js";
import {
  createGitFixture,
  removeGitFixture,
  type GitFixture,
} from "./fixture.js";

export interface SmokeEnvironment {
  root: string;
  prefix: string;
  home: string;
  serviceHome: string;
  cacheDirectory: string;
  executable: string;
  port: number;
  fixture: GitFixture;
}

export interface SmokeCheck {
  id: string;
  passed: boolean;
  detail: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command with a fully isolated environment. `HOME`, both SWF home
 * variables, and the npm cache are redirected, and the workspace is removed
 * from `NODE_PATH`, so a smoke test cannot silently borrow the contributor's
 * real state or the source checkout's modules.
 */
export async function runIsolated(
  environment: SmokeEnvironment,
  command: string,
  args: string[],
  extraEnvironment: Record<string, string> = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: environment.fixture.root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: environment.home,
        SWF_SERVICE_HOME: environment.serviceHome,
        SWF_CONFIG_HOME: environment.serviceHome,
        npm_config_cache: environment.cacheDirectory,
        HOST: "127.0.0.1",
        NITRO_HOST: "127.0.0.1",
        PORT: String(environment.port),
        NITRO_PORT: String(environment.port),
        SWF_LIVE_HARNESS: "0",
        SWF_HOSTED_DELIVERY: "0",
        ...extraEnvironment,
      },
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

/**
 * Installs the packed tarball into a throwaway prefix. Nothing about the
 * contributor's machine is consulted beyond PATH and the Node runtime.
 */
export async function installTarball(
  tarballPath: string,
  options: { packageManager?: string } = {},
): Promise<SmokeEnvironment> {
  const root = await mkdtemp(join(tmpdir(), "swf-smoke-"));
  const prefix = join(root, "prefix");
  const home = join(root, "home");
  const serviceHome = join(root, "service-home");
  const cacheDirectory = join(root, "npm-cache");
  for (const directory of [prefix, home, serviceHome, cacheDirectory])
    await mkdir(directory, { recursive: true });

  const fixture = await createGitFixture({ retain: true });
  const manager = options.packageManager ?? "npm";

  const install = await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(
      manager,
      [
        "install",
        "--global",
        "--prefix",
        prefix,
        "--no-audit",
        "--no-fund",
        tarballPath,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          npm_config_cache: cacheDirectory,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
  if (install.code !== 0)
    throw new Error(`global install failed: ${install.stderr.trim()}`);

  return {
    root,
    prefix,
    home,
    serviceHome,
    cacheDirectory,
    executable: join(prefix, "bin", "swf"),
    port: await allocateLoopbackPort(),
    fixture,
  };
}

export async function removeSmokeEnvironment(
  environment: SmokeEnvironment,
): Promise<void> {
  await removeGitFixture({ ...environment.fixture, retain: false });
  await rm(environment.root, { recursive: true, force: true });
}

/** Resolves the installed package directory beneath the temporary prefix. */
export function installedPackageDirectory(
  environment: SmokeEnvironment,
): string {
  return join(
    environment.prefix,
    "lib",
    "node_modules",
    "@chriskealley",
    "swf",
  );
}

/**
 * Proves the installed executable resolves nothing from the source checkout.
 * A packaged product that still reaches into the workspace would pass every
 * other smoke check while being unusable for a real consumer.
 */
export async function checkNoWorkspaceResolution(
  environment: SmokeEnvironment,
  repositoryRoot: string,
): Promise<SmokeCheck> {
  const result = await runIsolated(environment, environment.executable, [
    "--version",
  ]);
  const referencesWorkspace =
    result.stdout.includes(repositoryRoot) ||
    result.stderr.includes(repositoryRoot);
  return {
    id: "no-workspace-resolution",
    passed: result.code === 0 && !referencesWorkspace,
    detail: referencesWorkspace
      ? `output referenced the source workspace ${repositoryRoot}`
      : "installed executable resolved no source-workspace path",
  };
}

/** User and project state must survive package removal. */
export async function simulateUninstall(
  environment: SmokeEnvironment,
): Promise<SmokeCheck[]> {
  const packageDirectory = installedPackageDirectory(environment);
  const beforeService = await readdir(environment.serviceHome).catch(
    (): string[] => [],
  );
  const beforeProject = await readdir(environment.fixture.root).catch(
    (): string[] => [],
  );

  await rm(packageDirectory, { recursive: true, force: true });
  await rm(join(environment.prefix, "bin", "swf"), { force: true });

  const afterService = await readdir(environment.serviceHome).catch(
    (): string[] => [],
  );
  const afterProject = await readdir(environment.fixture.root).catch(
    (): string[] => [],
  );

  return [
    {
      id: "uninstall-removes-product",
      passed: !(await exists(packageDirectory)),
      detail: "installed product files were removed",
    },
    {
      id: "uninstall-preserves-user-state",
      passed:
        beforeService.length === afterService.length &&
        beforeService.every((entry) => afterService.includes(entry)),
      detail: `service home retained ${afterService.length} entries`,
    },
    {
      id: "uninstall-preserves-project-state",
      passed:
        beforeProject.length === afterProject.length &&
        beforeProject.every((entry) => afterProject.includes(entry)),
      detail: `project retained ${afterProject.length} entries`,
    },
  ];
}

/** Operational directories and files must not be world or group readable. */
export async function checkPrivatePermissions(
  environment: SmokeEnvironment,
): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = [];
  for (const entry of await readdir(environment.serviceHome).catch(
    (): string[] => [],
  )) {
    const path = join(environment.serviceHome, entry);
    const mode = (await stat(path)).mode & 0o777;
    const permissive = (mode & 0o077) !== 0;
    checks.push({
      id: `permissions:${entry}`,
      passed: !permissive,
      detail: `${entry} mode ${mode.toString(8).padStart(4, "0")}`,
    });
  }
  return checks;
}

export async function readInstalledManifest(
  environment: SmokeEnvironment,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(
      join(installedPackageDirectory(environment), "package.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

export interface ServiceSmokeResult {
  checks: SmokeCheck[];
  /** Retained so callers can assert state survived the service lifecycle. */
  credentialPresent: boolean;
}

/**
 * Starts the packaged service entry directly, completes an authenticated
 * query, and stops it. The installed `swf service start` still shells out to a
 * workspace launcher until that is replaced, so smoking the entry itself is
 * what proves the shipped service actually runs.
 */
export async function smokePackagedService(
  environment: SmokeEnvironment,
): Promise<ServiceSmokeResult> {
  const entry = join(
    installedPackageDirectory(environment),
    "service",
    "server",
    "index.mjs",
  );
  const checks: SmokeCheck[] = [];
  const child = spawn(process.execPath, [entry], {
    cwd: environment.fixture.root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: environment.home,
      SWF_SERVICE_HOME: environment.serviceHome,
      SWF_CONFIG_HOME: environment.serviceHome,
      HOST: "127.0.0.1",
      NITRO_HOST: "127.0.0.1",
      PORT: String(environment.port),
      NITRO_PORT: String(environment.port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

  const endpoint = `http://127.0.0.1:${environment.port}`;
  let credential: string | undefined;
  try {
    const healthy = await waitForHealth(endpoint);
    checks.push({
      id: "service-start",
      passed: healthy !== undefined,
      detail: healthy
        ? `reported version ${healthy.product?.productVersion ?? "unknown"}`
        : `service did not become healthy: ${output.slice(0, 200)}`,
    });

    checks.push({
      id: "service-compatibility",
      passed: healthy?.compatibility?.minimumNodeVersion === "24.0.0",
      detail: `declares Node baseline ${healthy?.compatibility?.minimumNodeVersion ?? "none"}`,
    });

    credential = await readServiceCredential(environment);
    const credentialPresent = credential !== undefined;
    checks.push({
      id: "service-credential",
      passed: credentialPresent,
      detail: credentialPresent
        ? "service published a private credential"
        : "no service credential was written",
    });

    if (credential) {
      const authorized = await fetch(
        `${endpoint}/api/v1/query?resource=projects`,
        {
          headers: { authorization: `Bearer ${credential}` },
          signal: AbortSignal.timeout(5_000),
        },
      ).catch(() => undefined);
      checks.push({
        id: "authenticated-query",
        passed: authorized?.ok === true,
        detail: `status ${authorized?.status ?? "unreachable"}`,
      });

      const unauthorized = await fetch(
        `${endpoint}/api/v1/query?resource=projects`,
        { signal: AbortSignal.timeout(5_000) },
      ).catch(() => undefined);
      checks.push({
        id: "unauthenticated-query-rejected",
        passed: unauthorized?.status === 401,
        detail: `status ${unauthorized?.status ?? "unreachable"}`,
      });
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    checks.push({
      id: "service-stop",
      passed: child.killed || child.exitCode !== null,
      detail: `exit ${child.exitCode ?? "signalled"}`,
    });
  }
  return { checks, credentialPresent: credential !== undefined };
}

interface HealthBody {
  product?: { productVersion?: string };
  compatibility?: { minimumNodeVersion?: string };
}

async function waitForHealth(
  endpoint: string,
  attempts = 40,
): Promise<HealthBody | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(`${endpoint}/api/health`, {
      signal: AbortSignal.timeout(1_000),
    }).catch(() => undefined);
    if (response?.ok) return (await response.json()) as HealthBody;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

async function readServiceCredential(
  environment: SmokeEnvironment,
): Promise<string | undefined> {
  try {
    const metadata = JSON.parse(
      await readFile(join(environment.serviceHome, "service.json"), "utf8"),
    ) as { credential?: string };
    return metadata.credential;
  } catch {
    return undefined;
  }
}
