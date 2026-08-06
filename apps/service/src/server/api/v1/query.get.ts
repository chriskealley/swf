import { createError, defineEventHandler, getHeader, getQuery } from "h3";
import { getService } from "../../runtime.js";
import type { ServiceQuery } from "../../swf-service.js";

const resources = new Set<ServiceQuery["resource"]>([
  "projects",
  "runs",
  "run",
  "phases",
  "invocations",
  "artifacts",
  "costs",
  "configuration",
  "delivery",
  "blocked-inputs",
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

  const query = getQuery(event);
  const resource =
    typeof query.resource === "string" ? query.resource : undefined;
  if (!resource || !resources.has(resource as ServiceQuery["resource"])) {
    throw createError({
      statusCode: 400,
      statusMessage: "A supported resource query is required",
    });
  }
  try {
    const result = await service.query({
      resource: resource as ServiceQuery["resource"],
      projectId:
        typeof query.projectId === "string" ? query.projectId : undefined,
      runId: typeof query.runId === "string" ? query.runId : undefined,
    });
    return { schemaVersion: 1, result };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : "Invalid query",
    });
  }
});
