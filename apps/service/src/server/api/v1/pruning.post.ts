import { createError, defineEventHandler, getHeader, readBody } from "h3";
import { getService } from "../../runtime.js";
import type { PruningCriteria } from "../../swf-service.js";

interface PruningRequest {
  projectId?: string;
  criteria?: PruningCriteria;
  confirmationId?: string;
}

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

  const body = await readBody<PruningRequest>(event);
  if (!body?.projectId)
    throw createError({
      statusCode: 400,
      statusMessage: "projectId is required",
    });
  try {
    const result = body.confirmationId
      ? await service.confirmPruning(body.projectId, body.confirmationId)
      : await service.previewPruning(body.projectId, body.criteria ?? {});
    return { schemaVersion: 1, result };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage:
        error instanceof Error ? error.message : "Invalid pruning request",
    });
  }
});
