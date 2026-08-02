import { Linking, Platform } from 'react-native';
import { flattenMarkdown } from './markdown';

// Tappable links inside assistant chat bubbles. The chat system prompt
// (server WEB_SEARCH_SYSTEM_NOTE) instructs the model to mark up two things:
//   [Name](place:Name, City)     — a specific business/venue/public place
//   [search "query"](search:q)   — a web search the user could run themselves
// This module parses those markers out of a reply so ChatScreen can render
// them as pressable text; everything else flattens to plain text exactly as
// before. The client builds the real URLs (Google Maps place lookup / Google
// search) from the query — the model never emits raw URLs, so a malformed or
// hostile URL can't ride a chat reply.

export type ChatSegment =
  | { kind: 'text'; text: string }
  | { kind: 'place'; text: string; query: string }
  | { kind: 'search'; text: string; query: string };

const LINK_RE = /\[([^\]\n]+)\]\((place|search):\s*([^)\n]+)\)/g;

// Split a reply into plain-text and link segments. Text (and link display
// text) is markdown-flattened, so the output drops straight into the existing
// bubble <Text>. `trimIncomplete` (streaming bubbles) hides a trailing
// half-received link marker so raw markup never flashes mid-stream.
export function parseChatLinks(content: string, opts?: { trimIncomplete?: boolean }): ChatSegment[] {
  let src = content || '';
  if (opts?.trimIncomplete) {
    // A trailing "[..." or "[...](..." with no closing paren is a link still
    // streaming in — hold it back until it completes.
    src = src.replace(/\[[^\]\n]*(\]\([^)\n]*)?$/, '');
  }
  const segments: ChatSegment[] = [];
  let last = 0;
  for (const m of src.matchAll(LINK_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) pushText(segments, src.slice(last, idx));
    const text = flattenMarkdown(m[1]);
    const query = m[3].trim();
    if (text && query) segments.push({ kind: m[2] as 'place' | 'search', text, query });
    last = idx + m[0].length;
  }
  if (last < src.length) pushText(segments, src.slice(last));
  return segments;
}

function pushText(segments: ChatSegment[], raw: string) {
  // Flatten per segment; keep interior whitespace so the pieces rejoin
  // seamlessly inside one <Text> (flattenMarkdown trims, so re-attach edges).
  const lead = /^\s+/.exec(raw)?.[0] ?? '';
  const trail = /\s+$/.exec(raw)?.[0] ?? '';
  const text = lead + flattenMarkdown(raw) + trail;
  if (text) segments.push({ kind: 'text', text });
}

// Google Maps place lookup — renders the place's record (map, hours, reviews)
// in a browser/WebView without needing a Places API key.
export function placeUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query.trim())}`;
}

// Plain web search, for launching in the user's browser.
export function searchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`;
}

// Try to hand a place straight to the native Google Maps app. iOS uses the
// comgooglemaps:// scheme (declared in LSApplicationQueriesSchemes so
// canOpenURL can see it); Android uses the geo: intent, which Google Maps
// claims. Resolves true when the app actually took the link, false when it
// isn't installed / can't handle it — so the caller can fall back to the
// in-app place preview (the current WebView experience).
export async function openPlaceInGoogleMaps(query: string): Promise<boolean> {
  const q = encodeURIComponent(query.trim());
  const appUrl =
    Platform.OS === 'ios'
      ? `comgooglemaps://?q=${q}`
      : Platform.OS === 'android'
        ? `geo:0,0?q=${q}`
        : null;
  if (!appUrl) return false;
  try {
    if (!(await Linking.canOpenURL(appUrl))) return false;
    await Linking.openURL(appUrl);
    return true;
  } catch {
    return false;
  }
}
