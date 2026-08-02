import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { billingApi, BillingStatus } from '../api';
import { cacheOwnedAddons } from '../lib/addons';
import { cacheUnlocked } from '../lib/unlock';
import { cacheViewerContent, viewerContentFromStatus } from '../lib/viewerAccess';

// Single source for the billing status query so every surface (unlock paywall,
// credit banners, profile row) shares one cache entry and staleTime.
export function useBilling() {
  return useQuery({
    queryKey: ['billing', 'status'],
    queryFn: async () => {
      const { data } = await billingApi.status();
      // Mirror the owned add-on set + unlock state + viewer content into the
      // device caches so feature gating, the hard paywall, and the free viewer
      // shell track the server truth offline.
      cacheOwnedAddons(data.addons ?? []);
      cacheUnlocked(Boolean(data.unlocked));
      cacheViewerContent(viewerContentFromStatus(data));
      return data;
    },
    staleTime: 60_000,
  });
}

export type PurchaseActivationState = 'idle' | 'activating' | 'active' | 'timeout';

const POLL_MS = 3_000;
const TIMEOUT_MS = 45_000;

// Shared post-purchase poll: the store has charged, but server state flips only
// once RevenueCat calls our webhook, so poll /billing/status until `done(data)`
// reports the change landed. 'timeout' means payment went through but the
// webhook hasn't landed yet — callers should reassure, not alarm.
function useActivationPoll(done: (data: BillingStatus) => boolean) {
  const qc = useQueryClient();
  const [state, setState] = useState<PurchaseActivationState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const doneRef = useRef(done);
  doneRef.current = done;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function begin() {
    if (timer.current) clearTimeout(timer.current);
    setState('activating');
    const startedAt = Date.now();

    const poll = async () => {
      try {
        const { data } = await billingApi.status();
        if (!alive.current) return;
        qc.setQueryData(['billing', 'status'], data);
        // Every poll re-mirrors the device caches — that's what actually flips
        // the paywall / feature gates.
        cacheOwnedAddons(data.addons ?? []);
        cacheUnlocked(Boolean(data.unlocked));
        cacheViewerContent(viewerContentFromStatus(data));
        if (doneRef.current(data)) {
          setState('active');
          // The change has landed server-side, which means any new credit-ledger
          // row (a pack grant, a plan period) now exists too — refresh History so
          // the buyer sees the transaction immediately, not after the 60s
          // staleTime elapses.
          qc.invalidateQueries({ queryKey: ['billing', 'ledger'] });
          return;
        }
      } catch {
        // Transient fetch failure — keep polling until the deadline.
      }
      if (!alive.current) return;
      if (Date.now() - startedAt >= TIMEOUT_MS) {
        setState('timeout');
        return;
      }
      timer.current = setTimeout(poll, POLL_MS);
    };
    poll();
  }

  return { state, begin };
}

// Post-purchase poll for the $4.99 app unlock: done once the server reports
// `unlocked` (the RootNavigator gate re-renders off the unlock cache).
export function useUnlockActivation() {
  const { state, begin } = useActivationPoll((data) => data.unlocked === true);
  return { state, start: () => begin() };
}

// Post-purchase poll for a consumable credit pack: done once the balance rises
// above the snapshot taken at purchase time.
export function useCreditsActivation() {
  const beforeMc = useRef<number>(0);
  const { state, begin } = useActivationPoll(
    (data) => (data.creditBalanceMc ?? 0) > beforeMc.current
  );
  return {
    state,
    start: (previousBalanceMc: number) => {
      beforeMc.current = previousBalanceMc;
      begin();
    },
  };
}

// Post-purchase poll for the monthly Calen AI plan subscription: done once the
// server reports the plan active AND the period's credits have landed. The
// webhook flips `aiPlanActive` in a separate write BEFORE it grants the credits,
// so gating on `active` alone can complete on a poll that caught the balance
// mid-grant — freezing a stale, pre-credit balance into the cache until the next
// focus refetch. Requiring the balance to rise past the pre-purchase snapshot
// (same doctrine as the credit-pack poll) keeps polling until the credits
// actually appear, so the success copy and the balance are truthful together.
export function useAiPlanActivation() {
  const beforeMc = useRef<number>(0);
  const { state, begin } = useActivationPoll(
    (data) => data.aiPlan?.active === true && (data.creditBalanceMc ?? 0) > beforeMc.current
  );
  return {
    state,
    start: (previousBalanceMc: number) => {
      beforeMc.current = previousBalanceMc;
      begin();
    },
  };
}

// Post-purchase poll for one-time feature-calendar add-ons: done once the owned
// set differs from the snapshot taken at purchase time.
export function useAddonActivation() {
  const before = useRef<string>('');
  const { state, begin } = useActivationPoll(
    (data) => (data.addons ?? []).slice().sort().join(',') !== before.current
  );
  return {
    state,
    start: (previousAddons: string[]) => {
      before.current = [...previousAddons].sort().join(',');
      begin();
    },
  };
}
