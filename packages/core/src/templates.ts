import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TemplateMetadataSchema, type DocumentValue } from "./schemas.js";

export type TemplateMetadata = DocumentValue<"templateMetadata">;
export type TemplateFileStatus =
  "unchanged" | "project-only" | "upstream-only" | "removed" | "conflict";
export interface TemplateDiffEntry {
  path: string;
  status: TemplateFileStatus;
  adoptedHash?: string;
  projectHash?: string;
  installedHash?: string;
}

function hash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export function createTemplateMetadata(input: {
  version: string;
  files: Record<string, string>;
}): TemplateMetadata {
  return TemplateMetadataSchema.parse({
    schemaVersion: 1,
    templateVersion: input.version,
    files: Object.fromEntries(
      Object.entries(input.files).map(([path, contents]) => [
        path,
        hash(contents),
      ]),
    ),
  });
}

export async function readTemplateMetadata(
  configDirectory: string,
): Promise<TemplateMetadata | undefined> {
  try {
    return TemplateMetadataSchema.parse(
      JSON.parse(
        await readFile(join(configDirectory, "template.json"), "utf8"),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function inspectTemplateDiff(input: {
  configDirectory: string;
  adopted?: TemplateMetadata;
  installed: Record<string, string | undefined>;
}): Promise<TemplateDiffEntry[]> {
  const adopted = input.adopted?.files ?? {};
  const paths = new Set([
    ...Object.keys(adopted),
    ...Object.keys(input.installed),
  ]);
  const result: TemplateDiffEntry[] = [];
  for (const path of [...paths].sort()) {
    const installedContents = input.installed[path];
    let projectContents: string | undefined;
    try {
      projectContents = await readFile(
        join(input.configDirectory, path),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const adoptedHash = adopted[path];
    const projectHash =
      projectContents === undefined ? undefined : hash(projectContents);
    const installedHash =
      installedContents === undefined ? undefined : hash(installedContents);
    let status: TemplateFileStatus;
    if (installedContents === undefined)
      status =
        projectContents === undefined
          ? "unchanged"
          : adoptedHash && projectHash === adoptedHash
            ? "removed"
            : "project-only";
    else if (projectContents === undefined)
      status = installedContents === undefined ? "unchanged" : "upstream-only";
    else if (!adoptedHash)
      status = projectHash === installedHash ? "unchanged" : "conflict";
    else if (projectHash === adoptedHash && installedHash !== adoptedHash)
      status = "upstream-only";
    else if (projectHash !== adoptedHash && installedHash === adoptedHash)
      status = "project-only";
    else if (projectHash === installedHash) status = "unchanged";
    else status = "conflict";
    result.push({ path, status, adoptedHash, projectHash, installedHash });
  }
  return result;
}

export async function restoreTemplateBackup(input: {
  configDirectory: string;
  backupDirectory: string;
  selectedPaths: string[];
}): Promise<string[]> {
  const restored: string[] = [];
  for (const path of input.selectedPaths) {
    let contents: string;
    try {
      contents = await readFile(join(input.backupDirectory, path), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await atomicWrite(join(input.configDirectory, path), contents);
    restored.push(path);
  }
  return restored;
}

export async function adoptTemplateFiles(input: {
  configDirectory: string;
  metadata: TemplateMetadata;
  installed: Record<string, string>;
  selectedPaths: string[];
  diff: TemplateDiffEntry[];
  backupDirectory: string;
}): Promise<{ adopted: string[]; backupDirectory: string }> {
  const selected = new Set(input.selectedPaths);
  const conflicts = input.diff.filter(
    ({ path, status }) => selected.has(path) && status === "conflict",
  );
  if (conflicts.length)
    throw new Error(
      `Template adoption has unresolved conflicts: ${conflicts.map(({ path }) => path).join(", ")}`,
    );
  const adopted: string[] = [];
  for (const path of input.selectedPaths) {
    const contents = input.installed[path];
    if (contents === undefined) continue;
    const target = join(input.configDirectory, path);
    try {
      const current = await readFile(target, "utf8");
      await atomicWrite(join(input.backupDirectory, path), current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomicWrite(target, contents);
    adopted.push(path);
  }
  const next = {
    ...input.metadata,
    files: { ...input.metadata.files },
  };
  for (const path of adopted) next.files[path] = hash(input.installed[path]!);
  await atomicWrite(
    join(input.configDirectory, "template.json"),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  return { adopted, backupDirectory: input.backupDirectory };
}
