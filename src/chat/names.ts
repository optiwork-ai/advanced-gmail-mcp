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
 * What a caller handed us when it asked to reply "into that thread".
 *
 * A thread can be named directly ("spaces/A/threads/T"), but the thing a
 * caller actually has in hand is usually a MESSAGE — the one it just read out
 * of `list_chat_messages` and wants to answer. A message name cannot be turned
 * into a thread name by string surgery (the two ids differ), so the caller is
 * told which kind it gave and looks the thread up when it is the second kind.
 */
export type ThreadTarget =
  | { kind: 'thread'; name: string }
  | { kind: 'message'; name: string };

/**
 * Work out which thread a reply is aimed at, from whatever the caller passed.
 *
 * Accepts, in the space given:
 *   - "spaces/A/threads/T" or the bare "threads/T" tail
 *   - "spaces/A/messages/M" — the thread is read from that message
 *   - a bare id ("T"), completed into "spaces/{space}/threads/T", on the same
 *     reasoning as `toSpaceParent`: a thread, like a message, is identified by
 *     its space too, and the space is already a required parameter here.
 */
export function toThreadTarget(spaceParent: string, thread: string): ThreadTarget {
  const trimmed = thread.trim();
  if (trimmed.length === 0) {
    throw new Error(
      'A Chat thread is required when "thread" is passed — give either '
      + '"spaces/{space}/threads/{thread}" or the name of a message in the thread '
      + '("spaces/{space}/messages/{message}", exactly as list_chat_messages returns it).',
    );
  }

  // A fully-qualified name belonging to a DIFFERENT space is refused rather
  // than quietly re-pointed at this one: a thread lives in exactly one space,
  // and posting the reply into the other space is not a smaller mistake than
  // failing.
  if (trimmed.startsWith('spaces/') && !trimmed.startsWith(`${spaceParent}/`)) {
    throw new Error(
      `"${trimmed}" belongs to a different Chat space than "${spaceParent}". A thread lives in `
      + 'one space only — pass the space that thread is in, or drop the thread to start a new one.',
    );
  }

  // "messages/M" and "threads/T" are matched wherever they appear, so the tail
  // of a name ("threads/T") is accepted as readily as the whole of one. The id
  // after the segment is what identifies it; anything before is the space, and
  // the space is a parameter here already.
  const messageMatch = /(?:^|\/)messages\/([^/]+)$/.exec(trimmed);
  if (messageMatch) return { kind: 'message', name: `${spaceParent}/messages/${messageMatch[1]}` };

  const threadMatch = /(?:^|\/)threads\/([^/]+)$/.exec(trimmed);
  if (threadMatch) return { kind: 'thread', name: `${spaceParent}/threads/${threadMatch[1]}` };

  return { kind: 'thread', name: `${spaceParent}/threads/${trimmed}` };
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
