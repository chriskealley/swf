import { SwfService } from "./swf-service.js";

interface SwfRuntimeGlobal {
  service?: SwfService;
}

const runtimeKey = "__SWF_SERVICE_RUNTIME__";
const runtimeGlobal = globalThis as typeof globalThis & {
  [runtimeKey]?: SwfRuntimeGlobal;
};

function runtime(): SwfRuntimeGlobal {
  return (runtimeGlobal[runtimeKey] ??= {});
}

export async function getService(): Promise<SwfService> {
  const state = runtime();
  state.service ??= new SwfService();
  await state.service.start();
  return state.service;
}

export async function resetServiceForTests(): Promise<void> {
  const state = runtime();
  await state.service?.shutdown({ force: true });
  state.service = undefined;
}
