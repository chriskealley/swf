#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileDigest } from "../packages/dev/src/index.js";
import { repositoryRoot } from "./product-layout.js";

/**
 * Confirms a publication candidate is byte-identical to the artifact that
 * passed verification.
 *
 * Publication jobs never rebuild: they download the verified artifact and
 * publish it. This re-hashes each tarball and refuses promotion if any digest
 * has changed, so what reaches the registry is exactly what was tested.
 */
async function main(): Promise<void> {
  const releaseDirectory = join(repositoryRoot, "dist", "release");
  const promotion = JSON.parse(
    await readFile(join(releaseDirectory, "promotion.json"), "utf8"),
  ) as {
    channel: string;
    artifacts: Array<{ name: string; filename: string; sha256: string }>;
  };

  process.stdout.write(`Promoting the ${promotion.channel} artifacts\n`);
  let failed = false;
  for (const artifact of promotion.artifacts) {
    const path = join(releaseDirectory, artifact.filename);
    const actual = await fileDigest(path).catch(() => undefined);
    if (actual === undefined) {
      process.stderr.write(`  FAIL ${artifact.filename} is missing\n`);
      failed = true;
      continue;
    }
    if (actual !== artifact.sha256) {
      process.stderr.write(
        `  FAIL ${artifact.filename} digest changed since verification\n` +
          `       verified ${artifact.sha256}\n` +
          `       promoted ${actual}\n`,
      );
      failed = true;
      continue;
    }
    process.stdout.write(
      `  ok   ${artifact.name} ${artifact.filename} sha256:${actual.slice(0, 16)}\n`,
    );
  }

  if (failed) {
    process.stderr.write(
      "\nRefusing promotion: run verification again rather than publishing a different artifact.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Promotion candidates match their verified digests\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
