import type { Person } from '../api';

export interface AssigneeOption {
  value: string;
  label: string;
}

export interface AssigneeArgs {
  /** The decrypted people roster (contacts + the household's self-Persons). */
  people: Person[];
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
 * `Chore.assignedTo` refs a Person, so the options are the self-Persons of the
 * household's member accounts (`accountId`), you first then alphabetical. A solo
 * household — or an offline/404 household fetch — leaves just you.
 */
export function choreAssigneeOptions({ people, memberIds, myId, currentAssigneeId }: AssigneeArgs): AssigneeOption[] {
  const members = new Set([...memberIds.map(idOf), idOf(myId)].filter(Boolean));
  const isMe = (p: Person) => !!myId && idOf(p.accountId) === idOf(myId);

  const options = people
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
    const legacy = people.find((p) => idOf(p._id) === current);
    if (legacy) options.push({ value: current, label: legacy.name || 'Unknown' });
  }
  return options;
}
