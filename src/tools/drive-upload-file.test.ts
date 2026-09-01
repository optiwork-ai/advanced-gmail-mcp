/**
 * CV — the tool half of convert-on-upload.
 *
 * `src/drive/client.test.ts` pins the mechanism (which mimeType goes where, and
 * what happens for a type Google cannot import). This pins the wiring: that the
 * option exists on the tool at all, that a caller's `convert` reaches
 * `uploadFile` unchanged, and that a call which does not mention it still
 * arrives with `convert` absent rather than as an invented `false`.
 *
 * The client module is stubbed, so nothing here touches Drive, a token file, or
 * the disk.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const uploadFile = vi.fn();

vi.mock('../drive/client.js', () => ({
  uploadFile,
  MAX_DRIVE_UPLOAD_BYTES: 100_000_000,
}));

const { registerUploadDriveFile, uploadDriveFileParams } = await import('./drive-upload-file.js');

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function capture(): { name: string; description: string; handler: Handler } {
  let captured: { name: string; description: string; handler: Handler } | undefined;
  const server = {
    tool: (name: string, description: string, _params: unknown, handler: Handler) => {
      captured = { name, description, handler };
    },
  };
  registerUploadDriveFile(server as never);
  if (!captured) throw new Error('the tool registered nothing');
  return captured;
}

beforeEach(() => {
  uploadFile.mockReset();
  uploadFile.mockResolvedValue({
    id: 'sheet-1',
    name: 'fixture.csv',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    size: 12,
    converted: true,
    webViewLink: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
    account: 'work',
  });
});

describe('upload_drive_file exposes the convert option', () => {
  it('declares a convert parameter', () => {
    expect(uploadDriveFileParams.convert).toBeDefined();
  });

  it('describes what convert does in terms of what the user gets, not the mechanism', () => {
    const described = uploadDriveFileParams.convert.description ?? '';
    expect(described).toMatch(/native Google/i);
    expect(described).toMatch(/spreadsheet/i);
  });

  it('says in the tool description that an upload can land as a real Google file', () => {
    const { description } = capture();
    expect(description).toMatch(/convert/i);
  });

  it('passes convert:true straight through to the uploader', async () => {
    const { handler } = capture();

    await handler({ file_path: '/tmp/fixture.csv', convert: true, account: 'work' });

    expect(uploadFile).toHaveBeenCalledWith(expect.objectContaining({
      filePath: '/tmp/fixture.csv',
      convert: true,
    }));
  });

  it('leaves convert undefined when the caller did not ask for it', async () => {
    const { handler } = capture();

    await handler({ file_path: '/tmp/summary.pdf' });

    expect(uploadFile.mock.calls[0][0].convert).toBeUndefined();
  });

  it('returns the converted flag and the Google type the uploader reported', async () => {
    const { handler } = capture();

    const result = await handler({ file_path: '/tmp/fixture.csv', convert: true });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.success).toBe(true);
    expect(payload.converted).toBe(true);
    expect(payload.mimeType).toBe('application/vnd.google-apps.spreadsheet');
  });

  it('reports a refused conversion as an error, in the uploader\'s own words', async () => {
    uploadFile.mockRejectedValueOnce(
      new Error('upload_drive_file: application/pdf cannot be converted into a Google file.'),
    );
    const { handler } = capture();

    const result = await handler({ file_path: '/tmp/scan.pdf', convert: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cannot be converted');
  });
});
