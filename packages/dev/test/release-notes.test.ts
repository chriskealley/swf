import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  stageReleaseNotes,
  validateReleaseNotes,
} from "../src/release-notes.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("release notes", () => {
  it("stages the reviewed notes for the matching version", async () => {
    const destination = await mkdtemp(join(tmpdir(), "swf-release-notes-"));
    temporaryDirectories.push(destination);

    const staged = await stageReleaseNotes({
      version: "0.1.0",
      source: join(process.cwd(), "docs", "releases", "0.1.0.md"),
      evidenceDirectory: destination,
    });
    const notes = await readFile(staged, "utf8");

    expect(staged).toBe(join(destination, "release-notes.md"));
    expect(notes).toMatch(/^# SWF 0\.1\.0$/m);
    expect(notes).toContain("## Upgrade, downgrade, and stored state");
  });

  it("rejects notes that omit a safety section", () => {
    expect(() =>
      validateReleaseNotes("# SWF 0.1.0\n", "0.1.0", "notes.md"),
    ).toThrow(/Compatibility/);
  });

  it("rejects unfinished editorial markers", () => {
    const notes = [
      "# SWF 0.1.0",
      "## Compatibility",
      "## Upgrade, downgrade, and stored state",
      "## Known limitations",
      "## Verify the release",
      "TBD",
    ].join("\n");

    expect(() => validateReleaseNotes(notes, "0.1.0", "notes.md")).toThrow(
      /TODO or TBD/,
    );
  });
});
