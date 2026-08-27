/**
 * MIME assembly for Gmail-native outbound mail.
 *
 * PLACEHOLDER — this file is stubbed so the B10 acceptance gate compiles and
 * fails for the right reason before the implementation lands.
 */

export interface QuoteBlockOptions {
  from: string;
  date: string;
  html: string;
  text: string;
  timeZone?: string;
}

export function buildQuoteBlock(_opts: QuoteBlockOptions): { html: string; text: string } {
  throw new Error('buildQuoteBlock is not implemented yet');
}

export function formatFromHeader(_displayName: string, _email: string): string {
  throw new Error('formatFromHeader is not implemented yet');
}
