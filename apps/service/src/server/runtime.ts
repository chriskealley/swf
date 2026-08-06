import { SwfService } from "./swf-service.js";

let service: SwfService | undefined;

export async function getService(): Promise<SwfService> {
  if (!service) service = new SwfService();
  await service.start();
  return service;
}

export async function resetServiceForTests(): Promise<void> {
  await service?.shutdown({ force: true });
  service = undefined;
}
