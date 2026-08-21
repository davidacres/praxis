import type { TicketManagerIpc } from '@ticket-manager/core';

declare global {
  interface Window {
    ticketManager: TicketManagerIpc;
  }
}
