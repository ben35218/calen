import { toApiMessages, MAX_TURNS } from '../formAssistTranscript';
import type { FormAssistTurn } from '../../api';

const user = (content: string): FormAssistTurn => ({ role: 'user', content });
const bot = (content: string, patch?: Record<string, unknown>): FormAssistTurn => ({
  role: 'assistant',
  content,
  patch,
  applied: !!patch,
});

describe('toApiMessages', () => {
  it('appends the new prompt as the trailing user turn', () => {
    expect(toApiMessages([], 'dentist Tuesday at 2pm')).toEqual([
      { role: 'user', content: 'dentist Tuesday at 2pm' },
    ]);
  });

  it('keeps a full exchange in order', () => {
    const turns = [user('add a dentist appointment'), bot('Set the title to Dentist.', { title: 'Dentist' })];
    expect(toApiMessages(turns, 'make it 3pm')).toEqual([
      { role: 'user', content: 'add a dentist appointment' },
      { role: 'assistant', content: 'Set the title to Dentist.' },
      { role: 'user', content: 'make it 3pm' },
    ]);
  });

  it('never leaks patch or applied onto the wire', () => {
    const [, assistant] = toApiMessages([user('a'), bot('b', { title: 'x' })], 'c');
    expect(Object.keys(assistant).sort()).toEqual(['content', 'role']);
  });

  it('drops empty and whitespace-only content', () => {
    const turns = [user('real'), bot('   '), bot('')];
    // Dropping the blank assistant turns leaves two user turns adjacent, so the
    // merge rule below fires — which is the point: the wire must alternate.
    expect(toApiMessages(turns, 'next')).toEqual([
      { role: 'user', content: 'real\n\nnext' },
    ]);
  });

  it('merges consecutive same-role turns rather than dropping them', () => {
    // A user turn the model never answered (send failed / was stopped) sits
    // right before the next one; the API refuses two user messages in a row.
    const turns = [user('first try')];
    expect(toApiMessages(turns, 'second try')).toEqual([
      { role: 'user', content: 'first try\n\nsecond try' },
    ]);
  });

  it('trims to the cap', () => {
    const turns: FormAssistTurn[] = [];
    for (let i = 0; i < 12; i++) turns.push(i % 2 === 0 ? user(`u${i}`) : bot(`a${i}`));
    expect(toApiMessages(turns, 'latest').length).toBeLessThanOrEqual(MAX_TURNS);
  });

  it('still opens on a user turn after trimming', () => {
    // The regression this guards: slice(-N) on an alternating history can land
    // on an assistant turn, which the API rejects outright.
    const turns: FormAssistTurn[] = [];
    for (let i = 0; i < 20; i++) turns.push(i % 2 === 0 ? user(`u${i}`) : bot(`a${i}`));
    const wire = toApiMessages(turns, 'latest');
    expect(wire[0].role).toBe('user');
    expect(wire[wire.length - 1]).toEqual({ role: 'user', content: 'latest' });
  });

  it('trims to the most recent turns, not the oldest', () => {
    const turns: FormAssistTurn[] = [];
    for (let i = 0; i < 12; i++) turns.push(i % 2 === 0 ? user(`u${i}`) : bot(`a${i}`));
    const wire = toApiMessages(turns, 'latest');
    expect(wire.some((m) => m.content === 'u0')).toBe(false);
    expect(wire.some((m) => m.content === 'a11')).toBe(true);
  });
});
