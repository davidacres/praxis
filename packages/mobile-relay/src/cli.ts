#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { RelayServer } from './relayServer';

const port = Number(process.env.PORT ?? 8787);
const certPath = process.env.TLS_CERT;
const keyPath = process.env.TLS_KEY;
const server = new RelayServer({
  port,
  ...(process.env.HOST ? { host: process.env.HOST } : {}),
  ...(certPath && keyPath ? { tls: { cert: readFileSync(certPath), key: readFileSync(keyPath) } } : {}),
  onLog: line => console.log(`[relay] ${line}`),
});
void server.start();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void server.stop().then(() => process.exit(0)));
