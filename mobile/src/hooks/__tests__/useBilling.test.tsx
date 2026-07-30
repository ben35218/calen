import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCreditsActivation } from '../useBilling';

// Post-purchase activation-poll contract (billing-plans.md → Billing surfaces):
// the poll writes the fresh `/billing/status` into cache AND — the moment it
// reaches `active` (the webhook has landed, so any new CreditLedger row exists
// too) — invalidates the `['billing', 'ledger']` query so the History card
// shows the new grant immediately instead of waiting out its 60s staleTime.
// renderHook is unusable under this jest-expo/React 19 setup, so the hook is
// exercised through a tiny harness component rendered with render().

jest.mock('../../lib/addons', () => ({ cacheOwnedAddons: jest.fn() }));
jest.mock('../../lib/unlock', () => ({ cacheUnlocked: jest.fn() }));

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
  afterEach(() => {
    jest.clearAllMocks();
    cleanup();
  });

  it('invalidates the ledger query once the balance rises above the pre-purchase snapshot', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = jest.spyOn(qc, 'invalidateQueries');
    // First poll still shows the old balance; the second reflects the webhook grant.
    mockStatus
      .mockResolvedValueOnce({ data: { creditBalanceMc: 250_000 } })
      .mockResolvedValueOnce({ data: { creditBalanceMc: 750_000 } });

    const view = await renderHarness(qc);
    fireEvent.press(view.getByText('buy'));

    await waitFor(() => expect(view.getByText('state:active')).toBeTruthy());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['billing', 'ledger'] });
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
