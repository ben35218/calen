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

// Destructive jumps are utterance-anchored: the phrase must open the (trimmed)
// transcript, or the whole utterance must be short enough (≤4 words) to read
// as a command. Kitchen chatter that merely CONTAINS the phrase — including
// the number homophones "to"/"for" after "step" — must not move the cook.
describe('anchored commands', () => {
  const anchored = (...phrases: string[]): VoiceCommand => ({ phrases, anchored: true, onMatch: jest.fn() });
  const next = cmd('next', 'continue');
  const back = anchored('back');
  const previous = cmd('previous');
  const jump = anchored('go to step #', 'step #');
  const top = anchored('top', 'scroll to top');
  const bottom = anchored('bottom', 'scroll to bottom');
  const all = [next, back, previous, jump, top, bottom];

  it('"what is the next step to take" no longer jumps to step 2', () => {
    const m = matchVoiceCommand('what is the next step to take', all);
    expect(m?.command).not.toBe(jump); // the bare-keyword "next" may still fire — by design
  });

  it('chatter containing "back" mid-sentence does not go back', () => {
    expect(matchVoiceCommand('put the lid back on it', all)).toBeNull();
    expect(matchVoiceCommand("I'll be right back in a minute", all)).toBeNull();
  });

  it('command-shaped jumps still fire', () => {
    expect(matchVoiceCommand('step 3', all)).toEqual({ command: jump, value: 3, phrase: 'step #' });
    expect(matchVoiceCommand('go to step 3', all)).toEqual({ command: jump, value: 3, phrase: 'go to step #' });
    expect(matchVoiceCommand('step to', all)?.value).toBe(2); // recognizer's "step two"
    expect(matchVoiceCommand('back', all)?.command).toBe(back);
    expect(matchVoiceCommand('go back please', all)?.command).toBe(back); // short utterance
    expect(matchVoiceCommand('bottom', all)?.command).toBe(bottom);
    expect(matchVoiceCommand('scroll to top', all)?.command).toBe(top);
  });

  it('an anchored phrase at the start of a longer utterance fires', () => {
    expect(matchVoiceCommand('go to step 4 and start the sauce', all)?.command).toBe(jump);
  });

  it('non-destructive keywords stay permissive', () => {
    expect(matchVoiceCommand('ok next', all)?.command).toBe(next);
    expect(matchVoiceCommand('and now the previous one thanks please', all)?.command).toBe(previous);
  });
});

// Longer phrase commands win over contained bare keywords even with natural
// filler between their words: "read me the ingredients" is the read-aloud
// command, not the ingredients view toggle.
describe('filler words inside phrase commands', () => {
  const toggle = cmd('ingredients', 'show ingredients');
  const read = cmd('read', 'read step', 'read it');
  const readIng = cmd('read ingredients');
  const all = [toggle, read, readIng];

  it('"read me the ingredients" reads instead of flipping the view', () => {
    expect(matchVoiceCommand('read me the ingredients', all)?.command).toBe(readIng);
    expect(matchVoiceCommand('read the ingredients', all)?.command).toBe(readIng);
    expect(matchVoiceCommand('read ingredients', all)?.command).toBe(readIng);
  });

  it('arbitrary words between phrase words do not bridge the phrase', () => {
    // Non-whitelisted words break the phrase: this is NOT "read ingredients"
    // (the bare keywords it contains still compete as usual).
    expect(matchVoiceCommand('read the recipe then check ingredients', all)?.command).not.toBe(readIng);
  });

  it('the interim hold survives a filler tail while the phrase may complete', () => {
    const m = matchVoiceCommand('read me the', all)!;
    expect(m.command).toBe(read);
    expect(matchCouldExtend('read me the', m, all)).toBe(true); // "ingredients" may still arrive
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
