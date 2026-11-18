import http, { IncomingMessage, ServerResponse } from 'node:http';

export class MockUpstreamServer {
  private server: http.Server | null = null;
  public port: number;
  public lastReceivedHeaders: Record<string, any> = {};
  public lastReceivedPayload: Record<string, any> = {};
  public customResponse: any = null;

  constructor(port = 9099) {
    this.port = port;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });
      this.server.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.lastReceivedHeaders = req.headers;
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf-8');
      if (bodyStr) {
        try {
          this.lastReceivedPayload = JSON.parse(bodyStr);
        } catch {
          this.lastReceivedPayload = { raw: bodyStr };
        }
      }

      const isOpenAI = Boolean(req.url?.includes('chat/completions'));

      if (this.customResponse) {
        const resp = this.customResponse;
        this.customResponse = null;
        res.writeHead(resp.status || 200, resp.headers || { 'Content-Type': 'application/json' });
        res.end(typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body));
        return;
      }

      if (this.lastReceivedPayload.stream) {
        // SSE streaming response
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });

        if (isOpenAI) {
          res.write('data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":"Hello"}}]}\n\n');
          res.write('data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"delta":{"content":" world!"}}]}\n\n');
          res.write('data: [DONE]\n\n');
        } else {
          res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123"}}\n\n');
          res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n');
          res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world!"}}\n\n');
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        }
        res.end();
      } else {
        // Non-streaming JSON response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (isOpenAI) {
          res.end(
            JSON.stringify({
              id: 'chatcmpl-123',
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Mock OpenAI response from upstream API' },
                  finish_reason: 'stop'
                }
              ],
              usage: { prompt_tokens: 25, completion_tokens: 10, total_tokens: 35 }
            })
          );
        } else {
          res.end(
            JSON.stringify({
              id: 'msg_123',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'Mock response from upstream API' }],
              usage: { input_tokens: 25, output_tokens: 10 }
            })
          );
        }
      }
    });
  }
}
