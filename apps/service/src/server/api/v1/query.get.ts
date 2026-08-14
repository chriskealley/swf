import { createError, defineEventHandler, getHeader, getQuery } from "h3";
import { getService } from "../../runtime.js";
import type { ServiceQuery } from "../../swf-service.js";
import { classifyOperatorError } from "@swf/core";

const resources = new Set<ServiceQuery["resource"]>([
  "overview",
  "adapters",
  "projects",
  "runs",
  "run",
  "phases",
  "invocations",
  "artifacts",
  "approvals",
  "costs",
  "configuration",
  "delivery",
  "output",
  "native-output",
  "invocation-diagnostics",
  "budgets",
  "operations",
  "blocked-inputs",
  "explorations",
  "exploration",
  "model-routes",
  "phase-explanation",
  "operator-projection",
  "check-discovery",
  "defaults",
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
      ref: typeof query.ref === "string" ? query.ref : undefined,
      invocationId:
        typeof query.invocationId === "string" ? query.invocationId : undefined,
      cursor:
        typeof query.cursor === "string" ? Number(query.cursor) : undefined,
      limit: typeof query.limit === "string" ? Number(query.limit) : undefined,
      maxBytes:
        typeof query.maxBytes === "string" ? Number(query.maxBytes) : undefined,
      raw: query.raw === "true",
      phaseId: typeof query.phaseId === "string" ? query.phaseId : undefined,
    });
    return { schemaVersion: 1, result };
  } catch (error) {
    event.node.res.statusCode = 400;
    return { schemaVersion: 1, error: classifyOperatorError({ error }) };
  }
});
