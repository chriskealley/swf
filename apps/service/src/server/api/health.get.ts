import { defineEventHandler } from "h3";
import { resolveServiceProductMetadata } from "../swf-service.js";

/**
 * Unauthenticated so a client can complete the compatibility handshake before
 * presenting a credential. Reports build and compatibility identity only —
 * never the service credential or any operational state.
 */
export default defineEventHandler(async () => {
  const product = await resolveServiceProductMetadata();
  return {
    schemaVersion: 1,
    status: "ok",
    product: {
      productVersion: product.build.productVersion,
      channel: product.build.channel,
      sourceCommit: product.build.sourceCommit,
      sourceDirty: product.build.sourceDirty,
    },
    compatibility: product.compatibility,
  };
});
