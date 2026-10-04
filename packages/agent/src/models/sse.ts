/**
 * Server-sent-events reader used by the DeepSeek streaming client.
 *
 * Yields the payload of each `data:` line, in order, stopping after the
 * OpenAI-compatible `[DONE]` sentinel. Comment lines (`:`), `event:` lines and
 * blank separators are ignored, and chunks that split a line in half are
 * buffered until the line completes.
 */
export async function* iterateSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, {stream: true});

      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) {
          break;
        }
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        const payload = dataPayload(line);
        if (payload === undefined) {
          continue;
        }
        if (payload === '[DONE]') {
          return;
        }
        yield payload;
      }
    }

    // Flush the decoder and drain a final line that arrived without a newline.
    buffer += decoder.decode();
    for (const rawLine of buffer.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      const payload = dataPayload(line);
      if (payload === undefined) {
        continue;
      }
      if (payload === '[DONE]') {
        return;
      }
      yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

function dataPayload(line: string): string | undefined {
  if (!line.startsWith('data:')) {
    return undefined;
  }
  return line.slice('data:'.length).trimStart();
}
