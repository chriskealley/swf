import { createError, defineEventHandler } from "h3";

const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLocalConnection(address: string | undefined | null): boolean {
  // A TCP connection always reports a peer address. An absent one means the
  // request did not arrive over the network at all — a unix or IPC socket, as
  // used by the Nitro development worker — which cannot be reached remotely.
  if (address === undefined || address === null || address === "") return true;
  const normalized = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  return (
    loopbackAddresses.has(normalized) ||
    normalized.startsWith("127.") ||
    normalized.startsWith("::ffff:127.")
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
  // Read the socket directly rather than through `getRequestIP`, which also
  // consults caller-supplied forwarding headers. A remote client must not be
  // able to claim a loopback address by setting a header.
  if (isLocalConnection(event.node.req.socket.remoteAddress)) return;
  throw createError({
    statusCode: 403,
    statusMessage: "SWF accepts loopback connections only",
  });
});
