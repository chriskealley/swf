/**
 * swf - Minimal pi extension
 *
 * Registers a "swf" tool that returns "hello swf" when run.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const swfTool = defineTool({
  name: "swf",
  label: "SWF",
  description: "Returns a hello message from swf",
  parameters: Type.Object({}),

  async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
    return {
      content: [{ type: "text", text: "hello swf" }],
      details: {},
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(swfTool);
}
