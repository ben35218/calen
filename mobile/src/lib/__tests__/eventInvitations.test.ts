// The `['invitations']` query — its contents, and the invariant that keeps them
// correct (households-sharing.md → "One key, one fetcher").
//
// The bug: three surfaces read this cache key (the inbox, the badge count on
// the calendar home + Profile, and the event form's "who invited me" line), but
// only the inbox's copy decrypted the D3 sealed snapshot. React Query caches by
// KEY, so whichever observer happened to trigger a fetch decided what all three
// got — and the badge is mounted almost always, so a badge refetch replaced the
// cache with undecrypted rows. The inbox, opened seconds later, served them
// under its own staleTime and rendered "Unlock to view this invitation" on a
// fully unlocked vault. Pull-to-refresh fixed it only because that fetch was
// driven by the inbox's own observer.

const mockList = jest.fn();
jest.mock('../../api', () => ({
  invitationsApi: { list: () => mockList() },
}));

const mockOpen = jest.fn();
jest.mock('../e2ee', () => ({
  openInvitationSnapshot: (blob: string) => mockOpen(blob),
}));

import { EVENT_INVITATIONS_KEY, fetchEventInvitations } from '../eventInvitations';

// Node built-ins for the source scan at the bottom. This is a React Native
// tsconfig with no node types, so declare exactly what's used here rather than
// widening the whole project's type surface for one test.
declare const __dirname: string;
type Dirent = { name: string; isDirectory(): boolean };
const fs = require('fs') as {
  readdirSync(dir: string, opts: { withFileTypes: true }): Dirent[];
  readFileSync(file: string, enc: string): string;
};
const path = require('path') as {
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
};

const SEALED = { _id: 'i1', sealedEvent: 'sealed-blob', status: 'pending' };
const PLAINTEXT = { _id: 'i2', event: { title: 'Potluck', startDate: '2026-08-20T17:00:00.000Z' }, status: 'pending' };

beforeEach(() => {
  mockList.mockReset();
  mockOpen.mockReset();
});

describe('fetchEventInvitations', () => {
  it('opens a sealed snapshot into the plaintext `event` the rows render from', async () => {
    mockList.mockResolvedValue({ data: [SEALED] });
    mockOpen.mockResolvedValue({ title: 'Birthday', startDate: '2026-08-21T17:00:00.000Z' });

    const [row] = await fetchEventInvitations();

    expect(mockOpen).toHaveBeenCalledWith('sealed-blob');
    expect(row.event?.title).toBe('Birthday');
  });

  // Cheap for the badge and the event form, which don't need the content: a row
  // that is already readable never costs an unseal.
  it('passes a plaintext invitation through without unsealing anything', async () => {
    mockList.mockResolvedValue({ data: [PLAINTEXT] });

    const [row] = await fetchEventInvitations();

    expect(mockOpen).not.toHaveBeenCalled();
    expect(row.event?.title).toBe('Potluck');
  });

  // A blob not sealed to us, or a genuinely locked vault. The row must survive —
  // it still counts toward the badge and still renders its "who invited you"
  // line; only the event details are withheld.
  it('keeps the invitation when the snapshot cannot be opened', async () => {
    mockList.mockResolvedValue({ data: [SEALED] });
    mockOpen.mockResolvedValue(null);

    const rows = await fetchEventInvitations();

    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBeUndefined();
  });
});

// The structural half of the fix. Behavior tests can't catch this class: each
// reader is individually correct, and the defect only exists in the RELATIONSHIP
// between them. A fourth surface inlining `queryKey: ['invitations']` with its
// own fetcher would silently reintroduce the padlock bug, so pin the invariant
// where it actually lives — in the source.
describe('one key, one fetcher', () => {
  const SRC = path.join(__dirname, '..', '..');

  const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(full);
      return /\.tsx?$/.test(e.name) ? [full] : [];
    });

  // Invalidations count too: `['invitations']` written inline anywhere is a
  // place the next reader will copy from, and copying is how the second fetcher
  // got there. Every reference goes through the constant.
  it('is written down in exactly one place — no file inlines the key', () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => path.relative(SRC, f) !== path.join('lib', 'eventInvitations.ts'))
      .filter((f) => /queryKey:\s*\[\s*['"]invitations['"]\s*\]/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f));

    expect(offenders).toEqual([]);
  });

  it('exports the key the readers share', () => {
    expect(EVENT_INVITATIONS_KEY).toEqual(['invitations']);
  });
});
