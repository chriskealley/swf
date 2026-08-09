import { createError, defineEventHandler, getHeader, readBody } from "h3";
import { getService } from "../../runtime.js";
import type { ServiceCommand } from "../../swf-service.js";

const commandTypes = new Set<ServiceCommand["type"]>([
  "new",
  "run",
  "next",
  "phase-run",
  "phase-rerun",
  "phase-skip",
  "check-run",
  "explore-start",
  "explore-resume",
  "explore-cancel",
  "explore-answer",
  "explore-discard",
  "explore-promote",
  "start",
  "pause",
  "resume",
  "cancel",
  "approve",
  "reject",
  "request-changes",
  "remediate",
  "rollback",
  "blocked-input",
  "deliver",
  "refresh-delivery",
  "reconcile",
  "migrate",
  "export-run",
  "import-run",
]);

export default defineEventHandler(async (event) => {
  const service = await getService();
  const authorization = getHeader(event, "authorization");
  const credential = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  try {
    service.authenticate(credential);
  } catch {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  const command = await readBody<Partial<ServiceCommand>>(event);
  if (
    !command ||
    typeof command.type !== "string" ||
    !commandTypes.has(command.type as ServiceCommand["type"])
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: "A supported command is required",
    });
  }
  try {
    const result = await service.command(command as ServiceCommand);
    return { schemaVersion: 1, status: "accepted", result };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : "Invalid command",
    });
  }
});
