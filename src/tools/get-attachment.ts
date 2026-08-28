import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ATTACHMENT_INLINE_LIMIT_BYTES, getAttachment } from '../gmail/client.js';
import type { AttachmentData } from '../gmail/types.js';

/**
 * The image formats an MCP client is expected to be able to display. Deliberately
 * a whitelist rather than a `image/*` test: SVG is a document (and a script
 * vector), and TIFF/HEIC are formats no client is required to render — handing
 * any of them over as an image block risks the whole tool call being rejected,
 * which is worse than returning the bytes as data.
 */
const VIEWABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** `image/jpeg; name="scan.jpg"` and `IMAGE/PNG` are both real header values. */
function bareMimeType(mimeType: string | undefined): string {
  return (mimeType ?? '').split(';')[0].trim().toLowerCase();
}

export function isViewableImage(mimeType: string | undefined): boolean {
  return VIEWABLE_IMAGE_TYPES.has(bareMimeType(mimeType));
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * Turn one fetched attachment into the blocks the tool returns.
 *
 * An image the client can display comes back as a real image block, so the model
 * can SEE the screenshot, the photo of the damaged roof, the scanned form —
 * instead of being told its name and size. The JSON metadata block is kept
 * alongside it (filename, mimeType, size, attachmentId are still needed), but
 * with `data_base64` removed: the bytes are already in the image block, and
 * repeating them would double the cost of every image read.
 *
 * Everything else — non-images, and anything written to disk with save_dir —
 * is returned exactly as before.
 */
export function attachmentContentBlocks(result: AttachmentData): ContentBlock[] {
  const data = result.data_base64;
  const canShow =
    data !== undefined
    && isViewableImage(result.mimeType)
    // Belt and braces. getAttachment already refuses an oversized inline read;
    // this is here so the block builder can never be the path that slips a
    // giant payload through.
    && result.size <= ATTACHMENT_INLINE_LIMIT_BYTES
    && Buffer.byteLength(data, 'utf8') <= ATTACHMENT_INLINE_LIMIT_BYTES * 2;

  if (!canShow) {
    return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
  }

  const { data_base64: _omitted, ...metadata } = result;
  return [
    {
      type: 'text',
      text: JSON.stringify(
        { ...metadata, returned_as: 'image content block (the bytes are attached below, not in this JSON)' },
        null,
        2,
      ),
    },
    { type: 'image', data, mimeType: bareMimeType(result.mimeType) },
  ];
}

export const getAttachmentParams = {
  message_id: z.string().describe('The Gmail message ID the attachment belongs to'),
  attachment_id: z.string().describe('The attachmentId from read_email\'s attachments[].attachmentId'),
  part_id: z
    .string()
    .optional()
    .describe(
      'The partId from read_email\'s attachments[].partId — pass part_id from read_email '
      + 'for exact identification. Gmail hands out a different attachmentId for the same '
      + 'part on every fetch of a message, so the id alone cannot always say WHICH part '
      + 'was downloaded; partId does not change. Without it the filename and mimeType are '
      + 'recovered by matching the downloaded size, and a note explains it when that fails.',
    ),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
  save_dir: z
    .string()
    .optional()
    .describe(
      'Absolute path of an EXISTING directory to write the attachment into. '
      + 'Strongly preferred: the result is then a file path instead of base64 in the '
      + 'conversation. The filename comes from the message (sanitized); an existing '
      + 'file is never overwritten (a "-1", "-2" suffix is added instead). '
      + 'Omit only for small attachments you actually need the bytes of inline.',
    ),
};

export function registerGetAttachment(server: McpServer): void {
  server.tool(
    'get_attachment',
    'Fetch an attachment. Always returns filename, mimeType and size. '
    + 'A PNG, JPEG, GIF or WebP fetched WITHOUT save_dir comes back as a viewable image — you can '
    + 'read what is in the picture and answer about it directly, so use this to look at a '
    + 'screenshot, a photo or a scan someone emailed. '
    + 'With save_dir it writes the file to that directory and returns its path instead (no image is '
    + 'shown, since the bytes went to disk). Other file types come back as base64 in data_base64. '
    + 'Either way the inline limit is 1MB — anything larger errors and asks for save_dir. '
    + 'Use read_email first to get the attachmentId from attachments[], and pass part_id '
    + 'from that same attachments[].partId for exact identification — Gmail changes the '
    + 'attachmentId between fetches, so part_id is what pins down which part you meant.',
    getAttachmentParams,
    async ({ message_id, attachment_id, part_id, account, save_dir }) => {
      try {
        const result = await getAttachment({
          messageId: message_id,
          attachmentId: attachment_id,
          partId: part_id ?? undefined,
          account: account ?? undefined,
          saveDir: save_dir ?? undefined,
        });

        return { content: attachmentContentBlocks(result) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
