/**
 * Chat resource-name normalization, shared by every Chat tool.
 *
 * The two message tools used to disagree: `list_chat_messages` accepted either
 * a bare space id ("AAAA") or a full resource name, while `get_chat_message`
 * accepted only "spaces/A/messages/B". Handing the second tool an id the first
 * had just accepted failed with a raw Google error about a malformed name. One
 * module so the acceptance cannot drift apart again.
 */

/** Normalize a space id or full resource name into "spaces/{space}". */
export function toSpaceParent(space: string): string {
  const trimmed = space.trim();
  if (trimmed.length === 0) {
    throw new Error('A Chat space is required — pass either "spaces/{space}" or the bare space id.');
  }
  return trimmed.startsWith('spaces/') ? trimmed : `spaces/${trimmed}`;
}

/**
 * Normalize a Chat message name into "spaces/{space}/messages/{message}".
 *
 * A bare message id cannot be completed here — a message is identified by its
 * space as well — so that case is refused with a sentence saying so, rather
 * than being passed to Google to fail as a malformed resource name.
 */
export function toMessageName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error(
      'A Chat message name is required, in the form "spaces/{space}/messages/{message}" '
      + '(get it from list_chat_messages).',
    );
  }
  if (trimmed.startsWith('spaces/')) return trimmed;
  if (trimmed.includes('/messages/')) return `spaces/${trimmed}`;

  throw new Error(
    `"${trimmed}" is not enough to find a Chat message: a message is identified by its space `
    + 'too. Pass the full name in the form "spaces/{space}/messages/{message}" — '
    + 'list_chat_messages returns exactly that in each message\'s "name" field.',
  );
}
