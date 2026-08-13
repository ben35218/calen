// Device-local one-shot for the Calen FAB's first-run attention state: until
// the user has tapped the assistant button once, it wears a soft pulsing halo
// (see components/AssistantButton) that says "this one is tappable" — a bare
// gradient "C" says "brand", not "assistant". After the first tap the halo is
// retired for good. AsyncStorage-backed with the same tiny subscriber store as
// lib/contactSortPref, so the month-grid and day-view instances settle
// together the moment either is tapped.
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'hc_calen_fab_intro_seen';

let seen: boolean | null = null; // null = AsyncStorage hasn't answered yet
const subs = new Set<() => void>();
let loaded = false;

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    seen = (await AsyncStorage.getItem(KEY)) === '1';
  } catch {
    seen = true; // fail quiet: never pitch the intro on a storage error
  }
  subs.forEach((fn) => fn());
}

export function useCalenFabIntro() {
  const [, force] = useState(0);

  useEffect(() => {
    const sub = () => force((n) => n + 1);
    subs.add(sub);
    ensureLoaded().then(sub);
    return () => {
      subs.delete(sub);
    };
  }, []);

  // Quiet until the flag has actually loaded — a returning user must never see
  // the halo flash in before AsyncStorage answers.
  const intro = seen === false;

  function markSeen() {
    if (seen) return;
    seen = true;
    AsyncStorage.setItem(KEY, '1').catch(() => {});
    subs.forEach((fn) => fn());
  }

  return { intro, markSeen };
}

// Test-only: drop the module latch so each test can replay the load.
export function __resetCalenFabIntroForTests() {
  seen = null;
  loaded = false;
  subs.clear();
}
