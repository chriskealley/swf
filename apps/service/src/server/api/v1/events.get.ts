import {
  createError,
  createEventStream,
  defineEventHandler,
  getHeader,
} from "h3";
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

  const lastEventId = Number.parseInt(
    getHeader(event, "last-event-id") ?? "0",
    10,
  );
  const subscription = service.subscribe(
    Number.isSafeInteger(lastEventId) && lastEventId >= 0 ? lastEventId : 0,
  );
  const stream = createEventStream(event);
  stream.onClosed(() => subscription.close());
  void (async () => {
    try {
      for await (const update of subscription) {
        await stream.push({
          id: String(update.id),
          event: update.type,
          data: JSON.stringify(update),
        });
      }
    } finally {
      await stream.close();
    }
  })();
  return stream.send();
});
