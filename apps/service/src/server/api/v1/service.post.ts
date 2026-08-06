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
  const body = await readBody<{ action?: string; force?: boolean }>(event);
  if (body?.action !== "shutdown")
    throw createError({
      statusCode: 400,
      statusMessage: "Unsupported service action",
    });
  // Respond first; the Nitro process may otherwise close before serializing this response.
  setTimeout(() => void service.shutdown({ force: body.force }), 0);
  return { schemaVersion: 1, status: "accepted" };
});
