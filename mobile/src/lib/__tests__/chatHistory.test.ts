jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  CHAT_RETENTION_MS,
  chatTitle,
  consumeResumeFor,
  filterChats,
  loadAllRecentChats,
  loadRecentChats,
  newChatId,
  peekResume,
  relativeChatTime,
  requestResume,
  saveChat,
  surfaceToTab,
  surfaceTripId,
} from '../chatHistory';
import type { ChatMessage } from '../../hooks/useChat';

const NOW = 1_800_000_000_000;
const msg = (role: 'user' | 'assistant', content: string): ChatMessage => ({ role, content });

describe('chatHistory (device-local, 7 days)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('saveChat stores a conversation retrievable via loadRecentChats, newest first', async () => {
    await saveChat('u1', 'calendar', { id: 'a', messages: [msg('user', 'first chat')] }, NOW - 1000);
    await saveChat('u1', 'calendar', { id: 'b', messages: [msg('user', 'second chat')] }, NOW);
    const chats = await loadRecentChats('u1', 'calendar', NOW);
    expect(chats.map((c) => c.id)).toEqual(['b', 'a']);
    expect(chats[1].title).toBe('first chat');
  });

  it('re-saving the same id upserts (no duplicate) and bumps it to the top', async () => {
    await saveChat('u1', 'calendar', { id: 'a', messages: [msg('user', 'hello')] }, NOW - 2000);
    await saveChat('u1', 'calendar', { id: 'b', messages: [msg('user', 'other')] }, NOW - 1000);
    await saveChat(
      'u1',
      'calendar',
      { id: 'a', messages: [msg('user', 'hello'), msg('assistant', 'hi!')] },
      NOW
    );
    const chats = await loadRecentChats('u1', 'calendar', NOW);
    expect(chats.map((c) => c.id)).toEqual(['a', 'b']);
    expect(chats[0].messages).toHaveLength(2);
  });

  it('drops conversations older than 7 days', async () => {
    await saveChat('u1', 'calendar', { id: 'old', messages: [msg('user', 'stale')] }, NOW - CHAT_RETENTION_MS - 1);
    await saveChat('u1', 'calendar', { id: 'new', messages: [msg('user', 'fresh')] }, NOW - CHAT_RETENTION_MS + 60_000);
    const chats = await loadRecentChats('u1', 'calendar', NOW);
    expect(chats.map((c) => c.id)).toEqual(['new']);
  });

  it('strips attachment base64 payloads but keeps metadata for the bubble', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'here is a photo',
        attachments: [{ name: 'p.jpg', type: 'image/jpeg', kind: 'image', uri: 'file://p.jpg', data: 'AAAA' }],
      },
    ];
    const [chat] = await saveChat('u1', 'calendar', { id: 'a', messages }, NOW);
    expect(chat.messages[0].attachments![0]).toEqual({
      name: 'p.jpg',
      type: 'image/jpeg',
      kind: 'image',
      uri: 'file://p.jpg',
    });
  });

  it("persists each assistant turn's inline chips + drafted record for resume", async () => {
    // Chips/drafts live ON the assistant message, so persisting messages persists
    // them — a resumed chat keeps every past turn's inline affordances.
    const assistant: ChatMessage = {
      role: 'assistant',
      content: 'Drafted it.',
      followups: ['Save this to my calendar', 'Edit in form'],
      navSuggestions: [{ view: 'calendar', label: 'Open calendar' }],
      pendingEvent: { title: 'Dentist', calendarType: 'appointments', date: '2026-08-04' },
      usedActions: ['Save this to my calendar'], // already created — chip disabled
    };
    await saveChat('u1', 'calendar', { id: 'a', messages: [msg('user', 'dentist tuesday'), assistant] }, NOW);
    const [reloaded] = await loadRecentChats('u1', 'calendar', NOW);
    const restored = reloaded.messages[1];
    expect(restored.followups).toEqual(['Save this to my calendar', 'Edit in form']);
    expect(restored.navSuggestions).toEqual([{ view: 'calendar', label: 'Open calendar' }]);
    expect(restored.pendingEvent).toMatchObject({ title: 'Dentist', date: '2026-08-04' });
    // A used direct-create chip stays recorded as used, so a resume renders it
    // disabled and can't re-create the event.
    expect(restored.usedActions).toEqual(['Save this to my calendar']);
  });

  it('isolates history per user and per surface', async () => {
    await saveChat('u1', 'calendar', { id: 'a', messages: [msg('user', 'mine')] }, NOW);
    expect(await loadRecentChats('u2', 'calendar', NOW)).toEqual([]);
    expect(await loadRecentChats('u1', 'chores', NOW)).toEqual([]);
    expect((await loadRecentChats('u1', 'calendar', NOW))).toHaveLength(1);
  });

  it('caps stored conversations per surface', async () => {
    for (let i = 0; i < 55; i++) {
      await saveChat('u1', 'calendar', { id: `c${i}`, messages: [msg('user', `chat ${i}`)] }, NOW - 55_000 + i * 1000);
    }
    const chats = await loadRecentChats('u1', 'calendar', NOW);
    expect(chats).toHaveLength(50);
    expect(chats[0].id).toBe('c54'); // newest kept, oldest dropped
  });

  it('chatTitle uses the first user line, truncated; falls back to the attachment name', () => {
    expect(chatTitle([msg('user', '  Add a dentist appointment\nplease  ')])).toBe('Add a dentist appointment');
    expect(chatTitle([msg('user', 'x'.repeat(80))])).toHaveLength(60);
    expect(
      chatTitle([{ role: 'user', content: '', attachments: [{ name: 'invoice.pdf', type: 'application/pdf', kind: 'document' }] }])
    ).toBe('invoice.pdf');
    expect(chatTitle([])).toBe('New chat');
  });

  it('relativeChatTime buckets: just now, minutes, hours, days', () => {
    expect(relativeChatTime(NOW - 30_000, NOW)).toBe('Just now');
    expect(relativeChatTime(NOW - 12 * 60_000, NOW)).toBe('12m ago');
    expect(relativeChatTime(NOW - 3 * 60 * 60_000, NOW)).toBe('3h ago');
    expect(relativeChatTime(NOW - 23 * 60 * 60_000, NOW)).toBe('23h ago');
    expect(relativeChatTime(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe('2d ago');
  });

  it('newChatId is unique-ish', () => {
    expect(newChatId()).not.toBe(newChatId());
  });
});

describe('surfaceToTab / surfaceTripId', () => {
  it('maps each surface key to its assistant tab', () => {
    expect(surfaceToTab('calendar')).toBe('calendar');
    expect(surfaceToTab('chores')).toBe('chores');
    expect(surfaceToTab('maintenance-plan')).toBe('maintenance');
    expect(surfaceToTab('trips:abc123')).toBe('trips');
    expect(surfaceToTab('gibberish')).toBeNull();
  });

  it('extracts the trip id only from a trips surface', () => {
    expect(surfaceTripId('trips:abc123')).toBe('abc123');
    expect(surfaceTripId('calendar')).toBeNull();
  });
});

describe('loadAllRecentChats (unified across surfaces)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('merges every surface, newest first, each tagged with surface + tab', async () => {
    await saveChat('u1', 'calendar', { id: 'cal', messages: [msg('user', 'dentist')] }, NOW - 3000);
    await saveChat('u1', 'chores', { id: 'cho', messages: [msg('user', 'trash')] }, NOW - 1000);
    await saveChat('u1', 'maintenance-plan', { id: 'mnt', messages: [msg('user', 'furnace')] }, NOW - 2000);
    await saveChat('u1', 'trips:paris', { id: 'trp', messages: [msg('user', 'itinerary')] }, NOW - 4000);

    const all = await loadAllRecentChats('u1', NOW);
    expect(all.map((c) => c.id)).toEqual(['cho', 'mnt', 'cal', 'trp']); // newest → oldest
    const byId = Object.fromEntries(all.map((c) => [c.id, c]));
    expect(byId.cal).toMatchObject({ surfaceKey: 'calendar', tab: 'calendar' });
    expect(byId.mnt).toMatchObject({ surfaceKey: 'maintenance-plan', tab: 'maintenance' });
    expect(byId.trp).toMatchObject({ surfaceKey: 'trips:paris', tab: 'trips' });
  });

  it('scopes to the user and drops expired chats', async () => {
    await saveChat('u1', 'calendar', { id: 'mine', messages: [msg('user', 'a')] }, NOW);
    await saveChat('u2', 'calendar', { id: 'theirs', messages: [msg('user', 'b')] }, NOW);
    await saveChat('u1', 'chores', { id: 'stale', messages: [msg('user', 'c')] }, NOW - CHAT_RETENTION_MS - 1);

    const all = await loadAllRecentChats('u1', NOW);
    expect(all.map((c) => c.id)).toEqual(['mine']);
  });
});

describe('filterChats (Recent-chats keyword search)', () => {
  const chats = [
    { id: 'a', title: 'Dentist appointment', updatedAt: NOW, messages: [msg('user', 'book a dentist for June'), msg('assistant', 'Done — Tuesday at 3pm')] },
    { id: 'b', title: 'Paris trip', updatedAt: NOW, messages: [msg('user', 'find a hotel near the Louvre')] },
    { id: 'c', title: 'Trash chore', updatedAt: NOW, messages: [msg('user', 'weekly trash reminder')] },
  ];

  it('returns everything for a blank query', () => {
    expect(filterChats(chats, '')).toHaveLength(3);
    expect(filterChats(chats, '   ')).toHaveLength(3);
  });

  it('matches the title case-insensitively', () => {
    expect(filterChats(chats, 'PARIS').map((c) => c.id)).toEqual(['b']);
  });

  it('matches text inside any message, not just the title', () => {
    expect(filterChats(chats, 'louvre').map((c) => c.id)).toEqual(['b']);
    expect(filterChats(chats, 'tuesday').map((c) => c.id)).toEqual(['a']);
  });

  it('requires every whitespace-separated token to appear (AND, any order)', () => {
    expect(filterChats(chats, 'hotel paris').map((c) => c.id)).toEqual(['b']);
    expect(filterChats(chats, 'paris dentist')).toEqual([]); // no single chat has both
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterChats(chats, 'zzz')).toEqual([]);
  });

  it('preserves order and surface tags of the input rows', () => {
    const tagged = [
      { ...chats[1], surfaceKey: 'trips:paris', tab: 'trips' as const },
      { ...chats[0], surfaceKey: 'calendar', tab: 'calendar' as const },
    ];
    const out = filterChats(tagged, 'a'); // 'a' appears in both
    expect(out.map((c) => c.surfaceKey)).toEqual(['trips:paris', 'calendar']);
  });
});

describe('cross-surface resume hand-off', () => {
  beforeEach(() => {
    // Drain any parked request between tests.
    consumeResumeFor('calendar');
    consumeResumeFor('chores');
  });

  it('a parked request is peekable, then consumed by its own surface exactly once', () => {
    requestResume('chores', 'chat-9');
    expect(peekResume()).toEqual({ surfaceKey: 'chores', chatId: 'chat-9' });
    // A different surface never steals it.
    expect(consumeResumeFor('calendar')).toBeNull();
    expect(consumeResumeFor('chores')).toBe('chat-9');
    // Cleared after one read — no replay.
    expect(consumeResumeFor('chores')).toBeNull();
    expect(peekResume()).toBeNull();
  });
});
