// Device-local preference for how the Contacts roster is sorted: by first name
// (default) or last name. AsyncStorage-backed with a tiny subscriber store so
// every mounted consumer stays in sync (same pattern as lib/calendarPrefs).
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ContactSort = 'first' | 'last';

const KEY = 'hc_contact_sort';
const DEFAULT: ContactSort = 'first';

let state: ContactSort | null = null;
const subs = new Set<() => void>();
let loaded = false;

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    state = raw === 'last' ? 'last' : 'first';
  } catch {
    state = DEFAULT;
  }
  subs.forEach((fn) => fn());
}

export function useContactSort() {
  const [sort, setSort] = useState<ContactSort>(state ?? DEFAULT);

  useEffect(() => {
    const sub = () => setSort(state ?? DEFAULT);
    subs.add(sub);
    ensureLoaded().then(sub);
    return () => {
      subs.delete(sub);
    };
  }, []);

  function setContactSort(next: ContactSort) {
    state = next;
    AsyncStorage.setItem(KEY, next).catch(() => {});
    subs.forEach((fn) => fn());
  }

  return { sort, setContactSort };
}
