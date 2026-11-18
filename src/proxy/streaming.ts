import { IncomingMessage, ServerResponse } from 'node:http';

export interface StreamMetrics {
  chunksCount: number;
  totalBytes: number;
  timeToFirstTokenMs: number;
  durationMs: number;
}

export interface PipeSSEOptions {
  onFinish?: (metrics: StreamMetrics) => void;
  firewallScan?: (toolName: string, input: Record<string, any>) => { allowed: boolean; reason?: string };
  onViolation?: (reason: string) => void;
}

/**
 * Pipes Server-Sent Events (SSE) from the upstream Anthropic response directly
 * to the downstream client with sub-millisecond pass-through for text tokens,
 * while buffering and validating tool_use blocks against the Context Firewall.
 */
export async function pipeSSEStream(
  upstreamRes: IncomingMessage,
  clientRes: ServerResponse,
  options?: ((metrics: StreamMetrics) => void) | PipeSSEOptions
): Promise<StreamMetrics> {
  const startTime = Date.now();
  let timeToFirstToken = 0;
  let chunksCount = 0;
  let totalBytes = 0;

  const onFinish = typeof options === 'function' ? options : options?.onFinish;
  const firewallScan = typeof options === 'object' ? options.firewallScan : undefined;
  const onViolation = typeof options === 'object' ? options.onViolation : undefined;

  // Mirror status code and headers (Content-Type: text/event-stream, etc.)
  clientRes.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);

  return new Promise((resolve, reject) => {
    let sseBuffer = '';
    const pendingToolCalls = new Map<number, { name: string; jsonParts: string[]; rawEvents: string[] }>();
    let streamTerminated = false;

    const processCompleteEvent = (rawEvent: string) => {
      if (streamTerminated) return;

      if (!firewallScan) {
        clientRes.write(rawEvent + '\n\n');
        return;
      }

      // Parse event lines
      const lines = rawEvent.split('\n');
      let dataStr = '';
      for (const line of lines) {
        if (line.startsWith('data:')) {
          dataStr += line.substring(5).trim();
        }
      }

      if (!dataStr || dataStr === '[DONE]') {
        clientRes.write(rawEvent + '\n\n');
        return;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(dataStr);
      } catch {
        clientRes.write(rawEvent + '\n\n');
        return;
      }

      // Check Anthropic content_block_start
      if (parsed.type === 'content_block_start') {
        const index = parsed.index ?? 0;
        if (parsed.content_block?.type === 'tool_use') {
          pendingToolCalls.set(index, {
            name: parsed.content_block.name || '',
            jsonParts: [],
            rawEvents: [rawEvent]
          });
          return; // Buffer start of tool use
        }
        clientRes.write(rawEvent + '\n\n');
        return;
      }

      // Check Anthropic content_block_delta
      if (parsed.type === 'content_block_delta') {
        const index = parsed.index ?? 0;
        const pending = pendingToolCalls.get(index);
        if (pending) {
          if (parsed.delta?.type === 'input_json_delta' && typeof parsed.delta.partial_json === 'string') {
            pending.jsonParts.push(parsed.delta.partial_json);
          }
          pending.rawEvents.push(rawEvent);
          return; // Buffer tool delta
        }
        clientRes.write(rawEvent + '\n\n');
        return;
      }

      // Check Anthropic content_block_stop
      if (parsed.type === 'content_block_stop') {
        const index = parsed.index ?? 0;
        const pending = pendingToolCalls.get(index);
        if (pending) {
          pending.rawEvents.push(rawEvent);
          pendingToolCalls.delete(index);

          const fullJsonStr = pending.jsonParts.join('');
          let inputObj: Record<string, any> = {};
          try {
            inputObj = fullJsonStr ? JSON.parse(fullJsonStr) : {};
          } catch {
            inputObj = { raw: fullJsonStr };
          }

          const scan = firewallScan(pending.name, inputObj);
          if (!scan.allowed) {
            streamTerminated = true;
            onViolation?.(scan.reason || 'Blocked catastrophic tool call in stream');
            const safeReason = (scan.reason || 'Blocked destructive tool call').replace(/"/g, '\\"');
            clientRes.write(`event: error\ndata: {"type":"error","error":{"type":"forbidden_error","message":"ProxyMCP Context Firewall intercepted tool call: ${safeReason}"}}\n\n`);
            clientRes.end();
            return;
          }

          // Safe: flush all buffered tool events to client
          for (const ev of pending.rawEvents) {
            clientRes.write(ev + '\n\n');
          }
          return;
        }
        clientRes.write(rawEvent + '\n\n');
        return;
      }

      // All other SSE events (text deltas, message start/stop) stream through immediately
      clientRes.write(rawEvent + '\n\n');
    };

    upstreamRes.on('data', (chunk: Buffer) => {
      if (streamTerminated) return;
      chunksCount++;
      totalBytes += chunk.length;

      if (chunksCount === 1) {
        timeToFirstToken = Date.now() - startTime;
      }

      if (!firewallScan) {
        clientRes.write(chunk);
        return;
      }

      sseBuffer += chunk.toString('utf-8');
      const parts = sseBuffer.split('\n\n');
      sseBuffer = parts.pop() ?? ''; // keep trailing incomplete chunk in buffer

      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed) {
          processCompleteEvent(trimmed);
          if (streamTerminated) break;
        }
      }
    });

    upstreamRes.on('end', () => {
      if (!streamTerminated) {
        // Flush remaining buffer if any
        if (sseBuffer.trim()) {
          processCompleteEvent(sseBuffer.trim());
        }

        // Flush any lingering tool calls
        for (const [, pending] of pendingToolCalls) {
          for (const ev of pending.rawEvents) {
            clientRes.write(ev + '\n\n');
          }
        }
        pendingToolCalls.clear();
        clientRes.end();
      }

      const metrics: StreamMetrics = {
        chunksCount,
        totalBytes,
        timeToFirstTokenMs: timeToFirstToken,
        durationMs: Date.now() - startTime
      };
      if (onFinish) {
        onFinish(metrics);
      }
      resolve(metrics);
    });

    upstreamRes.on('error', (err) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'Upstream SSE streaming failed', details: err.message }));
      } else {
        clientRes.end();
      }
      reject(err);
    });
  });
}
