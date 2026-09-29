/**
 * A relayed connection as a Node `Duplex`, so `MobileLanServer` serves it with
 * exactly the code it runs for a TCP socket. The bytes are the same
 * length-prefixed Noise IK records; a WebSocket message boundary means nothing
 * (the listener's `RecordAssembler` reframes), and the relay only forwards them.
 */
import { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';

export class MobileRelayStream extends Duplex {
  /** There is no local interface or peer address on a relayed connection. */
  readonly localAddress = '';
  readonly remoteAddress = 'relay';

  constructor(private readonly ws: WebSocket) {
    super();
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      this.push(chunk);
    });
    ws.on('close', () => this.destroy());
    ws.on('error', error => this.destroy(error));
  }

  override _read(): void {
    // Data is pushed as it arrives.
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.ws.readyState !== this.ws.OPEN) return callback(new Error('The relay connection is closed.'));
    this.ws.send(chunk, { binary: true }, error => callback(error ?? null));
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.ws.close(1000, 'done');
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    try {
      this.ws.terminate();
    } catch {
      // Already gone.
    }
    callback(error);
  }
}
