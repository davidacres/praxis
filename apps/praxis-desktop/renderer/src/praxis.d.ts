import type { PraxisIpc } from '@praxis/core';

declare global {
  interface Window {
    praxis: PraxisIpc;
  }
}
