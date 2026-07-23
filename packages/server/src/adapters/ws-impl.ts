/**
 * Minimal WebSocket server — RFC 6455 compliant.
 * Zero dependencies. Used by QQ OneBot adapter.
 *
 * Handles: HTTP upgrade, frame parsing (text/binary/ping/pong/close),
 * fragmented messages, masked frames (client→server).
 *
 * Usage:
 *   const wss = new WebSocketServer({ port: 6199 });
 *   wss.on('connection', (ws, req) => {
 *     ws.on('message', (data) => console.log(data));
 *     ws.send('hello');
 *   });
 */
import { createServer, IncomingMessage, Server } from 'http';
import { Socket } from 'net';
import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ── Types ────────────────────────────────────────────
interface WSOptions { port: number; host?: string; }

type WSData = string | Buffer;

type WSEventMap = {
  message: (data: WSData) => void;
  close: (code?: number, reason?: string) => void;
  ping: (data: Buffer) => void;
  pong: (data: Buffer) => void;
};

// ── WebSocket ────────────────────────────────────────
export class WebSocket {
  private _readyState = 0; // 0=connecting, 1=open, 2=closing, 3=closed
  private _event = new EventEmitter();
  private _buffer = Buffer.alloc(0);
  private _fragmentedOpcode = 0;
  private _fragmentedData: Buffer[] = [];

  constructor(private _socket: Socket) {
    this._readyState = 1;
    _socket.on('data', (chunk: Buffer) => this._onData(chunk));
    _socket.on('close', () => { this._readyState = 3; this._event.emit('close'); });
    _socket.on('error', () => {});
  }

  // Event API
  on<E extends keyof WSEventMap>(event: E, fn: WSEventMap[E]): this {
    this._event.on(event, fn);
    return this;
  }

  // Send text or binary frame
  send(data: WSData): void {
    if (this._readyState !== 1) return;
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    const opcode = typeof data === 'string' ? 0x1 : 0x2;
    this._sendFrame(opcode, payload);
  }

  // Close connection
  close(code = 1000, reason = ''): void {
    if (this._readyState !== 1) return;
    this._readyState = 2;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    if (reason) payload.write(reason, 2, 'utf-8');
    this._sendFrame(0x8, payload);
    this._socket.end();
    this._readyState = 3;
  }

  // Ping
  ping(data?: Buffer): void {
    this._sendFrame(0x9, data || Buffer.alloc(0));
  }

  // ── Private ───────────────────────────────────────
  private _sendFrame(opcode: number, payload: Buffer): void {
    const header = Buffer.alloc(2 + (payload.length > 65535 ? 8 : payload.length > 125 ? 2 : 0));
    header[0] = 0x80 | opcode; // FIN + opcode

    if (payload.length > 65535) {
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    } else if (payload.length > 125) {
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header[1] = payload.length;
    }

    this._socket.write(Buffer.concat([header, payload]));
  }

  private _onData(chunk: Buffer): void {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    this._parseFrames();
  }

  private _parseFrames(): void {
    while (this._buffer.length >= 2) {
      const opcode = this._buffer[0] & 0x0f;
      const fin = (this._buffer[0] & 0x80) !== 0;
      const masked = (this._buffer[1] & 0x80) !== 0;
      let payloadLen = this._buffer[1] & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        payloadLen = Number(this._buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this._buffer.length < offset + maskLen + payloadLen) return;

      let payload = this._buffer.subarray(offset + maskLen, offset + maskLen + payloadLen);

      if (masked) {
        const mask = this._buffer.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i % 4];
        }
      }

      this._buffer = this._buffer.subarray(offset + maskLen + payloadLen);

      // Handle frame types
      switch (opcode) {
        case 0x0: // Continuation
          if (this._fragmentedOpcode) {
            this._fragmentedData.push(payload);
            if (fin) {
              this._emitFragment();
            }
          }
          break;

        case 0x1: // Text
          if (fin) {
            this._event.emit('message', payload.toString('utf-8'));
          } else {
            this._fragmentedOpcode = 0x1;
            this._fragmentedData = [payload];
          }
          break;

        case 0x2: // Binary
          if (fin) {
            this._event.emit('message', payload);
          } else {
            this._fragmentedOpcode = 0x2;
            this._fragmentedData = [payload];
          }
          break;

        case 0x8: // Close
          this._readyState = 2;
          this._sendFrame(0x8, payload);
          this._socket.end();
          this._readyState = 3;
          this._event.emit('close');
          return;

        case 0x9: // Ping
          this._sendFrame(0xA, payload); // Pong
          this._event.emit('ping', payload);
          break;

        case 0xA: // Pong
          this._event.emit('pong', payload);
          break;
      }
    }
  }

  private _emitFragment(): void {
    const data = Buffer.concat(this._fragmentedData);
    if (this._fragmentedOpcode === 0x1) {
      this._event.emit('message', data.toString('utf-8'));
    } else {
      this._event.emit('message', data);
    }
    this._fragmentedOpcode = 0;
    this._fragmentedData = [];
  }
}

// ── WebSocketServer ──────────────────────────────────
export class WebSocketServer extends EventEmitter {
  private _server: Server;

  constructor(opts: WSOptions) {
    super();
    this._server = createServer();

    this._server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const key = req.headers['sec-websocket-key'];
      if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      const accept = createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64');

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );

      const ws = new WebSocket(socket);
      this.emit('connection', ws, req);
    });

    this._server.listen(opts.port, opts.host);
  }

  close(): void {
    this._server.close();
  }
}
