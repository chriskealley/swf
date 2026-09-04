import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function validateReleaseNotes(
  notes: string,
  version: string,
  source: string,
): void {
  const requiredSections = [
    `# SWF ${version}`,
    "## Compatibility",
    "## Upgrade, downgrade, and stored state",
    "## Known limitations",
    "## Verify the release",
  ];
  const missing = requiredSections.filter(
    (section) => !notes.includes(section),
  );
  if (missing.length)
    throw new Error(
      `Release notes ${source} are missing: ${missing.join(", ")}`,
    );
  if (/\b(?:TODO|TBD)\b/.test(notes))
    throw new Error(`Release notes ${source} still contain a TODO or TBD`);
}

export async function stageReleaseNotes(input: {
  version: string;
  source: string;
  evidenceDirectory: string;
}): Promise<string> {
  const notes = await readFile(input.source, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT")
        throw new Error(
          `Release notes are required before publication: ${input.source}`,
        );
      throw error;
    },
  );
  validateReleaseNotes(notes, input.version, input.source);

  const destination = join(input.evidenceDirectory, "release-notes.md");
  await writeFile(destination, notes.endsWith("\n") ? notes : `${notes}\n`);
  return destination;
}
