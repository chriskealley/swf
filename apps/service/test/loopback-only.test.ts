import { describe, expect, it } from "vitest";
import { isLocalConnection } from "../src/server/middleware/loopback-only.js";

describe("loopback connection classification", () => {
  it("accepts loopback peers", () => {
    for (const address of [
      "127.0.0.1",
      "127.0.0.53",
      "::1",
      "::ffff:127.0.0.1",
      "[::1]",
    ])
      expect(isLocalConnection(address)).toBe(true);
  });

  it("rejects routable peers", () => {
    for (const address of [
      "192.168.50.48",
      "10.0.0.5",
      "::ffff:192.168.1.10",
      "2001:db8::1",
      "0.0.0.0",
    ])
      expect(isLocalConnection(address)).toBe(false);
  });

  it("treats an absent peer address as a local socket", () => {
    // A TCP peer always reports an address; an absent one means a unix or IPC
    // socket, as used by the Nitro development worker.
    expect(isLocalConnection(undefined)).toBe(true);
    expect(isLocalConnection(null)).toBe(true);
    expect(isLocalConnection("")).toBe(true);
  });
});
