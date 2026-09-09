/**
 * Minimal TCP/HTTP readiness checks (FX-BE-055 / TASK-144, extracted for
 * reuse in TASK-157).
 *
 * A single poll, not a retry loop — a caller that wants to keep trying
 * polls on its own interval, the way `runServiceManager.ts`'s readiness
 * loop and `deployments/directoryTarget.ts`'s post-deploy health check
 * both do, each on its own schedule and timeout budget.
 */

import * as http from 'node:http';
import * as net from 'node:net';

const DEFAULT_CONNECT_TIMEOUT_MS = 1_000;

/** Whether a TCP connection to `host:port` succeeds within `timeoutMs`. */
export function checkTcpOpen(host: string, port: number, timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host });
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

/** Whether an HTTP GET to `host:port + probePath` returns `expectedStatus` (or any 2xx when absent) within `timeoutMs`. */
export function checkHttpOk(
  host: string,
  port: number,
  probePath: string,
  expectedStatus?: number,
  timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS
): Promise<boolean> {
  return new Promise(resolve => {
    const request = http.get({ host, port, path: probePath, timeout: timeoutMs }, response => {
      response.resume();
      const status = response.statusCode ?? 0;
      resolve(expectedStatus ? status === expectedStatus : status >= 200 && status < 300);
    });
    request.once('error', () => resolve(false));
    request.once('timeout', () => request.destroy());
  });
}
