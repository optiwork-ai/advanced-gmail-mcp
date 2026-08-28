import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListEmails } from './list.js';
import { registerSearchEmails } from './search.js';
import { registerReadEmail } from './read.js';
import { registerGetThread } from './thread.js';
import { registerModifyThread } from './modify-thread.js';
import { registerTrashThread } from './trash-thread.js';
import { registerGetLabels } from './labels.js';
import { registerGetHistoryBaseline } from './history-baseline.js';
import { registerGetMailChanges } from './mail-changes.js';
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
import { registerUpdateDraft } from './update-draft.js';
import { registerDeleteDraft } from './delete-draft.js';
import { registerForwardEmail } from './forward.js';
import { registerStarTools } from './star.js';
import { registerCreateLabel } from './create-label.js';
import { registerUpdateLabel } from './update-label.js';
import { registerDeleteLabel } from './delete-label.js';
// Mailbox settings (gmail.settings.basic)
import { registerFilterTools } from './filters.js';
import { registerVacationTools } from './vacation.js';
// Read-only Chat / Drive / Docs tools
import { registerListChatSpaces } from './chat-list-spaces.js';
import { registerListChatMessages } from './chat-list-messages.js';
import { registerGetChatMessage } from './chat-get-message.js';
import { registerSearchDriveFiles } from './drive-search-files.js';
import { registerReadDriveFile } from './drive-read-file.js';
import { registerUploadDriveFile } from './drive-upload-file.js';
import { registerGetGoogleDoc } from './docs-get-document.js';
import { registerUpdateGoogleDoc } from './docs-update-document.js';
// Calendar tools (three read-only + create_calendar_event)
import { registerListCalendars } from './calendar-list-calendars.js';
import { registerListCalendarEvents } from './calendar-list-events.js';
import { registerGetFreebusy } from './calendar-freebusy.js';
import { registerCreateCalendarEvent } from './calendar-create-event.js';

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

  // Mail-arrival watching: a cursor to poll from, and what changed since it.
  // Stateless — the caller stores the cursor between polls.
  registerGetHistoryBaseline(server);
  registerGetMailChanges(server);

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
  registerModifyThread(server);
  registerTrashThread(server);
  registerBatchModify(server);
  registerUnsubscribe(server);
  registerMarkRead(server);
  registerMarkUnread(server);
  registerGetAttachment(server);
  registerListDrafts(server);
  registerReadDraft(server);
  registerUpdateDraft(server);
  registerDeleteDraft(server);
  registerForwardEmail(server);
  registerStarTools(server);
  registerCreateLabel(server);
  registerUpdateLabel(server);
  registerDeleteLabel(server);

  // Mailbox settings. These need gmail.settings.basic, added 2026-08-27, so
  // they 403 on every alias until it re-consents. set_vacation is the outward
  // one: while the responder is on, the account replies to strangers by itself.
  registerFilterTools(server);
  registerVacationTools(server);

  // Chat / Drive / Docs. Chat stays strictly read-only. Drive has exactly one
  // write — upload_drive_file — under the narrow drive.file scope, which
  // reaches only the files this server creates. Docs gained one write on
  // 2026-08-28 — update_google_doc — under the `documents` scope that replaced
  // `documents.readonly`; its surface is append-text and find-replace only.
  registerListChatSpaces(server);
  registerListChatMessages(server);
  registerGetChatMessage(server);
  registerSearchDriveFiles(server);
  registerReadDriveFile(server);
  registerUploadDriveFile(server);
  registerGetGoogleDoc(server);
  registerUpdateGoogleDoc(server);

  // Calendar: three read-only tools plus create_calendar_event, whose
  // send_updates defaults to 'none' so the default path emails nobody.
  registerListCalendars(server);
  registerListCalendarEvents(server);
  registerGetFreebusy(server);
  registerCreateCalendarEvent(server);
}
