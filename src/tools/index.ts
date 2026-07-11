import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListEmails } from './list.js';
import { registerSearchEmails } from './search.js';
import { registerReadEmail } from './read.js';
import { registerGetThread } from './thread.js';
import { registerGetLabels } from './labels.js';
import { registerSendEmail } from './send.js';
import { registerDraftEmail } from './draft.js';
import { registerReplyEmail } from './reply.js';
import { registerDraftReply } from './draft-reply.js';
import { registerSendDraft } from './send-draft.js';
import { registerArchiveEmail } from './archive.js';
import { registerLabelEmail } from './label.js';
import { registerTrashEmail } from './trash.js';
import { registerBatchModify } from './batch.js';
import { registerUnsubscribe } from './unsubscribe.js';
import { registerMarkRead } from './mark-read.js';
import { registerMarkUnread } from './mark-unread.js';
import { registerGetAttachment } from './get-attachment.js';
import { registerListDrafts } from './list-drafts.js';
import { registerReadDraft } from './read-draft.js';
import { registerForwardEmail } from './forward.js';
import { registerStarTools } from './star.js';
import { registerCreateLabel } from './create-label.js';
import { registerUpdateLabel } from './update-label.js';
import { registerDeleteLabel } from './delete-label.js';
// Read-only Chat / Drive / Docs tools
import { registerListChatSpaces } from './chat-list-spaces.js';
import { registerListChatMessages } from './chat-list-messages.js';
import { registerGetChatMessage } from './chat-get-message.js';
import { registerListChatMembers } from './chat-list-members.js';

/**
 * Register all Gmail MCP tools with the server.
 */
export function registerAllTools(server: McpServer): void {
  // Read-only tools
  registerListEmails(server);
  registerSearchEmails(server);
  registerReadEmail(server);
  registerGetThread(server);
  registerGetLabels(server);

  // Write tools
  registerSendEmail(server);
  registerDraftEmail(server);
  registerReplyEmail(server);
  registerDraftReply(server);
  registerSendDraft(server);

  // Modify tools
  registerArchiveEmail(server);
  registerLabelEmail(server);
  registerTrashEmail(server);
  registerBatchModify(server);
  registerUnsubscribe(server);
  registerMarkRead(server);
  registerMarkUnread(server);
  registerGetAttachment(server);
  registerListDrafts(server);
  registerReadDraft(server);
  registerForwardEmail(server);
  registerStarTools(server);
  registerCreateLabel(server);
  registerUpdateLabel(server);
  registerDeleteLabel(server);

  // Read-only Chat / Drive / Docs tools (no send/post/create/update/delete)
  registerListChatSpaces(server);
  registerListChatMessages(server);
  registerGetChatMessage(server);
  registerListChatMembers(server);
}
