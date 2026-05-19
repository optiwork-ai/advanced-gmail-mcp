#!/usr/bin/env tsx
/**
 * Live smoke-test runner for gmail-mcp.
 *
 * Each subcommand exercises one piece of behavior against real Gmail.
 * Read-only subcommands are always safe; write subcommands either target
 * self or operate on a message created by the script itself.
 *
 * Usage:
 *   tsx scripts/smoke.ts <command> <account> [args...]
 *
 * Commands:
 *   search <account> <query>                    — search by Gmail query
 *   list <account> [maxResults]                 — list inbox (default 10)
 *   inspect <account> <messageId>               — print headers + meta
 *   inspectUnsub <account> <messageId>          — print List-Unsubscribe headers
 *   getAttachment <account> <messageId> <attId> — fetch attachment bytes
 *   listDrafts <account>                        — list drafts
 *   readDraft <account> <draftId>               — read a draft
 *   markUnread <account> <messageId>            — add UNREAD label
 *   markRead <account> <messageId>              — remove UNREAD label
 *   star <account> <messageId>                  — add STARRED
 *   unstar <account> <messageId>                — remove STARRED
 *   forward <account> <messageId> <to>          — forward message
 *   sendSelf <account>                          — send a test email to self (returns id)
 *   permDelete <account> <messageId>            — permanently delete (no trash)
 *   unsub fire <account> <messageId>            — fire unsubscribe
 *   timing <account> <maxResults>               — time list_emails at given size
 */
import {
  forwardMessage,
  getAttachment,
  getMessage,
  searchMessages,
  listMessages,
  listDrafts,
  modifyMessage,
  readDraft,
  sendMessage,
  trashMessage,
  unsubscribeFromEmail,
} from '../src/gmail/client.js';
import { resolveAccount } from '../src/config.js';

const [cmd, account, a1, a2, a3] = process.argv.slice(2);

if (!cmd || !account) {
  console.error('Usage: tsx scripts/smoke.ts <command> <account> [args...]');
  process.exit(2);
}

async function main() {
  switch (cmd) {
    case 'search': {
      const results = await searchMessages({ query: a1, account, maxResults: 10 });
      console.log(JSON.stringify(results.map(r => ({ id: r.id, from: r.from, subject: r.subject })), null, 2));
      return;
    }
    case 'list': {
      const max = a1 ? parseInt(a1, 10) : 10;
      const results = await listMessages({ account, maxResults: max });
      console.log(JSON.stringify(results.map(r => ({ id: r.id, from: r.from, subject: r.subject })), null, 2));
      return;
    }
    case 'inspect': {
      const msg = await getMessage({ messageId: a1, account, format: 'full' });
      console.log(JSON.stringify({
        id: msg.id,
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        labels: msg.labels,
        attachments: msg.attachments,
        list_unsubscribe: msg.list_unsubscribe,
      }, null, 2));
      return;
    }
    case 'inspectUnsub': {
      const msg = await getMessage({ messageId: a1, account, format: 'full' });
      console.log(JSON.stringify({
        list_unsubscribe: msg.list_unsubscribe,
        list_unsubscribe_post: msg.list_unsubscribe_post,
      }, null, 2));
      return;
    }
    case 'timing': {
      const max = parseInt(a1 || '50', 10);
      const start = Date.now();
      const results = await listMessages({ account, maxResults: max });
      const elapsed = Date.now() - start;
      console.log(JSON.stringify({ count: results.length, ms: elapsed }, null, 2));
      return;
    }
    case 'unsub': {
      const fireCmd = a1;
      const messageId = a2;
      if (fireCmd !== 'fire') {
        console.error('Usage: smoke unsub fire <account> <messageId>');
        process.exit(2);
      }
      const result = await unsubscribeFromEmail({ messageId, account });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'whoami': {
      const resolved = resolveAccount(account);
      console.log(JSON.stringify(resolved, null, 2));
      return;
    }
    case 'markUnread': {
      const result = await modifyMessage({ messageId: a1, addLabelIds: ['UNREAD'], account });
      const after = await getMessage({ messageId: a1, account, format: 'metadata' });
      console.log(JSON.stringify({ modify: result, labels: after.labels }, null, 2));
      return;
    }
    case 'markRead': {
      const result = await modifyMessage({ messageId: a1, removeLabelIds: ['UNREAD'], account });
      const after = await getMessage({ messageId: a1, account, format: 'metadata' });
      console.log(JSON.stringify({ modify: result, labels: after.labels }, null, 2));
      return;
    }
    case 'toggleLabel': {
      // toggleLabel <account> <messageId> <add|remove> <LABEL>
      const op = a2;
      const label = a3;
      const result = await modifyMessage({
        messageId: a1,
        addLabelIds: op === 'add' ? [label] : undefined,
        removeLabelIds: op === 'remove' ? [label] : undefined,
        account,
      });
      const after = await getMessage({ messageId: a1, account, format: 'metadata' });
      console.log(JSON.stringify({ modify: result, labels: after.labels }, null, 2));
      return;
    }
    case 'getAttachment': {
      const result = await getAttachment({ messageId: a1, attachmentId: a2, account });
      // Don't print the whole base64; print metadata + a preview.
      console.log(JSON.stringify({
        attachmentId: result.attachmentId,
        size: result.size,
        data_base64_length: result.data_base64.length,
        data_base64_prefix: result.data_base64.slice(0, 60),
      }, null, 2));
      return;
    }
    case 'listDrafts': {
      const max = a1 ? parseInt(a1, 10) : 10;
      const results = await listDrafts({ account, maxResults: max });
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    case 'forward': {
      // forward <account> <messageId> <to>
      const result = await forwardMessage({
        messageId: a1,
        to: a2,
        account,
        body: '[smoke test forward]',
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'trash': {
      const result = await trashMessage({ messageId: a1, account });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'sendSelf': {
      const resolved = resolveAccount(account);
      const result = await sendMessage({
        to: resolved.email,
        subject: '[smoke test]',
        body: 'Smoke test message.',
        account,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'readDraft': {
      const result = await readDraft({ draftId: a1, account });
      const msg = result.message;
      console.log(JSON.stringify({
        draft_id: result.draft_id,
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        body_text_preview: msg.body_text.slice(0, 200),
        attachments: msg.attachments.map(a => ({ filename: a.filename, size: a.size })),
      }, null, 2));
      return;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error('See scripts/smoke.ts header for command list.');
      process.exit(2);
  }
}

main().catch(err => {
  console.error('Error:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
