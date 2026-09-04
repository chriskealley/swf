#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  auditReleaseWorkflow,
  detectProvenanceContext,
  evaluateVersionPolicy,
  guardPublication,
  isTrustedReleaseEnvironment,
  publicationPlan,
  rollbackPlan,
  type ReleaseChannel,
} from "../packages/dev/src/index.js";
import { repositoryRoot } from "./product-layout.js";

/**
 * Static audit of the release trust boundary.
 *
 * Runs on every pull request, including forks, so a change that would expose
 * publication credentials to untrusted code fails review rather than being
 * discovered at release time.
 */
interface WorkflowAudit {
  file: string;
  violations: string[];
}

async function auditWorkflows(): Promise<WorkflowAudit[]> {
  const directory = join(repositoryRoot, ".github", "workflows");
  const files = await readdir(directory).catch((): string[] => []);
  const audits: WorkflowAudit[] = [];

  for (const file of files.filter((name) => /\.ya?ml$/.test(name))) {
    const contents = await readFile(join(directory, file), "utf8");
    audits.push({ file, violations: auditReleaseWorkflow(contents) });
  }
  return audits;
}

async function main(): Promise<void> {
  process.stdout.write("Release trust boundary\n");
  const audits = await auditWorkflows();
  let failed = false;
  for (const audit of audits) {
    if (!audit.violations.length) {
      process.stdout.write(`  ok   ${audit.file}\n`);
      continue;
    }
    failed = true;
    for (const violation of audit.violations)
      process.stderr.write(`  FAIL ${audit.file}: ${violation}\n`);
  }

  const trusted = isTrustedReleaseEnvironment();
  const provenance = detectProvenanceContext();
  process.stdout.write(
    `  note trusted environment: ${trusted.trusted} (${trusted.reason})\n` +
      `  note provenance available: ${provenance.available}${
        provenance.reason ? ` (${provenance.reason})` : ""
      }\n`,
  );

  // Demonstrate the guard refuses the mistakes that cannot be undone.
  const rehearsals: Array<{ label: string; allowed: boolean }> = [
    {
      label: "prerelease version on the stable channel",
      allowed: guardPublication({
        version: "0.3.0-next.1",
        channel: "stable",
        publishable: true,
        provenanceAvailable: true,
        authorized: true,
        trustedEnvironment: true,
      }).allowed,
    },
    {
      label: "next channel published to the latest tag",
      allowed: guardPublication({
        version: "0.3.0-next.1",
        channel: "next",
        registryTag: "latest",
        publishable: true,
        provenanceAvailable: true,
        authorized: true,
        trustedEnvironment: true,
      }).allowed,
    },
    {
      label: "republishing an existing version",
      allowed: guardPublication({
        version: "0.2.0",
        channel: "stable",
        publishable: true,
        provenanceAvailable: true,
        authorized: true,
        trustedEnvironment: true,
        alreadyPublishedVersions: ["0.2.0"],
      }).allowed,
    },
  ];
  for (const rehearsal of rehearsals) {
    if (rehearsal.allowed) {
      failed = true;
      process.stderr.write(
        `  FAIL guard allowed ${rehearsal.label}, which is unrecoverable\n`,
      );
    } else process.stdout.write(`  ok   guard refuses ${rehearsal.label}\n`);
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Release trust boundary verified\n");
}

export function describeRelease(
  version: string,
  channel: ReleaseChannel,
): string {
  const policy = evaluateVersionPolicy(version, channel);
  const lines = [
    `version ${version} on the ${channel} channel`,
    ...policy.reasons.map((reason) => `  refused: ${reason}`),
    ...policy.notes.map((note) => `  note: ${note}`),
    "",
    "Publication order:",
    ...publicationPlan(version, channel).map(
      (item) =>
        `  ${item.order}. ${item.description}${item.irreversible ? " [irreversible]" : ""}\n     ${item.command}`,
    ),
    "",
    "If publication fails part way:",
    ...rollbackPlan({
      version,
      channel,
      productPublished: true,
      extensionPublished: false,
      tagPushed: false,
    }).steps.map((entry) => `  - ${entry}`),
  ];
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
