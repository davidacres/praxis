import type { TicketManagerIpc } from '@praxis/core';

declare global {
  interface Window {
    ticketManager: TicketManagerIpc;
  }
}
