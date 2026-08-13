import React from 'react';
import { TouchableOpacity } from 'react-native';
import { Text } from '../../components/Text';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCreditsActivation, useAiPlanActivation } from '../useBilling';

// Post-purchase activation-poll contract (billing-plans.md → Billing surfaces):
// the poll writes the fresh `/billing/status` into cache AND — the moment it
// reaches `active` (the webhook has landed, so any new CreditLedger row exists
// too) — invalidates the `['billing', 'ledger']` query so the History card
// shows the new grant immediately instead of waiting out its 60s staleTime.
// renderHook is unusable under this jest-expo/React 19 setup, so the hook is
// exercised through a tiny harness component rendered with render().

jest.mock('../../lib/addons', () => ({ cacheOwnedAddons: jest.fn() }));
jest.mock('../../lib/unlock', () => ({ cacheUnlocked: jest.fn() }));
// Free viewer mode: the poll mirrors the status `viewer` counts into the
// device cache (that's what routes a locked user to the viewer shell). The
// fold is reproduced here so the assertion sees the real boolean.
const mockCacheViewer = jest.fn();
jest.mock('../../lib/viewerAccess', () => ({
  cacheViewerContent: (v: boolean) => mockCacheViewer(v),
  viewerContentFromStatus: (s: { viewer?: { calendarCollaborations?: number; pendingCalendarInvitations?: number } }) =>
    ((s.viewer?.calendarCollaborations ?? 0) + (s.viewer?.pendingCalendarInvitations ?? 0)) > 0,
}));

const mockStatus = jest.fn();
jest.mock('../../api', () => ({ billingApi: { status: () => mockStatus() } }));

// Surfaces the credits-activation state + a "buy" button that starts the poll
// from a 250k-millicredit pre-purchase snapshot.
function Harness() {
  const activation = useCreditsActivation();
  return (
    <>
      <Text>state:{activation.state}</Text>
      <TouchableOpacity accessibilityRole="button" onPress={() => activation.start(250_000)}>
        <Text>buy</Text>
      </TouchableOpacity>
    </>
  );
}

async function renderHarness(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>
  );
}

describe('useCreditsActivation', () => {
  // mockReset (not clearAllMocks) so a queued once-resolution never leaks into
  // the next test; cleanup() unmounts, cancelling any pending 3s poll timer.
  afterEach(() => {
    mockStatus.mockReset();
    mockCacheViewer.mockReset();
    cleanup();
  });

  it('invalidates the ledger query once the balance rises above the pre-purchase snapshot', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = jest.spyOn(qc, 'invalidateQueries');
    // The webhook has landed: the poll's first read already shows the grant.
    mockStatus.mockResolvedValue({ data: { creditBalanceMc: 750_000 } });

    const view = await renderHarness(qc);
    fireEvent.press(view.getByText('buy'));

    await waitFor(() => expect(view.getByText('state:active')).toBeTruthy());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['billing', 'ledger'] });
  });

  it('mirrors the status viewer counts into the viewer-content cache', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockStatus.mockResolvedValue({
      data: { creditBalanceMc: 750_000, viewer: { calendarCollaborations: 1, pendingCalendarInvitations: 0 } },
    });

    const view = await renderHarness(qc);
    fireEvent.press(view.getByText('buy'));

    await waitFor(() => expect(view.getByText('state:active')).toBeTruthy());
    expect(mockCacheViewer).toHaveBeenCalledWith(true);
  });

  it('caches no viewer content when the status carries no viewer counts', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockStatus.mockResolvedValue({ data: { creditBalanceMc: 750_000 } });

    const view = await renderHarness(qc);
    fireEvent.press(view.getByText('buy'));

    await waitFor(() => expect(view.getByText('state:active')).toBeTruthy());
    expect(mockCacheViewer).toHaveBeenCalledWith(false);
  });

  it('does not invalidate the ledger while the balance is unchanged', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = jest.spyOn(qc, 'invalidateQueries');
    mockStatus.mockResolvedValue({ data: { creditBalanceMc: 250_000 } });

    const view = await renderHarness(qc);
    fireEvent.press(view.getByText('buy'));

    // One poll lands, still no rise → the ledger stays untouched, poll keeps running.
    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['billing', 'ledger'] });
    expect(view.getByText('state:activating')).toBeTruthy();
  });
});

// The plan poll gates on active AND balance-rise, not `active` alone: the
// webhook flips `aiPlanActive` BEFORE it $incs the balance, so a poll that
// caught `active:true` with the pre-grant balance must keep polling — otherwise
// it would freeze a stale balance in cache until the next focus refetch.
function PlanHarness() {
  const activation = useAiPlanActivation();
  return (
    <>
      <Text>state:{activation.state}</Text>
      <TouchableOpacity accessibilityRole="button" onPress={() => activation.start(250_000)}>
        <Text>buy</Text>
      </TouchableOpacity>
    </>
  );
}

async function renderPlanHarness(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <PlanHarness />
    </QueryClientProvider>
  );
}

describe('useAiPlanActivation', () => {
  afterEach(() => {
    mockStatus.mockReset();
    cleanup();
  });

  it('keeps polling when the plan is active but the credit grant has not landed yet', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The webhook set aiPlanActive first; the balance $inc has not happened yet.
    mockStatus.mockResolvedValue({ data: { aiPlan: { active: true }, creditBalanceMc: 250_000 } });

    const view = await renderPlanHarness(qc);
    fireEvent.press(view.getByText('buy'));

    // Active alone must NOT complete the poll while the balance is still stale.
    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    expect(view.getByText('state:activating')).toBeTruthy();
  });

  it('completes once the plan is active and the period credits have landed', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockStatus.mockResolvedValue({ data: { aiPlan: { active: true }, creditBalanceMc: 850_000 } });

    const view = await renderPlanHarness(qc);
    fireEvent.press(view.getByText('buy'));

    await waitFor(() => expect(view.getByText('state:active')).toBeTruthy());
  });
});
