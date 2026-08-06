import { createError, defineEventHandler, getHeader, readBody } from "h3";
import { getService } from "../../runtime.js";

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
  const body = await readBody<{
    projectId?: string;
    displayName?: string;
    root?: string;
  }>(event);
  if (!body?.projectId || !body.displayName || !body.root) {
    throw createError({
      statusCode: 400,
      statusMessage: "projectId, displayName, and root are required",
    });
  }
  return {
    schemaVersion: 1,
    project: await service.registerProject({
      projectId: body.projectId,
      displayName: body.displayName,
      root: body.root,
    }),
  };
});
