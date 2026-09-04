import { describe, expect, it } from "vitest";
import {
  createFastDevelopmentPlan,
  enableSourceMaps,
  type DevelopmentInstance,
} from "../src/index.js";

const instance: DevelopmentInstance = {
  schemaVersion: 1,
  name: "fast-test",
  mode: "fast",
  checkoutRoot: "/checkout",
  sourceCommit: "a".repeat(40),
  endpoint: "http://127.0.0.1:41001",
  port: 41001,
  dashboardEndpoint: "http://127.0.0.1:41002",
  dashboardPort: 41002,
  serviceHome: "/checkout/.swf-dev/fast-test/service-home",
  logsDirectory: "/checkout/.swf-dev/fast-test/logs",
  packageDirectory: "/checkout/.swf-dev/fast-test/package",
  createdAt: "2026-09-04T00:00:00.000Z",
};

describe("fast development plan", () => {
  it("runs source service and dashboard watchers on isolated endpoints", () => {
    const plan = createFastDevelopmentPlan(instance);

    expect(plan.service.args).toEqual(
      expect.arrayContaining([
        "@swf/service",
        "dev",
        "--host=127.0.0.1",
        "--port=41001",
      ]),
    );
    expect(plan.dashboard.args).toEqual(
      expect.arrayContaining([
        "@swf/dashboard",
        "dev",
        "--host=127.0.0.1",
        "--port=41002",
        "--strictPort",
      ]),
    );
    expect(plan.dashboard.environment.VITE_SWF_ENDPOINT).toBe(
      instance.endpoint,
    );
    expect(plan.service.environment.SWF_SERVICE_HOME).toBe(
      instance.serviceHome,
    );
  });

  it("enables source maps without duplicating the option", () => {
    expect(enableSourceMaps("--trace-warnings")).toBe(
      "--trace-warnings --enable-source-maps",
    );
    expect(enableSourceMaps("--enable-source-maps")).toBe(
      "--enable-source-maps",
    );
  });

  it("requires a dedicated dashboard endpoint", () => {
    expect(() =>
      createFastDevelopmentPlan({
        ...instance,
        dashboardEndpoint: undefined,
        dashboardPort: undefined,
      }),
    ).toThrow(/no dashboard endpoint/);
  });
});
