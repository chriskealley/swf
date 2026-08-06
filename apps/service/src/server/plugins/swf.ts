import { defineNitroPlugin } from "nitropack/runtime/plugin";
import { getService } from "../runtime.js";

export default defineNitroPlugin(async () => {
  await getService();
});
