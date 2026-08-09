import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("dashboard operator contract", () => {
  it("provides accessible structure and keyboard-visible retained output", () => {
    expect(app).toContain('href="#content"');
    expect(app).toContain('aria-live="polite"');
    expect(app).toContain('role="alert"');
    expect(app).toContain('aria-label="Run controls"');
    expect(app).toContain('<pre tabindex="0">');
    expect(app).toContain("Retrieve raw output");
  });

  it("does not persist credentials and requires confirmation for destructive controls", () => {
    expect(`${app}\n${api}`).not.toMatch(
      /localStorage|sessionStorage|document\.cookie/,
    );
    expect(app).toContain('window.confirm("Cancel this run?');
    expect(app).toContain("Confirm permanent pruning");
    expect(api).toContain("only sends credentials to a local HTTP service");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("object-src 'none'");
  });

  it("renders unavailable projects, stale clients, costs, and live reconnect state", () => {
    expect(app).toContain("Project unavailable");
    expect(app).toContain("This dashboard is stale");
    expect(app).toContain("formatInvocationCost");
    expect(app).toContain("formatAggregateCosts");
    expect(app).toContain("reconnecting");
    expect(app).toContain("Installed adapters");
    expect(app).toContain("capabilityNames");
    expect(api).toContain('headers.set("last-event-id"');
  });
});
