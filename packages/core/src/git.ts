import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: CommandOptions,
  ): Promise<ProcessResult>;
}

export class NodeCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: string[],
    options: CommandOptions = {},
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, options.timeoutMs)
        : undefined;
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr });
      });
    });
  }
}

export class GitCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly result: ProcessResult,
  ) {
    super(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
    this.name = "GitCommandError";
  }
}

export interface GitFileStatus {
  path: string;
  index: string;
  worktree: string;
}

export interface GitStatus {
  branch: string;
  head: string;
  files: GitFileStatus[];
  clean: boolean;
}

export interface RunWorktree {
  branch: string;
  path: string;
  base: string;
}

export class GitClient {
  constructor(
    readonly cwd: string,
    readonly runner: CommandRunner = new NodeCommandRunner(),
  ) {}

  private async git(
    args: string[],
    options: CommandOptions = {},
  ): Promise<ProcessResult> {
    const result = await this.runner.run("git", args, {
      cwd: options.cwd ?? this.cwd,
      timeoutMs: options.timeoutMs,
    });
    if (result.code !== 0) throw new GitCommandError(args, result);
    return result;
  }

  async repositoryRoot(): Promise<string> {
    return (await this.git(["rev-parse", "--show-toplevel"])).stdout.trim();
  }

  async branch(): Promise<string> {
    return (await this.git(["branch", "--show-current"])).stdout.trim();
  }

  async head(): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"])).stdout.trim();
  }

  async status(): Promise<GitStatus> {
    const [branch, head, porcelain] = await Promise.all([
      this.branch(),
      this.head(),
      this.git(["status", "--porcelain=v1", "-z"]),
    ]);
    const records = porcelain.stdout.split("\0").filter(Boolean);
    const files = records.map((record) => ({
      index: record.slice(0, 1),
      worktree: record.slice(1, 2),
      path: record.slice(3),
    }));
    return { branch, head, files, clean: files.length === 0 };
  }

  async isClean(): Promise<boolean> {
    return (await this.status()).clean;
  }

  async diff(base?: string): Promise<string> {
    return (
      await this.git(
        base
          ? ["diff", "--binary", "--no-ext-diff", base]
          : ["diff", "--binary", "--no-ext-diff"],
      )
    ).stdout;
  }

  async createWorktree(input: {
    path: string;
    branch: string;
    base?: string;
  }): Promise<RunWorktree> {
    const base = input.base ?? "HEAD";
    await this.git(["worktree", "add", "-b", input.branch, input.path, base]);
    return { branch: input.branch, path: input.path, base };
  }

  async commit(message: string): Promise<string | undefined> {
    await this.git(["add", "-A"]);
    const staged = await this.runner.run(
      "git",
      ["diff", "--cached", "--quiet"],
      { cwd: this.cwd },
    );
    if (staged.code === 0) return undefined;
    if (staged.code !== 1)
      throw new GitCommandError(["diff", "--cached", "--quiet"], staged);
    await this.git(["commit", "-m", message]);
    return this.head();
  }

  async reset(
    commit: string,
    options: { clean?: boolean } = {},
  ): Promise<void> {
    await this.git(["reset", "--hard", commit]);
    if (options.clean) await this.git(["clean", "-fd"]);
  }

  async removeWorktree(path: string): Promise<void> {
    await this.git(["worktree", "remove", "--force", path]);
  }
}
