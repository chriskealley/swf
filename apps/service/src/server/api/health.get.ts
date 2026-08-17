import { defineEventHandler } from "h3";
import { getService } from "../runtime.js";
import { resolveServiceProductMetadata } from "../swf-service.js";

/**
 * Unauthenticated so a client can complete the compatibility handshake before
 * presenting a credential. Reports build and compatibility identity only —
 * never the service credential or any operational state.
 *
 * The HTTP route is served by Nitro as soon as the process listens, which is
 * not the same as SWF owning its state directory. A start that loses the
 * ownership lock would otherwise look healthy, so readiness is reported
 * explicitly rather than implied by a 200.
 */
export default defineEventHandler(async () => {
  const product = await resolveServiceProductMetadata();
  const identity = {
    schemaVersion: 1,
    product: {
      productVersion: product.build.productVersion,
      channel: product.build.channel,
      sourceCommit: product.build.sourceCommit,
      sourceDirty: product.build.sourceDirty,
    },
    compatibility: product.compatibility,
  };
  try {
    await getService();
    return { ...identity, status: "ok", ready: true };
  } catch (error) {
    return {
      ...identity,
      status: "unavailable",
      ready: false,
      // Names the failure class only; never the credential or state contents.
      reason:
        error instanceof Error ? error.message : "service failed to start",
    };
  }
});
