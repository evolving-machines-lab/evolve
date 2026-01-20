/**
 * JSON-RPC Bridge Transport Layer
 *
 * Pure transport layer for JSON-RPC over stdio with framed messages.
 * Handles framing, event emission, and request/response lifecycle.
 *
 * SDK integration is delegated to EvolveAdapter - this layer is STABLE
 * and rarely needs changes when the SDK evolves.
 */

// =============================================================================
// STDOUT PROTECTION
// =============================================================================
// Redirect all console output to stderr BEFORE any imports.
// This protects the framed binary protocol on stdout from corruption by
// dependencies (e.g., @composio/core logs errors to stdout, not stderr).
// Must be at the top of the file to execute before any module initialization.

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const originalInfo = console.info;
const originalDebug = console.debug;

console.log = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');
console.warn = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');
console.error = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');
console.info = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');
console.debug = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');

// =============================================================================

import { EvolveAdapter } from './adapter';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  InitializeParams,
} from './types';

// =============================================================================
// BRIDGE CLASS (Transport Layer)
// =============================================================================

class Bridge {
  private adapter: EvolveAdapter;

  // Serialize stdout writes to avoid interleaving frames.
  // Note: Request handling is intentionally concurrent for multi-instance Swarm support.
  private writeChain: Promise<void> = Promise.resolve();

  private inputBuffer: Buffer = Buffer.alloc(0);

  // Frame and payload limits
  private readonly MAX_FRAME_BYTES = 50 * 1024 * 1024; // 50MB safety cap
  private readonly MAX_EVENT_BYTES = 256 * 1024; // 256KB per event payload
  private readonly MAX_TEXT_BYTES = 200 * 1024; // 200KB per text field/chunk

  constructor() {
    this.adapter = new EvolveAdapter();
    this.setupTransport();
  }

  // ===========================================================================
  // WRITE SERIALIZATION
  // ===========================================================================

  private enqueueWrite(fn: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.catch(() => {});
    return next;
  }

  // ===========================================================================
  // UTF-8 CHUNKING & TRUNCATION
  // ===========================================================================

  private safeUtf8End(buf: Buffer, end: number): number {
    let safeEnd = end;
    while (
      safeEnd > 0 &&
      safeEnd < buf.length &&
      (buf[safeEnd] & 0xc0) === 0x80
    ) {
      safeEnd--;
    }
    return safeEnd > 0 ? safeEnd : end;
  }

  private chunkUtf8(text: string, maxBytes: number): string[] {
    const buf = Buffer.from(text, 'utf8');
    if (buf.length <= maxBytes) return [text];

    const chunks: string[] = [];
    let offset = 0;
    while (offset < buf.length) {
      let end = Math.min(offset + maxBytes, buf.length);
      end = this.safeUtf8End(buf, end);
      chunks.push(buf.toString('utf8', offset, end));
      offset = end;
    }
    return chunks.length > 0 ? chunks : [''];
  }

  private truncateUtf8(text: string, maxBytes: number): string {
    const buf = Buffer.from(text, 'utf8');
    if (buf.length <= maxBytes) return text;

    const reserve = 128; // leave room for suffix
    const target = Math.max(0, maxBytes - reserve);
    let end = Math.min(target, buf.length);
    end = this.safeUtf8End(buf, end);
    const removed = buf.length - end;
    const suffix = `\n...[truncated ${removed} bytes]`;
    return buf.toString('utf8', 0, end) + suffix;
  }

  private truncateStringsDeepWithFlag(
    value: any,
    maxBytes: number
  ): { value: any; truncated: boolean } {
    if (value == null) return { value, truncated: false };

    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > maxBytes) {
        return { value: this.truncateUtf8(value, maxBytes), truncated: true };
      }
      return { value, truncated: false };
    }

    if (Array.isArray(value)) {
      let truncated = false;
      const out = value.map((v) => {
        const r = this.truncateStringsDeepWithFlag(v, maxBytes);
        truncated = truncated || r.truncated;
        return r.value;
      });
      return { value: out, truncated };
    }

    if (typeof value === 'object') {
      let truncated = false;
      const out: any = {};
      for (const [k, v] of Object.entries(value)) {
        const r = this.truncateStringsDeepWithFlag(v, maxBytes);
        truncated = truncated || r.truncated;
        out[k] = r.value;
      }
      return { value: out, truncated };
    }

    return { value, truncated: false };
  }

  /**
   * Truncate only tool output content, preserving agent messages and other fields.
   *
   * Only truncates the `content` field of `tool_call` and `tool_call_update` events.
   * Agent messages, thoughts, user messages, and plan entries are never truncated.
   */
  private truncateToolOutputs(
    update: any,
    maxBytes: number
  ): { value: any; truncated: boolean } {
    if (update == null) return { value: update, truncated: false };

    const sessionUpdate = update.sessionUpdate;

    // Only truncate tool_call and tool_call_update content
    if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') {
      return { value: update, truncated: false };
    }

    // No content to truncate
    if (!update.content) {
      return { value: update, truncated: false };
    }

    // Truncate only the content array (tool output)
    const { value: truncatedContent, truncated } = this.truncateStringsDeepWithFlag(
      update.content,
      maxBytes
    );

    if (!truncated) {
      return { value: update, truncated: false };
    }

    // Return update with truncated content, preserving all other fields
    return {
      value: { ...update, content: truncatedContent },
      truncated: true,
    };
  }

  // ===========================================================================
  // EVENT EMISSION
  // ===========================================================================

  private emitStdStream(type: 'stdout' | 'stderr', data: string) {
    const chunks = this.chunkUtf8(data, this.MAX_TEXT_BYTES);
    const total = chunks.length;
    for (let i = 0; i < total; i++) {
      void this.sendNotification({
        jsonrpc: '2.0',
        method: 'event',
        params: {
          type,
          data: chunks[i],
          seq: i,
          done: i === total - 1,
        },
      }).catch(() => {});
    }
  }

  private emitContentEvent(event: any) {
    const originalUpdate = event?.update;
    // Only truncate tool outputs (tool_call, tool_call_update content).
    // Agent messages, thoughts, and other content are preserved in full.
    const { value: truncatedUpdate, truncated: didTruncate } =
      this.truncateToolOutputs(originalUpdate, this.MAX_TEXT_BYTES);

    // Build notification once, check size, replace if too big
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'event',
      params: {
        type: 'content',
        session_id: event?.sessionId,
        update: truncatedUpdate,
        ...(didTruncate ? { truncated: true } : {}),
      },
    };

    const serialized = JSON.stringify(notification);
    if (Buffer.byteLength(serialized, 'utf8') > this.MAX_EVENT_BYTES) {
      // Event too large even after truncation - send minimal placeholder
      notification.params = {
        type: 'content',
        session_id: event?.sessionId,
        update: {
          sessionUpdate: originalUpdate?.sessionUpdate,
          note: `event exceeded ${this.MAX_EVENT_BYTES} bytes`,
        },
        truncated: true,
      };
    }

    void this.sendNotification(notification).catch(() => {});
  }

  // ===========================================================================
  // FRAMED I/O
  // ===========================================================================

  private async writeFrame(obj: unknown): Promise<void> {
    const jsonBuf = Buffer.from(JSON.stringify(obj), 'utf8');
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(jsonBuf.length, 0);
    const frame = Buffer.concat([header, jsonBuf]);

    if (!process.stdout.write(frame)) {
      await new Promise<void>((resolve) => process.stdout.once('drain', resolve));
    }
  }

  private sendResponse(response: JsonRpcResponse): Promise<void> {
    return this.enqueueWrite(() => this.writeFrame(response));
  }

  private sendNotification(notification: JsonRpcNotification): Promise<void> {
    return this.enqueueWrite(() => this.writeFrame(notification));
  }

  // ===========================================================================
  // TRANSPORT SETUP
  // ===========================================================================

  private setupTransport() {
    process.stdin.on('data', (chunk: Buffer) => {
      this.inputBuffer = Buffer.concat([this.inputBuffer, chunk]);
      this.pumpFrames();
    });

    const shutdown = async () => {
      try {
        // Kill all multi-instance Evolves (Swarm workers)
        await Promise.race([
          this.adapter.killAllInstances(),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);

        // Kill single-instance Evolve (regular usage)
        const evolve = this.adapter.getEvolve();
        if (evolve) {
          await Promise.race([
            evolve.kill(),
            new Promise((resolve) => setTimeout(resolve, 2000)),
          ]);
        }
      } catch {
        // Ignore errors during cleanup
      }
      process.exit(0);
    };

    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
    process.stdin.on('error', shutdown);

    process.stdin.resume();
  }

  // ===========================================================================
  // REQUEST HANDLING
  // ===========================================================================

  private async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      // Special handling for initialize - needs to wire up event callbacks
      if (request.method === 'initialize') {
        const params = request.params as InitializeParams;
        const result = await this.adapter.initialize(params, {
          onStdout: params.forward_stdout
            ? (data: string) => this.emitStdStream('stdout', data)
            : undefined,
          onStderr: params.forward_stderr
            ? (data: string) => this.emitStdStream('stderr', data)
            : undefined,
          onContent: params.forward_content
            ? (event: any) => this.emitContentEvent(event)
            : undefined,
        });
        return {
          jsonrpc: '2.0',
          result,
          id: request.id,
        };
      }

      // All other methods delegated to adapter
      const result = await this.adapter.handle(request.method, request.params || {});
      return {
        jsonrpc: '2.0',
        result,
        id: request.id,
      };
    } catch (error) {
      // Detect E2B NotFoundError (expired/missing sandbox)
      const errorName = error instanceof Error ? error.constructor.name : '';
      const errorCode = errorName === 'NotFoundError' ? -32001 : -32603;

      return {
        jsonrpc: '2.0',
        error: {
          code: errorCode,
          message: error instanceof Error ? error.message : String(error),
          data: {
            errorType: errorName,
            stack: error instanceof Error ? error.stack : undefined,
          },
        },
        id: request.id,
      };
    }
  }

  private pumpFrames() {
    while (this.inputBuffer.length >= 4) {
      const len = this.inputBuffer.readUInt32BE(0);
      if (len <= 0 || len > this.MAX_FRAME_BYTES) {
        void this.sendResponse({
          jsonrpc: '2.0',
          error: {
            code: -32700,
            message: `Invalid frame length: ${len}`,
          },
          id: null,
        }).catch(() => {});
        // Drop buffer to avoid desync and wait for new frames.
        this.inputBuffer = Buffer.alloc(0);
        return;
      }

      if (this.inputBuffer.length < 4 + len) return;

      const payload = this.inputBuffer.subarray(4, 4 + len);
      this.inputBuffer = this.inputBuffer.subarray(4 + len);

      let request: JsonRpcRequest;
      try {
        request = JSON.parse(payload.toString('utf8'));
      } catch (error) {
        void this.sendResponse({
          jsonrpc: '2.0',
          error: {
            code: -32700,
            message: 'Parse error',
            data: error instanceof Error ? error.message : String(error),
          },
          id: null,
        }).catch(() => {});
        continue;
      }

      // Dispatch concurrently - each request runs independently.
      // This enables parallel execution for multi-instance Swarm operations.
      // Errors are converted to JSON-RPC responses in handleRequest.
      void (async () => {
        const response = await this.handleRequest(request);
        await this.sendResponse(response);
      })();
    }
  }
}

// Start the bridge
new Bridge();
