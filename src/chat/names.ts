/**
 * Chat resource-name normalization, shared by every Chat tool.
 *
 * The two message tools used to disagree: `list_chat_messages` accepted either
 * a bare space id ("AAAA") or a full resource name, while `get_chat_message`
 * accepted only "spaces/A/messages/B". Handing the second tool an id the first
 * had just accepted failed with a raw Google error about a malformed name. One
 * module so the acceptance cannot drift apart again.
 */

/**
 * CP-4 — every id in this module ends up in a PATH PARAMETER of a Google API
 * call, and the client builds those URLs by reserved URI-template expansion
 * ('/v1/{+parent}/messages'), which does not percent-encode "/", "?", ":" or
 * "#". An unchecked id therefore re-targets the request instead of being
 * refused:
 *
 *   'spaces/AAA?key=v'                       -> /v1/spaces/AAA?key=v/messages
 *   'spaces/../../v1/spaces/BBB/messages/X'  -> a different resource entirely
 *
 * The realistic case needs no attacker: a model passes a Chat web link, a
 * display name or a message name where a space id belongs, and instead of
 * "that is not a space id" the request goes out mangled and comes back as a
 * raw Google error nobody can act on. post_chat_message refuses an empty
 * message, an over-length one, contradictory thread arguments and a
 * cross-space thread before any network call; the field deciding WHICH SPACE a
 * public message is published into is checked here on the same principle.
 *
 * The shape is deliberately narrow — letters, digits, "-", "_" and "." — and
 * a leading "." is barred so that "." and ".." cannot pass. Real Chat ids
 * ("AAAAj0dJ1ac", "xyz.abc") fit inside it.
 */
const CHAT_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** Refuse an id that is not a bare Chat id, saying what one looks like. */
function checkChatId(id: string, kind: 'space' | 'thread' | 'message', whole: string): string {
  if (CHAT_ID.test(id)) return id;
  throw new Error(
    `"${whole}" is not a usable Chat ${kind} name: "${id}" is not a ${kind} id. A Chat id is `
    + 'letters, digits, "-", "_" and "." only — no slashes, no "?", no "#", and not a URL, '
    + 'because the id is put straight into the address of the request. Ids come back from '
    + 'list_chat_spaces and list_chat_messages in exactly the form Google wants '
    + '(for example "spaces/AAAAj0dJ1ac/messages/xyz.abc"); a Chat web link or a space\'s '
    + 'display name is not one.',
  );
}

/** Normalize a space id or full resource name into "spaces/{space}". */
export function toSpaceParent(space: string): string {
  const trimmed = space.trim();
  if (trimmed.length === 0) {
    throw new Error('A Chat space is required — pass either "spaces/{space}" or the bare space id.');
  }
  const id = trimmed.startsWith('spaces/') ? trimmed.slice('spaces/'.length) : trimmed;
  return `spaces/${checkChatId(id, 'space', trimmed)}`;
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
  if (messageMatch) {
    const id = checkChatId(messageMatch[1], 'message', trimmed);
    return { kind: 'message', name: `${spaceParent}/messages/${id}` };
  }

  const threadMatch = /(?:^|\/)threads\/([^/]+)$/.exec(trimmed);
  if (threadMatch) {
    const id = checkChatId(threadMatch[1], 'thread', trimmed);
    return { kind: 'thread', name: `${spaceParent}/threads/${id}` };
  }

  return { kind: 'thread', name: `${spaceParent}/threads/${checkChatId(trimmed, 'thread', trimmed)}` };
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
  const qualified = trimmed.startsWith('spaces/')
    ? trimmed
    : trimmed.includes('/messages/') ? `spaces/${trimmed}` : undefined;

  if (qualified) {
    // Both halves are checked, because both are path segments of the request.
    const parts = /^spaces\/([^/]+)\/messages\/([^/]+)$/.exec(qualified);
    if (!parts) {
      throw new Error(
        `"${trimmed}" is not a usable Chat message name. It should read `
        + '"spaces/{space}/messages/{message}" and nothing else — list_chat_messages returns '
        + 'exactly that in each message\'s "name" field.',
      );
    }
    checkChatId(parts[1], 'space', trimmed);
    checkChatId(parts[2], 'message', trimmed);
    return qualified;
  }

  throw new Error(
    `"${trimmed}" is not enough to find a Chat message: a message is identified by its space `
    + 'too. Pass the full name in the form "spaces/{space}/messages/{message}" — '
    + 'list_chat_messages returns exactly that in each message\'s "name" field.',
  );
}
