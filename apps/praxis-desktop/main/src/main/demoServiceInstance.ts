import { DemoService } from '@praxis/core';

let instance: DemoService | undefined;

/** Single shared DemoService instance for the Board and Issue Detail slices. */
export function getDemoService(): DemoService {
  if (!instance) {
    instance = new DemoService({ getDefaultPageSize: () => 25 });
  }
  return instance;
}
