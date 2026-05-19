#!/usr/bin/env tsx
/**
 * Smoke-test runner for unsubscribeFromEmail.
 *
 *   tsx scripts/smoke-unsubscribe.ts inspect <account> <messageId>
 *   tsx scripts/smoke-unsubscribe.ts fire    <account> <messageId>
 *
 * `inspect` only reads the message and prints unsubscribe-related headers.
 * `fire` actually invokes unsubscribeFromEmail — sends mailto / POSTs HTTPS.
 */
import { getMessage, searchMessages, unsubscribeFromEmail } from '../src/gmail/client.js';

const [mode, account, messageIdOrQuery] = process.argv.slice(2);

if (!mode || !account || !messageIdOrQuery) {
  console.error('Usage: tsx scripts/smoke-unsubscribe.ts <inspect|fire|search> <account> <messageId|query>');
  process.exit(2);
}

async function main() {
  const messageId = messageIdOrQuery;
  if (mode === 'search') {
    const results = await searchMessages({ query: messageIdOrQuery, account, maxResults: 10 });
    console.log(JSON.stringify(results.map(r => ({ id: r.id, from: r.from, subject: r.subject })), null, 2));
    return;
  }

  if (mode === 'inspect') {
    const msg = await getMessage({ messageId, account, format: 'full' });
    console.log(JSON.stringify({
      id: msg.id,
      from: msg.from,
      subject: msg.subject,
      list_unsubscribe: msg.list_unsubscribe,
      list_unsubscribe_post: msg.list_unsubscribe_post,
    }, null, 2));
    return;
  }

  if (mode === 'fire') {
    const result = await unsubscribeFromEmail({ messageId, account });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(`Unknown mode: ${mode}`);
  process.exit(2);
}

main().catch(err => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
