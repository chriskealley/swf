import { createError, defineEventHandler, getRequestIP } from "h3";

const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  return (
    loopbackAddresses.has(normalized) ||
    normalized.startsWith("127.") ||
    normalized === "::ffff:127.0.0.1"
  );
}

/**
 * SWF is a local-first service holding a bearer credential and full project
 * authority. The Nitro node-server preset binds to `NITRO_HOST`/`HOST` and
 * otherwise listens on every interface, so a packaged service launched without
 * those variables would be reachable from the network. The launcher sets an
 * explicit loopback host; this refuses any connection that still arrives from
 * elsewhere, so a misconfigured launch fails closed rather than exposing the
 * service.
 */
export default defineEventHandler((event) => {
  if (isLoopback(getRequestIP(event))) return;
  throw createError({
    statusCode: 403,
    statusMessage: "SWF accepts loopback connections only",
  });
});
