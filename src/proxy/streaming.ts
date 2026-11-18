import { IncomingMessage, ServerResponse } from 'node:http';

export interface StreamMetrics {
  chunksCount: number;
  totalBytes: number;
  timeToFirstTokenMs: number;
  durationMs: number;
}

export interface PipeSSEOptions {
  onFinish?: (metrics: StreamMetrics) => void;
}

/**
 * Pipes Server-Sent Events (SSE) from upstream directly to downstream client
 * with zero-copy sub-millisecond pass-through for both Anthropic and OpenAI streams,
 * while measuring streaming latency metrics.
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

  // Mirror status code and headers (Content-Type: text/event-stream, etc.)
  clientRes.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);

  return new Promise((resolve, reject) => {
    upstreamRes.on('data', (chunk: Buffer) => {
      chunksCount++;
      totalBytes += chunk.length;

      if (chunksCount === 1) {
        timeToFirstToken = Date.now() - startTime;
      }

      clientRes.write(chunk);
    });

    upstreamRes.on('end', () => {
      clientRes.end();

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
