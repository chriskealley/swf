/**
 * `engines` is advisory for npm installs — it warns and installs anyway — so the
 * executable must enforce its own baseline. Runs before any module that may use
 * newer syntax, otherwise the user sees a SyntaxError instead of this message.
 */
export function nodeVersionFailure(
  runtimeVersion: string,
  minimumMajor: number,
): string | undefined {
  const normalized = runtimeVersion.startsWith("v")
    ? runtimeVersion.slice(1)
    : runtimeVersion;
  const major = Number.parseInt(normalized.split(".")[0] ?? "", 10);
  if (Number.isNaN(major))
    return `swf could not determine the running Node version (${runtimeVersion}). Node >=${minimumMajor} is required.`;
  if (major < minimumMajor)
    return [
      `swf requires Node >=${minimumMajor}, but found ${runtimeVersion}.`,
      `Install a supported Node release, then run swf again.`,
    ].join("\n");
  return undefined;
}

export const MINIMUM_NODE_MAJOR = 24;

export function assertSupportedNode(
  runtimeVersion = process.version,
  minimumMajor = MINIMUM_NODE_MAJOR,
  fail: (message: string) => never = (message) => {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  },
): void {
  const failure = nodeVersionFailure(runtimeVersion, minimumMajor);
  if (failure) fail(failure);
}
