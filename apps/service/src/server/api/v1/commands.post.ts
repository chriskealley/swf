import { createError, defineEventHandler, getHeader, readBody } from "h3";
import { getService } from "../../runtime.js";
import type { ServiceCommand } from "../../swf-service.js";

const commandTypes = new Set<ServiceCommand["type"]>([
  "start",
  "pause",
  "resume",
  "cancel",
  "approve",
  "reject",
  "remediate",
  "rollback",
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
    await service.command(command as ServiceCommand);
    return { schemaVersion: 1, status: "accepted" };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : "Invalid command",
    });
  }
});
