import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor, type CommandResult } from "../src/doctor.js";

const success = (stdout: string): CommandResult => ({
  status: 0,
  stdout,
  stderr: "",
});

describe("runDoctor", () => {
  it("reports missing required executables without changing the system", async () => {
    const checks = await runDoctor({
      cwd: process.cwd(),
      environment: { PATH: "" },
      selectedHarnesses: ["codex"],
      execute: () => ({ status: 1, stdout: "", stderr: "missing" }),
    });

    expect(checks.find((check) => check.id === "tool.node")).toMatchObject({
      status: "fail",
    });
    expect(checks.find((check) => check.id === "tool.codex")).toMatchObject({
      status: "warn",
    });
  });

  it("detects incompatible required versions and missing selected optional harnesses", async () => {
    const checks = await runDoctor({
      cwd: process.cwd(),
      environment: { PATH: process.env.PATH },
      selectedHarnesses: ["codex"],
      execute: (command, args) => {
        if (args[0] === "--version")
          return success(
            command === "node" ? "node 1.0.0" : `${command} 99.0.0`,
          );
        if (command === "git" && args[0] === "rev-parse")
          return success("true\n");
        if (command === "git" && args[0] === "remote")
          return success("https://github.com/example/swf.git\n");
        if (command === "gh") return success("Logged in\n");
        if (command === "herdr")
          return success("pi: current (v5) (/tmp/herdr-agent-state.ts)\n");
        return success("");
      },
    });

    expect(checks.find((check) => check.id === "tool.node")).toMatchObject({
      status: "fail",
    });
    expect(
      checks.find((check) => check.id === "herdr.integration.codex"),
    ).toMatchObject({ status: "warn" });
  });

  it("fails a selected harness whose version changed below compatibility", async () => {
    const tools = await mkdtemp(join(tmpdir(), "swf-doctor-tools-"));
    await writeFile(join(tools, "codex"), "");
    try {
      const checks = await runDoctor({
        cwd: process.cwd(),
        environment: {
          PATH: `${tools}${delimiter}${process.env.PATH ?? ""}`,
        },
        selectedHarnesses: ["codex"],
        execute: (command, args) => {
          if (args[0] === "--version")
            return success(
              command === "codex" ? "codex 0.1.0" : `${command} 99.0.0`,
            );
          if (command === "git" && args[0] === "rev-parse")
            return success("true\n");
          if (command === "git" && args[0] === "remote")
            return success("https://github.com/example/swf.git\n");
          if (command === "gh") return success("Logged in\n");
          if (command === "herdr")
            return success("pi: installed\ncodex: installed\n");
          return success("");
        },
      });
      expect(checks.find((check) => check.id === "tool.codex")).toMatchObject({
        status: "fail",
      });
    } finally {
      await rm(tools, { recursive: true, force: true });
    }
  });

  it("reports unauthenticated GitHub and missing Herdr integration", async () => {
    const execute = (command: string, args: string[]): CommandResult => {
      if (args[0] === "--version") return success(`${command} 99.0.0`);
      if (command === "git" && args[0] === "rev-parse")
        return success("true\n");
      if (command === "git" && args[0] === "remote")
        return success("https://github.com/example/swf.git\n");
      if (command === "gh")
        return { status: 1, stdout: "", stderr: "not logged in" };
      if (command === "herdr") return success("pi: not installed\n");
      return success("");
    };

    const checks = await runDoctor({
      cwd: process.cwd(),
      environment: { PATH: process.env.PATH },
      execute,
    });

    expect(
      checks.find((check) => check.id === "github.authentication"),
    ).toMatchObject({ status: "fail" });
    expect(
      checks.find((check) => check.id === "herdr.integration.pi"),
    ).toMatchObject({ status: "warn" });
  });

  it("detects required versions, GitHub authentication, and missing Herdr integration", async () => {
    const execute = (command: string, args: string[]): CommandResult => {
      if (args[0] === "--version") return success(`${command} 99.0.0`);
      if (command === "git" && args[0] === "rev-parse")
        return success("true\n");
      if (command === "git" && args[0] === "remote")
        return success("https://github.com/example/swf.git\n");
      if (command === "gh") return success("Logged in\n");
      if (command === "herdr") return success("pi: not installed\n");
      return success("");
    };

    const checks = await runDoctor({
      cwd: process.cwd(),
      environment: { PATH: process.env.PATH },
      execute,
    });

    expect(checks.find((check) => check.id === "tool.node")).toMatchObject({
      status: "pass",
    });
    expect(
      checks.find((check) => check.id === "github.authentication"),
    ).toMatchObject({ status: "pass" });
    expect(
      checks.find((check) => check.id === "herdr.integration.pi"),
    ).toMatchObject({ status: "warn" });
  });
});
