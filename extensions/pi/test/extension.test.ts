import { describe, expect, it } from "vitest";
import extension from "../src/index.js";

describe("SWF Pi extension", () => {
  it("registers service-backed tools and operator commands", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    extension({
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
      registerCommand(name: string) {
        commands.push(name);
      },
      on() {},
    } as never);
    expect(tools).toEqual(["swf_query", "swf_command"]);
    expect(commands).toEqual([
      "swf-status",
      "swf-approve",
      "swf-reject",
      "swf-request-changes",
      "swf-input",
      "swf-pause",
      "swf-resume",
      "swf-rollback",
      "swf-cancel",
    ]);
  });
});
