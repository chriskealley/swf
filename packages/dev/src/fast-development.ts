import { join } from "node:path";
import { instanceEnvironment, type DevelopmentInstance } from "./instance.js";

export interface FastDevelopmentProcess {
  command: string;
  args: string[];
  environment: Record<string, string>;
}

export interface FastDevelopmentPlan {
  service: FastDevelopmentProcess;
  dashboard: FastDevelopmentProcess;
  cli: FastDevelopmentProcess;
  watchRoots: string[];
}

export function enableSourceMaps(nodeOptions = ""): string {
  const options = nodeOptions.split(/\s+/).filter(Boolean);
  if (!options.includes("--enable-source-maps"))
    options.push("--enable-source-maps");
  return options.join(" ");
}

/**
 * Describes every process in a fast development session. The service and
 * dashboard share only the selected instance identity; neither can fall back
 * to the installed user's endpoint or state.
 */
export function createFastDevelopmentPlan(
  instance: DevelopmentInstance,
): FastDevelopmentPlan {
  if (!instance.dashboardEndpoint || !instance.dashboardPort)
    throw new Error(
      `Fast development instance ${instance.name} has no dashboard endpoint`,
    );

  const isolated = instanceEnvironment(instance);
  const sourceEnvironment = {
    ...isolated,
    NODE_OPTIONS: enableSourceMaps(process.env.NODE_OPTIONS),
  };
  return {
    service: {
      command: "pnpm",
      args: [
        "--filter",
        "@swf/service",
        "dev",
        "--host=127.0.0.1",
        `--port=${instance.port}`,
      ],
      environment: sourceEnvironment,
    },
    dashboard: {
      command: "pnpm",
      args: [
        "--filter",
        "@swf/dashboard",
        "dev",
        "--host=127.0.0.1",
        `--port=${instance.dashboardPort}`,
        "--strictPort",
      ],
      environment: {
        ...sourceEnvironment,
        VITE_SWF_ENDPOINT: instance.endpoint,
      },
    },
    cli: {
      command: "pnpm",
      args: ["swf"],
      environment: sourceEnvironment,
    },
    watchRoots: [
      join(instance.checkoutRoot, "apps", "service", "src"),
      join(instance.checkoutRoot, "packages", "core", "src"),
      join(instance.checkoutRoot, "packages", "integrations", "src"),
    ],
  };
}
