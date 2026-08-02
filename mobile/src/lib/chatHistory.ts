import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatAttachment, ChatMessage } from '../hooks/useChat';

// Device-local chat history for the assistant surfaces (spec ai-assistant.md).
// Conversations live ONLY on this device (AsyncStorage) — never on the server —
// so the chat API stays stateless and no transcript exists server-side beyond
// the in-flight request (the E2EE / AI-data-minimization posture). Retention is
// deliberately short: 7 days — enough to pick a thread back up within the week,
// not an archive. Keys are scoped per user AND per surface so accounts sharing
// a device never see each other's chats and each assistant lists only its own.

export interface StoredChat {
  id: string;
  // First line of the first user message (or its attachment's name) — the row
  // label in the Recent-chats sheet.
  title: string;
  // The full conversation. Chips (follow-ups / nav suggestions) and drafted
  // records ride on the assistant messages themselves (see ChatMessage), so
  // persisting the messages persists — and a resume restores — every past turn's
  // inline affordances, including which action chips were already used.
  messages: ChatMessage[];
  updatedAt: number; // epoch ms of the last turn (or resume)
}

// A stored chat annotated with where it came from — used by the unified
// Recent-chats sheet, which lists every assistant's chats together. `surfaceKey`
// is the raw storage suffix (e.g. 'calendar', 'maintenance-plan',
// `trips:<tripId>`); `tab` is the assistant it belongs to, driving the row's
// leading tab icon and the resume target.
export interface StoredChatWithSurface extends StoredChat {
  surfaceKey: string;
  tab: AssistantTabId;
}

// The four chat assistants that keep history. Deliberately a local string union
// (not imported from screens/) so this lib stays free of UI dependencies.
export type AssistantTabId = 'calendar' | 'chores' | 'maintenance' | 'trips';

export const CHAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Safety cap per surface so a chatty week can't grow the record unboundedly.
const MAX_CHATS = 50;
const TITLE_MAX = 60;

const KEY_ROOT = 'hc_chat_history';
const keyPrefix = (userId: string) => `${KEY_ROOT}:${userId}:`;
const storageKey = (userId: string, surface: string) => `${keyPrefix(userId)}${surface}`;

// Which assistant a surface key belongs to. The maintenance-plan chat stores
// under 'maintenance-plan' but lives on the 'maintenance' tab, and every
// per-trip surface (`trips:<id>`) maps to the single 'trips' tab. Returns null
// for an unrecognized surface so a stray key never crashes the sheet.
export function surfaceToTab(surfaceKey: string): AssistantTabId | null {
  if (surfaceKey === 'calendar') return 'calendar';
  if (surfaceKey === 'chores') return 'chores';
  if (surfaceKey === 'maintenance-plan') return 'maintenance';
  if (surfaceKey.startsWith('trips:')) return 'trips';
  return null;
}

// The trip id embedded in a `trips:<id>` surface key (else null) — lets the
// resume handler pre-select the trip before dropping into its assistant.
export function surfaceTripId(surfaceKey: string): string | null {
  return surfaceKey.startsWith('trips:') ? surfaceKey.slice('trips:'.length) : null;
}

export function newChatId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Attachment base64 payloads are large and only needed for the turn that sent
// them (the server renders a data-less history attachment as a "[Attached
// file…]" note) — persist the metadata + local uri for the bubble thumbnail,
// drop the bytes.
function stripAttachment(a: ChatAttachment): ChatAttachment {
  const { data: _data, ...rest } = a;
  return rest;
}

function stripForStorage(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.attachments?.length ? { ...m, attachments: m.attachments.map(stripAttachment) } : m
  );
}

export function chatTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  const text = first?.content.trim().split('\n')[0].trim();
  if (text) return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
  const attachment = first?.attachments?.[0];
  return attachment?.name || 'New chat';
}

function prune(chats: StoredChat[], now: number): StoredChat[] {
  return chats
    .filter((c) => c.messages.length > 0 && now - c.updatedAt < CHAT_RETENTION_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CHATS);
}

async function readAll(userId: string, surface: string): Promise<StoredChat[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(userId, surface));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Recent (≤7 days old) chats, newest first. Read-only — expired entries are
// dropped from the returned list here and from disk on the next save.
export async function loadRecentChats(
  userId: string,
  surface: string,
  now: number = Date.now()
): Promise<StoredChat[]> {
  return prune(await readAll(userId, surface), now);
}

// Every recent (≤7 days old) chat across ALL of this user's assistant surfaces,
// newest first, each tagged with its surface + tab. Backs the unified
// Recent-chats sheet, which lists calendar/chores/maintenance/trip chats
// together. The per-surface MAX_CHATS cap is applied on save, not here.
export async function loadAllRecentChats(
  userId: string,
  now: number = Date.now()
): Promise<StoredChatWithSurface[]> {
  const prefix = keyPrefix(userId);
  let keys: readonly string[] = [];
  try {
    keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix));
  } catch {
    return [];
  }
  if (keys.length === 0) return [];

  const out: StoredChatWithSurface[] = [];
  try {
    for (const [key, raw] of await AsyncStorage.multiGet(keys)) {
      const surfaceKey = key.slice(prefix.length);
      const tab = surfaceToTab(surfaceKey);
      if (!tab || !raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      for (const c of parsed as StoredChat[]) {
        if (c?.messages?.length && now - c.updatedAt < CHAT_RETENTION_MS) {
          out.push({ ...c, surfaceKey, tab });
        }
      }
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Upsert the conversation (called as it grows — every user + assistant turn),
// refresh its title/timestamp, prune expired entries, and return the stored
// list so the caller's Recent-chats state stays current.
export async function saveChat(
  userId: string,
  surface: string,
  chat: { id: string; messages: ChatMessage[] },
  now: number = Date.now()
): Promise<StoredChat[]> {
  const entry: StoredChat = {
    id: chat.id,
    title: chatTitle(chat.messages),
    messages: stripForStorage(chat.messages),
    updatedAt: now,
  };
  const next = prune([entry, ...(await readAll(userId, surface)).filter((c) => c.id !== chat.id)], now);
  await AsyncStorage.setItem(storageKey(userId, surface), JSON.stringify(next));
  return next;
}

// Filter recent chats by a free-text query for the Recent-chats search. Each
// whitespace-separated token must appear (case-insensitive) somewhere in the
// chat — its title OR any message's text — so "paris hotel" narrows to chats
// mentioning both words, in any message, in any order. Blank query = unchanged.
// Generic so it preserves the surface tags on StoredChatWithSurface rows.
export function filterChats<T extends StoredChat>(chats: T[], query: string): T[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return chats;
  return chats.filter((c) => {
    const haystack = `${c.title}\n${c.messages.map((m) => m.content).join('\n')}`.toLowerCase();
    return tokens.every((t) => haystack.includes(t));
  });
}

// "Just now" / "12m ago" / "3h ago" / "2d ago" — 7-day retention means weeks
// never appear.
export function relativeChatTime(updatedAt: number, now: number = Date.now()): string {
  const mins = Math.floor((now - updatedAt) / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (24 * 60))}d ago`;
}

// ── Cross-surface resume hand-off ────────────────────────────────────────────
// The unified Recent-chats sheet can resume a chat that belongs to a DIFFERENT
// assistant than the one on screen. Switching tab (and, for trips, selecting the
// trip) unmounts the current chat and mounts the target — so the target's own
// `useChat` picks the conversation up here on mount. This tiny module is the
// hand-off: the sheet parks a request keyed by surface, the target consumes it
// once its stored chats have loaded. Cleared after one read so a resume never
// replays. Same-surface resume never touches this (it's an in-place state swap).
let pendingResume: { surfaceKey: string; chatId: string } | null = null;

export function requestResume(surfaceKey: string, chatId: string): void {
  pendingResume = { surfaceKey, chatId };
}

// Read (without clearing) the parked request — lets a container pre-select the
// trip for a `trips:<id>` resume before the trip assistant mounts.
export function peekResume(): { surfaceKey: string; chatId: string } | null {
  return pendingResume;
}

// The target surface consumes its own parked chat id (and clears it). Other
// surfaces get null, so an unrelated mount never steals the request.
export function consumeResumeFor(surfaceKey: string): string | null {
  if (pendingResume && pendingResume.surfaceKey === surfaceKey) {
    const { chatId } = pendingResume;
    pendingResume = null;
    return chatId;
  }
  return null;
}
