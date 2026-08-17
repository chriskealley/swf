import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Live harness invocations and hosted delivery cost money and mutate remote
 * state, so they are never implied by running a fixture. Both must be turned on
 * deliberately, and the environment a fixture hands to a child process pins
 * them off unless explicitly enabled.
 */
export interface FixtureCapabilities {
  liveHarness: boolean;
  hostedDelivery: boolean;
}

export const DEFAULT_FIXTURE_CAPABILITIES: FixtureCapabilities = {
  liveHarness: false,
  hostedDelivery: false,
};

export interface FixtureOptions {
  changeName?: string;
  retain?: boolean;
  capabilities?: Partial<FixtureCapabilities>;
  now?: string;
}

export interface GitFixture {
  root: string;
  branch: string;
  headCommit: string;
  changeName: string;
  capabilities: FixtureCapabilities;
  retain: boolean;
}

async function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "SWF Fixture",
        GIT_AUTHOR_EMAIL: "fixture@swf.invalid",
        GIT_COMMITTER_NAME: "SWF Fixture",
        GIT_COMMITTER_EMAIL: "fixture@swf.invalid",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`)),
    );
  });
}

/**
 * Creates a throwaway committed Git repository with an OpenSpec change, so a
 * contributor never has to point smoke tests at a personal repository. Delivery
 * defaults to a local branch: no remote is configured, so nothing can be pushed.
 */
export async function createGitFixture(
  options: FixtureOptions = {},
): Promise<GitFixture> {
  const changeName = options.changeName ?? "fixture-change";
  const root = await mkdtemp(join(tmpdir(), "swf-fixture-"));

  await git(["init", "--initial-branch=main"], root);
  await git(["config", "user.name", "SWF Fixture"], root);
  await git(["config", "user.email", "fixture@swf.invalid"], root);
  // Deliberately no remote: local-branch delivery cannot reach a host.
  await git(["config", "--unset-all", "remote.origin.url"], root).catch(
    () => undefined,
  );

  await writeFile(
    join(root, "README.md"),
    `# SWF fixture\n\nThrowaway repository created for local smoke testing.\n`,
  );
  const changeRoot = join(root, "openspec", "changes", changeName);
  await mkdir(changeRoot, { recursive: true });
  await writeFile(
    join(changeRoot, "proposal.md"),
    [
      "## Why",
      "",
      "Exercise the SWF workflow against a disposable fixture.",
      "",
      "## What Changes",
      "",
      "- Add a marker file proving the workflow ran.",
      "",
      "## Impact",
      "",
      "- Affects the fixture repository only.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(changeRoot, "tasks.md"),
    ["## 1. Marker", "", "- [ ] 1.1 Create the marker file", ""].join("\n"),
  );

  await git(["add", "."], root);
  await git(["commit", "-m", "chore: seed SWF fixture"], root);
  const headCommit = await git(["rev-parse", "HEAD"], root);
  const branch = await git(["branch", "--show-current"], root);

  return {
    root,
    branch,
    headCommit,
    changeName,
    capabilities: {
      ...DEFAULT_FIXTURE_CAPABILITIES,
      ...options.capabilities,
    },
    retain: options.retain ?? false,
  };
}

export async function removeGitFixture(fixture: GitFixture): Promise<boolean> {
  if (fixture.retain) return false;
  await rm(fixture.root, { recursive: true, force: true });
  return true;
}

/**
 * Environment for a fixture run. Paid or remote capabilities are explicitly
 * disabled rather than merely unset, so an exported shell variable cannot
 * silently enable a live harness during an ordinary smoke test.
 */
export function fixtureEnvironment(
  fixture: GitFixture,
): Record<string, string> {
  return {
    SWF_LIVE_HARNESS: fixture.capabilities.liveHarness ? "1" : "0",
    SWF_HOSTED_DELIVERY: fixture.capabilities.hostedDelivery ? "1" : "0",
    SWF_DELIVERY_MODE: fixture.capabilities.hostedDelivery
      ? "pull-request"
      : "local-branch",
  };
}

export function fixtureCapabilitySummary(fixture: GitFixture): string[] {
  const notes: string[] = [];
  notes.push(
    fixture.capabilities.liveHarness
      ? "live harness ENABLED (paid invocations will run)"
      : "live harness disabled (simulated adapters only)",
  );
  notes.push(
    fixture.capabilities.hostedDelivery
      ? "hosted delivery ENABLED (remote state may change)"
      : "hosted delivery disabled (local-branch only)",
  );
  return notes;
}
