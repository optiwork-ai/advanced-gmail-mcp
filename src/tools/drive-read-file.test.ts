/**
 * G8 — the export branch of read_drive_file.
 *
 * Drive's export endpoint ignores Range, so a 50MB exported Doc or Sheet was
 * fetched whole into memory and only then trimmed to 1MB. The whole MCP process
 * is shared by every account, so one very large file could disturb everything
 * else. The read now stops at the cap instead.
 */
import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';
import { MAX_CONTENT_BYTES, capBuffer, readStreamToCap } from './drive-read-file.js';

/** A stream of `count` chunks of `size` bytes that counts what it actually emitted. */
function countingStream(count: number, size: number) {
  const state = { emitted: 0 };
  const stream = new Readable({
    read() {
      if (state.emitted >= count) {
        this.push(null);
        return;
      }
      state.emitted += 1;
      this.push(Buffer.alloc(size, 'a'));
    },
  });
  return { stream, state };
}

describe('readStreamToCap', () => {
  it('returns a small export whole, and does not claim truncation', async () => {
    const stream = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
    await expect(readStreamToCap(stream, MAX_CONTENT_BYTES)).resolves.toEqual({
      content: 'hello world',
      truncated: false,
    });
  });

  it('stops reading at the cap instead of buffering the whole export', async () => {
    // 10MB available, 1MB wanted.
    const { stream, state } = countingStream(100, 100_000);

    const { content, truncated } = await readStreamToCap(stream, MAX_CONTENT_BYTES);

    expect(truncated).toBe(true);
    expect(Buffer.byteLength(content, 'utf-8')).toBe(MAX_CONTENT_BYTES);
    // The point of the change: it pulled ~11 chunks, not all 100.
    expect(state.emitted).toBeLessThan(15);
  });

  it('destroys the stream once it has what it needs, so the transfer stops', async () => {
    const { stream } = countingStream(100, 100_000);
    await readStreamToCap(stream, MAX_CONTENT_BYTES);
    expect(stream.destroyed).toBe(true);
  });

  it('a stream exactly at the cap is not reported as truncated', async () => {
    const stream = Readable.from([Buffer.alloc(MAX_CONTENT_BYTES, 'a')]);
    const { content, truncated } = await readStreamToCap(stream, MAX_CONTENT_BYTES);
    expect(truncated).toBe(false);
    expect(Buffer.byteLength(content, 'utf-8')).toBe(MAX_CONTENT_BYTES);
  });

  it('one byte over the cap IS reported as truncated', async () => {
    const stream = Readable.from([Buffer.alloc(MAX_CONTENT_BYTES + 1, 'a')]);
    const { truncated } = await readStreamToCap(stream, MAX_CONTENT_BYTES);
    expect(truncated).toBe(true);
  });

  it('accepts a stream of strings as well as buffers', async () => {
    const stream = Readable.from(['né', 'e']);
    await expect(readStreamToCap(stream, MAX_CONTENT_BYTES)).resolves.toMatchObject({
      content: 'née',
    });
  });

  it('never splits a multi-byte character into mojibake at the boundary', async () => {
    // 'é' is two bytes; cutting between them must not produce a lone byte.
    const stream = Readable.from([Buffer.from('aé', 'utf-8')]);
    const { content, truncated } = await readStreamToCap(stream, 2);
    expect(truncated).toBe(true);
    expect(content).toBe('a');
    expect(content).not.toContain('�');
  });

  it('an empty export is empty, not an error', async () => {
    const stream = Readable.from([]);
    await expect(readStreamToCap(stream, MAX_CONTENT_BYTES)).resolves.toEqual({
      content: '',
      truncated: false,
    });
  });

  it('propagates a mid-transfer failure rather than returning half a document as whole', async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error('connection reset'));
      },
    });
    await expect(readStreamToCap(stream, MAX_CONTENT_BYTES)).rejects.toThrow(/connection reset/);
  });
});

describe('capBuffer — the shared cap both read paths use', () => {
  it('leaves a buffer under the cap alone', () => {
    expect(capBuffer(Buffer.from('short'), 100)).toEqual({ content: 'short', truncated: false });
  });

  it('cuts at the cap and says so', () => {
    const { content, truncated } = capBuffer(Buffer.alloc(200, 'a'), 100);
    expect(truncated).toBe(true);
    expect(content).toHaveLength(100);
  });

  it('drops an incomplete trailing character rather than emitting a replacement glyph', () => {
    // 4-byte emoji cut in half.
    const buf = Buffer.from('ok👍', 'utf-8');
    const { content } = capBuffer(buf, 4);
    expect(content).toBe('ok');
    expect(content).not.toContain('\uFFFD');
  });

  it('keeps a multi-byte character that fits exactly', () => {
    const buf = Buffer.from('aé', 'utf-8');
    expect(capBuffer(buf, 3).content).toBe('aé');
  });
});
