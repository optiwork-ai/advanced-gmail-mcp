/**
 * G2 — an emailed image comes back as something Claude can actually look at.
 *
 * `attachmentContentBlocks` is the whole decision: it turns one AttachmentData
 * into the MCP content array the tool returns. Pure, so it is tested directly.
 */
import { describe, expect, it } from 'vitest';
import { attachmentContentBlocks, isViewableImage } from './get-attachment.js';

const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');

function imageResult(mimeType: string, extra: Record<string, unknown> = {}) {
  return {
    attachmentId: 'a1',
    filename: 'photo.png',
    mimeType,
    size: 15,
    data_base64: PNG_B64,
    ...extra,
  };
}

describe('isViewableImage', () => {
  it('accepts the formats a model can actually be shown', () => {
    expect(isViewableImage('image/png')).toBe(true);
    expect(isViewableImage('image/jpeg')).toBe(true);
    expect(isViewableImage('image/gif')).toBe(true);
    expect(isViewableImage('image/webp')).toBe(true);
  });

  it('is case- and parameter-insensitive, the way real mail headers arrive', () => {
    expect(isViewableImage('IMAGE/PNG')).toBe(true);
    expect(isViewableImage('image/jpeg; name="scan.jpg"')).toBe(true);
    expect(isViewableImage('  image/png  ')).toBe(true);
  });

  it('rejects image types no client is required to render', () => {
    expect(isViewableImage('image/svg+xml')).toBe(false);
    expect(isViewableImage('image/tiff')).toBe(false);
    expect(isViewableImage('image/heic')).toBe(false);
  });

  it('rejects non-images', () => {
    expect(isViewableImage('application/pdf')).toBe(false);
    expect(isViewableImage('text/plain')).toBe(false);
    expect(isViewableImage(undefined)).toBe(false);
    expect(isViewableImage('')).toBe(false);
  });
});

describe('attachmentContentBlocks', () => {
  it('returns the image as an image block AND keeps the JSON metadata block', () => {
    const blocks = attachmentContentBlocks(imageResult('image/png'));

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('text');
    expect(blocks[1]).toEqual({ type: 'image', data: PNG_B64, mimeType: 'image/png' });

    const meta = JSON.parse((blocks[0] as { text: string }).text);
    expect(meta).toMatchObject({ filename: 'photo.png', mimeType: 'image/png', size: 15 });
  });

  it('normalizes a parameterized mime type down to the bare type on the image block', () => {
    const blocks = attachmentContentBlocks(imageResult('IMAGE/JPEG; name="scan.jpg"'));
    expect(blocks[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
  });

  it('does not repeat the base64 payload twice — the metadata block drops data_base64', () => {
    const blocks = attachmentContentBlocks(imageResult('image/png'));
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain(PNG_B64);
    expect(JSON.parse(text).data_base64).toBeUndefined();
    // and it says where the bytes went
    expect(JSON.parse(text).returned_as).toMatch(/image/i);
  });

  it('leaves a non-image attachment exactly as it was: one JSON block with the bytes', () => {
    const blocks = attachmentContentBlocks(imageResult('application/pdf', { filename: 'inv.pdf' }));

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect(JSON.parse((blocks[0] as { text: string }).text).data_base64).toBe(PNG_B64);
  });

  it('does not fabricate an image block when the bytes went to disk instead', () => {
    const blocks = attachmentContentBlocks({
      attachmentId: 'a1',
      filename: 'photo.png',
      mimeType: 'image/png',
      size: 15,
      path: '/tmp/photo.png',
    });

    expect(blocks).toHaveLength(1);
    expect(JSON.parse((blocks[0] as { text: string }).text).path).toBe('/tmp/photo.png');
  });

  it('honors the size cap: an image over the inline limit never becomes an image block', () => {
    // getAttachment throws before this point, but the block builder must not be
    // the one place a giant payload could still slip through.
    const blocks = attachmentContentBlocks(
      imageResult('image/png', { size: 5_000_000, data_base64: 'x'.repeat(6_000_000) }),
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
  });
});
