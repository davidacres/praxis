import { DemoService } from '@praxis/core';

let instance: DemoService | undefined;

/** Demo fixtures are opt-in so a normal desktop launch starts with real data only. */
export function isDemoModeEnabled(): boolean {
  return process.argv.includes('--demo') || process.env.PRAXIS_DEMO_MODE === '1';
}

/** Single shared DemoService instance for the Board and Issue Detail slices. */
export function getDemoService(): DemoService {
  if (!instance) {
    instance = new DemoService({ getDefaultPageSize: () => 25 });
  }
  return instance;
}
