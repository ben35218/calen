import type { Contact } from '../api';

export interface AssigneeOption {
  value: string;
  label: string;
}

export interface AssigneeArgs {
  /** The decrypted contacts roster (contacts + the household's self-Contacts). */
  contacts: Contact[];
  /** User ids of the current household's members (`GET /household` → members). */
  memberIds: string[];
  /** The signed-in user's id — always a member, even offline. */
  myId: string;
  /** The chore's existing assignee, so a legacy/non-member one stays visible. */
  currentAssigneeId?: string | null;
}

const idOf = (v: unknown) => (v == null ? '' : String(v));

/**
 * A chore is assigned to someone who lives here, never to a contact.
 * `Chore.assignedTo` refs a Contact, so the options are the self-Contacts of the
 * household's member accounts (`accountId`), you first then alphabetical. A solo
 * household — or an offline/404 household fetch — leaves just you.
 */
export function choreAssigneeOptions({ contacts, memberIds, myId, currentAssigneeId }: AssigneeArgs): AssigneeOption[] {
  const members = new Set([...memberIds.map(idOf), idOf(myId)].filter(Boolean));
  const isMe = (p: Contact) => !!myId && idOf(p.accountId) === idOf(myId);

  const options = contacts
    .filter((p) => p.accountId && members.has(idOf(p.accountId)))
    .sort((a, b) => {
      if (isMe(a) !== isMe(b)) return isMe(a) ? -1 : 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    })
    .map((p) => ({
      value: idOf(p._id),
      label: isMe(p) ? `${p.name || 'You'} (You)` : p.name || 'Household member',
    }));

  // A chore assigned before this rule (or to someone since removed from the
  // household) keeps showing its assignee instead of silently reading as
  // "Unassigned" — it just isn't offered as a new choice.
  const current = idOf(currentAssigneeId);
  if (current && !options.some((o) => o.value === current)) {
    const legacy = contacts.find((p) => idOf(p._id) === current);
    if (legacy) options.push({ value: current, label: legacy.name || 'Unknown' });
  }
  return options;
}

// The assistant never knows the user's name (no roster is sent to it), so
// "assign it to me" reaches the device as a self-reference, not a name.
const SELF_REFERENCES = new Set(['me', 'myself', 'you', 'yourself', 'self', 'the user', 'user']);

/**
 * Resolve an assistant draft's `assignedToName` to a member option. The model
 * only ever echoes what the user typed — a name, or a self-reference ("me",
 * "you"), which resolves to the signed-in user's own "(You)"-suffixed option.
 * For names, an exact label match wins, else a first-name match; the "(You)"
 * suffix is ignored while comparing.
 */
export function matchAssigneeByName(options: AssigneeOption[], name: string): AssigneeOption | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/\s*\(you\)$/, '').trim();
  const target = name.toLowerCase().trim();
  if (!target) return undefined;
  if (SELF_REFERENCES.has(target)) return options.find((o) => /\(you\)\s*$/i.test(o.label));
  return (
    options.find((o) => norm(o.label) === target) ??
    options.find((o) => norm(o.label).split(/\s+/)[0] === target)
  );
}
