import type { FormAssistTurn } from '../api';

// Wire conversion for a form's Ask Calen conversation.
//
// The transcript a form holds is a RENDERING structure — bubbles, plus the
// patch each assistant turn applied so a no-fill turn can be styled as such.
// The server wants none of that: it wants what was said, as alternating text
// turns, ending on the user. This is the one place that translation happens, so
// it is pure and tested rather than inlined in the component.

// Matches MAX_HISTORY_TURNS on the server. The client trims too so the user
// isn't billed for tokens the server is about to discard.
export const MAX_TURNS = 8;

export interface WireTurn {
  role: 'user' | 'assistant';
  content: string;
}

// Build the `messages` array for a send: the transcript so far, plus what the
// user just typed.
export function toApiMessages(turns: FormAssistTurn[], prompt: string): WireTurn[] {
  const out: WireTurn[] = [];

  for (const turn of [...turns, { role: 'user' as const, content: prompt }]) {
    const content = (turn.content || '').trim();
    if (!content) continue;
    // The API rejects two same-role messages in a row. Merging rather than
    // dropping keeps a turn the model never answered (a stopped or failed send)
    // in the conversation instead of silently losing it.
    const last = out[out.length - 1];
    if (last && last.role === turn.role) last.content += `\n\n${content}`;
    else out.push({ role: turn.role, content });
  }

  // Trim FIRST, then drop a leading assistant turn — trimming is what can
  // create one, and the API refuses a history that doesn't open on the user.
  const trimmed = out.slice(-MAX_TURNS);
  while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();
  return trimmed;
}
