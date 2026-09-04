import { createServer } from "node:net";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { z } from "zod";

/** Development state lives below the checkout so it is never mistaken for user state. */
export const DEVELOPMENT_DIRECTORY = ".swf-dev";

/**
 * The installed user service. Development instances must never adopt this
 * endpoint or home, or a contributor's experiment would mutate real projects.
 */
export const INSTALLED_SERVICE_PORT = 34671;

export const DevelopmentModeSchema = z.enum(["fast", "preview"]);

export const DevelopmentInstanceSchema = z.object({
  schemaVersion: z.literal(1),
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "instance names must be kebab-case"),
  mode: DevelopmentModeSchema,
  checkoutRoot: z.string().min(1),
  sourceCommit: z.string().min(1),
  endpoint: z.string().url(),
  port: z.number().int().positive(),
  dashboardEndpoint: z.string().url().optional(),
  dashboardPort: z.number().int().positive().optional(),
  serviceHome: z.string().min(1),
  logsDirectory: z.string().min(1),
  packageDirectory: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  pid: z.number().int().positive().optional(),
  startedAt: z.string().datetime({ offset: true }).optional(),
});

export type DevelopmentInstance = z.infer<typeof DevelopmentInstanceSchema>;

export interface InstancePaths {
  root: string;
  serviceHome: string;
  logsDirectory: string;
  packageDirectory: string;
  metadataPath: string;
}

export function developmentRoot(checkoutRoot: string): string {
  return join(checkoutRoot, DEVELOPMENT_DIRECTORY);
}

export function instancePaths(
  checkoutRoot: string,
  name: string,
): InstancePaths {
  const root = join(developmentRoot(checkoutRoot), name);
  return {
    root,
    serviceHome: join(root, "service-home"),
    logsDirectory: join(root, "logs"),
    packageDirectory: join(root, "package"),
    metadataPath: join(root, "instance.json"),
  };
}

/**
 * Asks the OS for a free loopback port. Binding to `127.0.0.1` rather than all
 * interfaces means a reported port is only claimed to be free on loopback,
 * which is the only interface a development instance listens on.
 */
export async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }
      const { port } = address;
      server.close(() =>
        port === INSTALLED_SERVICE_PORT
          ? reject(
              new Error(
                `Allocated the installed service port ${INSTALLED_SERVICE_PORT}`,
              ),
            )
          : resolve(port),
      );
    });
  });
}

export interface CreateInstanceInput {
  checkoutRoot: string;
  name: string;
  mode: DevelopmentInstance["mode"];
  sourceCommit: string;
  port?: number;
  now?: string;
}

export class InstanceExistsError extends Error {
  constructor(readonly name: string) {
    super(`Development instance ${name} already exists`);
    this.name = "InstanceExistsError";
  }
}

export class InstanceNotFoundError extends Error {
  constructor(readonly name: string) {
    super(`No development instance named ${name}`);
    this.name = "InstanceNotFoundError";
  }
}

/**
 * Creates an instance with its own service home, logs, package directory, and
 * loopback endpoint. Nothing outside the checkout is read or written, so an
 * installed service and its user state are untouched.
 */
export async function createInstance(
  input: CreateInstanceInput,
): Promise<DevelopmentInstance> {
  const paths = instancePaths(input.checkoutRoot, input.name);
  const existing = await readInstance(input.checkoutRoot, input.name).catch(
    () => undefined,
  );
  if (existing) throw new InstanceExistsError(input.name);

  const port = input.port ?? (await allocateLoopbackPort());
  if (port === INSTALLED_SERVICE_PORT)
    throw new Error(
      `Refusing to use the installed service port ${INSTALLED_SERVICE_PORT}`,
    );

  let dashboardPort: number | undefined;
  if (input.mode === "fast") {
    dashboardPort = await allocateLoopbackPort();
    while (dashboardPort === port) dashboardPort = await allocateLoopbackPort();
  }

  const instance = DevelopmentInstanceSchema.parse({
    schemaVersion: 1,
    name: input.name,
    mode: input.mode,
    checkoutRoot: input.checkoutRoot,
    sourceCommit: input.sourceCommit,
    endpoint: `http://127.0.0.1:${port}`,
    port,
    dashboardEndpoint:
      dashboardPort === undefined
        ? undefined
        : `http://127.0.0.1:${dashboardPort}`,
    dashboardPort,
    serviceHome: paths.serviceHome,
    logsDirectory: paths.logsDirectory,
    packageDirectory: paths.packageDirectory,
    createdAt: input.now ?? new Date().toISOString(),
  } satisfies DevelopmentInstance);

  for (const directory of [
    paths.root,
    paths.serviceHome,
    paths.logsDirectory,
    paths.packageDirectory,
  ])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeInstance(instance);
  return instance;
}

/** Adds the dashboard endpoint to metadata created before fast mode owned it. */
export async function ensureFastDashboardEndpoint(
  instance: DevelopmentInstance,
): Promise<DevelopmentInstance> {
  if (instance.dashboardEndpoint && instance.dashboardPort) return instance;
  let dashboardPort = await allocateLoopbackPort();
  while (dashboardPort === instance.port)
    dashboardPort = await allocateLoopbackPort();
  const updated = DevelopmentInstanceSchema.parse({
    ...instance,
    dashboardPort,
    dashboardEndpoint: `http://127.0.0.1:${dashboardPort}`,
  });
  await writeInstance(updated);
  return updated;
}

export async function writeInstance(
  instance: DevelopmentInstance,
): Promise<void> {
  const paths = instancePaths(instance.checkoutRoot, instance.name);
  await writeFile(
    paths.metadataPath,
    `${JSON.stringify(instance, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export async function readInstance(
  checkoutRoot: string,
  name: string,
): Promise<DevelopmentInstance> {
  const paths = instancePaths(checkoutRoot, name);
  try {
    return DevelopmentInstanceSchema.parse(
      JSON.parse(await readFile(paths.metadataPath, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new InstanceNotFoundError(name);
    throw error;
  }
}

export async function listInstances(
  checkoutRoot: string,
): Promise<DevelopmentInstance[]> {
  let names: string[];
  try {
    names = (
      await readdir(developmentRoot(checkoutRoot), { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const instances: DevelopmentInstance[] = [];
  for (const name of names.sort()) {
    const instance = await readInstance(checkoutRoot, name).catch(
      () => undefined,
    );
    if (instance) instances.push(instance);
  }
  return instances;
}

/**
 * Removes only the selected instance's directory. Cleanup never reaches user
 * state, another instance, or anything outside the checkout's dev root.
 */
export async function removeInstance(
  checkoutRoot: string,
  name: string,
): Promise<string> {
  const paths = instancePaths(checkoutRoot, name);
  const root = developmentRoot(checkoutRoot);
  if (!paths.root.startsWith(root + sep))
    throw new Error(`Refusing to remove a path outside ${root}`);
  await readInstance(checkoutRoot, name);
  await rm(paths.root, { recursive: true, force: true });
  return paths.root;
}

/**
 * Environment for a child service process. Both home variables are set so the
 * instance cannot fall back to `~/.config/swf`, and the host is pinned to
 * loopback so the development service is never network-reachable.
 */
export function instanceEnvironment(
  instance: DevelopmentInstance,
): Record<string, string> {
  return {
    SWF_SERVICE_HOME: instance.serviceHome,
    SWF_CONFIG_HOME: instance.serviceHome,
    HOST: "127.0.0.1",
    NITRO_HOST: "127.0.0.1",
    PORT: String(instance.port),
    NITRO_PORT: String(instance.port),
  };
}
