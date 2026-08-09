import { createError, defineEventHandler, getHeader, setHeaders } from "h3";

function localOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(host)
    );
  } catch {
    return false;
  }
}

export default defineEventHandler((event) => {
  if (!event.path.startsWith("/api/")) return;
  const origin = getHeader(event, "origin");
  if (!origin) return;
  if (!localOrigin(origin))
    throw createError({
      statusCode: 403,
      statusMessage: "Dashboard origin must be local",
    });
  setHeaders(event, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers":
      "Authorization, Content-Type, Last-Event-ID",
    vary: "Origin",
  });
  if (event.method === "OPTIONS") {
    event.node.res.statusCode = 204;
    event.node.res.end();
  }
});
