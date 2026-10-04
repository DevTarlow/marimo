import {describe, expect, it} from 'vitest';

import {iterateSseData} from './sse.js';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const payload of iterateSseData(stream)) {
    out.push(payload);
  }
  return out;
}

describe('iterateSseData', () => {
  it('yields each data payload in order', async () => {
    const payloads = await collect(
      streamOf(['data: {"a":1}\n', 'data: {"b":2}\n', 'data: [DONE]\n']),
    );
    expect(payloads).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reassembles a payload split across network chunks', async () => {
    const payloads = await collect(
      streamOf(['data: {"hel', 'lo":"world"', '}\n', 'data: [DONE]\n']),
    );
    expect(payloads).toEqual(['{"hello":"world"}']);
  });

  it('handles CRLF line endings and colon-only comments', async () => {
    const payloads = await collect(
      streamOf([': keep-alive\r\n', 'data: {"x":1}\r\n', 'data: [DONE]\r\n']),
    );
    expect(payloads).toEqual(['{"x":1}']);
  });

  it('ignores non-data fields such as event and id', async () => {
    const payloads = await collect(
      streamOf([
        'event: message\n',
        'id: 7\n',
        'data: {"x":1}\n',
        'data: [DONE]\n',
      ]),
    );
    expect(payloads).toEqual(['{"x":1}']);
  });

  it('flushes a final payload that has no trailing newline', async () => {
    const payloads = await collect(streamOf(['data: {"x":1}']));
    expect(payloads).toEqual(['{"x":1}']);
  });

  it('stops at the DONE sentinel', async () => {
    const payloads = await collect(
      streamOf(['data: {"x":1}\n', 'data: [DONE]\n', 'data: {"y":2}\n']),
    );
    expect(payloads).toEqual(['{"x":1}']);
  });
});
