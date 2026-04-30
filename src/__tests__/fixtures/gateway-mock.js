// gateway-mock.js — intercepts fetch() calls to the local jarvis-gateway (http://localhost:22100)
// and returns canned responses, including streaming SSE bodies for Claude output simulation.

import { vi } from 'vitest';

const GATEWAY_BASE = 'http://localhost:22100';

/**
 * mockGatewayStream(chunks)
 * Returns a Response whose body is a ReadableStream emitting each chunk as an SSE data line.
 * chunks: string[] — each becomes "data: <chunk>\n\n" in the stream.
 */
export function mockGatewayStream(chunks = []) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/**
 * mockGateway(responses)
 * Replaces global.fetch with a vi.fn() that intercepts requests to GATEWAY_BASE.
 * responses: Record<string, string | string[]>
 *   - key: URL path (e.g. "/stream")
 *   - value: string body for non-streaming, or string[] for SSE streaming
 *
 * Returns the vi.fn() so callers can inspect calls or add further mockImplementation.
 *
 * Usage:
 *   beforeEach(() => mockGateway({ '/stream': ['hello', 'world'] }));
 *   afterEach(() => vi.restoreAllMocks());
 */
export function mockGateway(responses = {}) {
  const mockFetch = vi.fn((url, _init) => {
    const urlStr = String(url);
    if (!urlStr.startsWith(GATEWAY_BASE)) {
      // Passthrough anything not aimed at the gateway
      return Promise.resolve(new Response('{}', { status: 200 }));
    }

    const path = urlStr.slice(GATEWAY_BASE.length).replace(/\?.*$/, '');
    const body = responses[path];

    if (body === undefined) {
      return Promise.resolve(new Response('not found', { status: 404 }));
    }

    if (Array.isArray(body)) {
      return Promise.resolve(mockGatewayStream(body));
    }

    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  global.fetch = mockFetch;
  return mockFetch;
}
