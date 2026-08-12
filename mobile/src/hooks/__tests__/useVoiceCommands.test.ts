jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: { start: jest.fn(), abort: jest.fn(), requestPermissionsAsync: jest.fn() },
  useSpeechRecognitionEvent: jest.fn(),
}));

import { matchVoiceCommand, matchCouldExtend, VoiceCommand } from '../useVoiceCommands';

// Cooking mode's keyword grammar (specs/features/kitchen.md, "Cooking mode"):
// whole-word phrase containment over the transcript, longest phrase wins, and
// a `#` slot captures a spoken number (digits, words, or the homophones
// recognizers substitute mid-sentence).

const cmd = (...phrases: string[]): VoiceCommand => ({ phrases, onMatch: jest.fn() });

describe('matchVoiceCommand', () => {
  const next = cmd('next', 'continue');
  const back = cmd('back', 'previous');
  const timer = cmd('start timer', 'timer');
  const jump = cmd('go to step #', 'step #');
  const all = [next, back, timer, jump];

  it('matches a bare keyword', () => {
    expect(matchVoiceCommand('next', all)?.command).toBe(next);
  });

  it('matches the keyword inside surrounding chatter, case-insensitively', () => {
    expect(matchVoiceCommand('OK, Next!', all)?.command).toBe(next);
    expect(matchVoiceCommand('go back please', all)?.command).toBe(back);
  });

  it('requires whole words — no substring hits', () => {
    expect(matchVoiceCommand('the necktie', all)).toBeNull();
    expect(matchVoiceCommand('backpack', all)).toBeNull();
  });

  it('prefers the longest matching phrase', () => {
    expect(matchVoiceCommand('start timer', all)?.command).toBe(timer);
    expect(matchVoiceCommand('please start timer now', all)?.command).toBe(timer);
  });

  it('matches a multi-word phrase across normalized whitespace/punctuation', () => {
    expect(matchVoiceCommand('start, timer', all)?.command).toBe(timer);
  });

  it('captures a number slot as digits or words', () => {
    expect(matchVoiceCommand('step 3', all)).toEqual({ command: jump, value: 3, phrase: 'step #' });
    expect(matchVoiceCommand('step three', all)).toEqual({ command: jump, value: 3, phrase: 'step #' });
    expect(matchVoiceCommand('go to step twelve', all)).toEqual({ command: jump, value: 12, phrase: 'go to step #' });
  });

  it('accepts the homophones recognizers emit for spoken numbers', () => {
    expect(matchVoiceCommand('step to', all)).toEqual({ command: jump, value: 2, phrase: 'step #' });
    expect(matchVoiceCommand('step for', all)).toEqual({ command: jump, value: 4, phrase: 'step #' });
  });

  it('a slot phrase without a number does not match', () => {
    expect(matchVoiceCommand('step', all)).toBeNull();
    expect(matchVoiceCommand('step it up', all)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(matchVoiceCommand('stir the sauce', all)).toBeNull();
    expect(matchVoiceCommand('', all)).toBeNull();
  });
});

// Interim-result ambiguity (the hook holds these until the transcript grows or
// the final lands): a match whose occurrence ends the transcript, while a
// DIFFERENT command has a longer phrase that continues it, must not fire yet —
// "ingredients" while "ingredients down" may still be on its way.
describe('matchCouldExtend', () => {
  const toggle = cmd('ingredients', 'show ingredients');
  const scrollStep = cmd('down', 'scroll down');
  const scrollIng = cmd('ingredients down', 'scroll ingredients down');
  const read = cmd('read', 'read step', 'read it');
  const all = [toggle, scrollStep, scrollIng, read];

  const match = (t: string) => matchVoiceCommand(t, all)!;

  it('holds a bare match that another command\'s longer phrase continues', () => {
    expect(matchCouldExtend('ingredients', match('ingredients'), all)).toBe(true);
    expect(matchCouldExtend('scroll ingredients', match('scroll ingredients'), all)).toBe(true);
  });

  it('releases once the transcript moves past the continuation point', () => {
    expect(matchCouldExtend('ingredients please', match('ingredients please'), all)).toBe(false);
  });

  it('the longer phrase itself is not held', () => {
    const m = match('ingredients down');
    expect(m.command).toBe(scrollIng);
    expect(matchCouldExtend('ingredients down', m, all)).toBe(false);
  });

  it('a word no other command extends fires immediately', () => {
    expect(matchCouldExtend('down', match('down'), all)).toBe(false);
  });

  it('longer phrases of the SAME command do not hold it', () => {
    expect(matchCouldExtend('read', match('read'), all)).toBe(false);
  });
});
