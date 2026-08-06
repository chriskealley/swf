#!/usr/bin/env node
import { spawn } from "node:child_process";
import { defineCommand, runMain } from "citty";
import consola from "consola";
import { detectPackageManager } from "nypm";
import {
  applySetupPlan,
  createSetupPlan,
  initializeProject,
  runDoctor,
  type CheckStatus,
  type SetupAction,
} from "@swf/core";

function icon(status: CheckStatus): string {
  return { pass: "✓", fail: "✗", warn: "!", skip: "-" }[status];
}

const doctor = defineCommand({
  meta: {
    name: "doctor",
    description: "Check SWF prerequisites without making changes",
  },
  args: {
    json: { type: "boolean", description: "Write machine-readable JSON" },
    harness: {
      type: "string",
      description: "Additional selected harness to check",
    },
  },
  async run({ args }) {
    const selectedHarnesses = args.harness ? [args.harness] : [];
    const checks = await runDoctor({
      selectedHarnesses: selectedHarnesses as never[],
    });
    if (args.json) {
      console.log(JSON.stringify({ schemaVersion: 1, checks }, null, 2));
      return;
    }
    for (const check of checks) {
      consola.log(`${icon(check.status)} ${check.id}: ${check.summary}`);
      if (check.remediation) consola.info(`  ${check.remediation}`);
    }
    if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
  },
});

const setup = defineCommand({
  meta: {
    name: "setup",
    description:
      "Preview or explicitly apply supported prerequisite remediation",
  },
  args: {
    install: {
      type: "positional",
      description: "Dependency or herdr-integration:<name>",
      required: true,
    },
    apply: { type: "boolean", description: "Apply the shown plan" },
    yes: { type: "boolean", description: "Confirm every installation action" },
    json: { type: "boolean", description: "Write machine-readable JSON" },
  },
  async run({ args }) {
    const plan = createSetupPlan([args.install]);
    const packageManager = await detectPackageManager(process.cwd());
    if (!args.apply) {
      const output = {
        schemaVersion: 1,
        packageManager: packageManager?.name,
        plan,
      };
      if (args.json) console.log(JSON.stringify(output, null, 2));
      else {
        for (const action of plan.actions) {
          consola.info(
            `${action.summary}\n  source: ${action.source}\n  version: ${action.version}\n  destination: ${action.destination}\n  command: ${action.command} ${action.args.join(" ")}`,
          );
        }
        for (const target of plan.unsupported) {
          consola.warn(
            `${target} requires manual platform-specific installation guidance.`,
          );
        }
        consola.info(
          "Review this plan, then rerun with --apply --yes to execute it.",
        );
      }
      return;
    }

    if (!args.yes)
      throw new Error(
        "Refusing setup without --yes. Review the plan first by omitting --apply.",
      );
    const result = await applySetupPlan(plan, {
      confirm: async (_action: SetupAction) => true,
      execute: async (command, commandArgs) =>
        new Promise((resolve) => {
          const child = spawn(command, commandArgs, {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on(
            "data",
            (data: Buffer) => (stdout += data.toString()),
          );
          child.stderr.on(
            "data",
            (data: Buffer) => (stderr += data.toString()),
          );
          child.on("close", (code) =>
            resolve({ code: code ?? 1, stdout, stderr }),
          );
        }),
    });
    const verification = await runDoctor();
    if (args.json)
      console.log(
        JSON.stringify({ schemaVersion: 1, result, verification }, null, 2),
      );
    else {
      for (const item of result.results) {
        consola.log(`${item.applied ? "✓" : "✗"} ${item.action.id}`);
        if (item.stderr) consola.error(item.stderr);
      }
      for (const check of verification.filter(
        (check) => check.status === "fail",
      )) {
        consola.error(`Verification failed: ${check.id}: ${check.summary}`);
      }
    }
    if (
      result.results.some((item) => !item.applied) ||
      result.unsupported.length > 0 ||
      verification.some((check) => check.status === "fail")
    )
      process.exitCode = 1;
  },
});

const init = defineCommand({
  meta: {
    name: "init",
    description: "Initialize committed SWF project configuration",
  },
  args: {
    cwd: {
      type: "string",
      description: "Project directory (defaults to current directory)",
    },
    trust: {
      type: "boolean",
      description: "Explicitly trust this project before writing configuration",
    },
    json: { type: "boolean", description: "Write machine-readable JSON" },
  },
  async run({ args }) {
    const result = await initializeProject({
      cwd: args.cwd,
      trust: args.trust,
    });
    if (args.json) {
      console.log(JSON.stringify({ schemaVersion: 1, result }, null, 2));
      return;
    }
    if (result.status === "untrusted") {
      consola.warn(`Project is not trusted: ${result.project.root}`);
      consola.info("Rerun with swf init --trust after reviewing the project.");
      process.exitCode = 1;
      return;
    }
    if (result.status === "already-initialized") {
      consola.warn(
        `SWF configuration already exists: ${result.conflicts.join(", ")}`,
      );
      return;
    }
    consola.success(`Initialized SWF in ${result.project.root}`);
    for (const path of result.created) consola.log(`  created ${path}`);
  },
});

const main = defineCommand({
  meta: {
    name: "swf",
    version: "0.1.0",
    description: "Agentic software factory",
  },
  subCommands: { doctor, init, setup },
});

await runMain(main);
