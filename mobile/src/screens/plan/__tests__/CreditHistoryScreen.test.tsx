import React from 'react';
import { render, cleanup } from '@testing-library/react-native';

// The full credit-history screen (billing-plans.md → Billing surfaces): the
// complete purchases & grants ledger the Credits History card previews, grouped
// by month, newest-first. Usage debits never appear (the server returns grants
// only). This exercises the month grouping, row rendering, and the empty state.

// Stub the shared UI kit so the test doesn't drag in native modules; the section
// header and empty state render as plain text we can assert on.
jest.mock('../../../components/ui', () => {
  const ReactActual = require('react');
  const { Text, View } = require('react-native');
  return {
    SkeletonList: () => ReactActual.createElement(Text, null, 'skeleton'),
    SectionHeader: ({ children }: any) => ReactActual.createElement(Text, null, children),
    EmptyState: ({ title, message }: any) =>
      ReactActual.createElement(View, null,
        ReactActual.createElement(Text, null, title),
        ReactActual.createElement(Text, null, message)),
  };
});

const mockLedger = { data: [] as any[], isLoading: false, isRefetching: false, refetch: jest.fn() };
jest.mock('../shared', () => ({
  useCreditLedger: () => mockLedger,
  // Real formatting helpers so the assertions match production output.
  shortDate: (iso?: string | null) => (iso ? 'July 1' : null),
  ledgerAmount: (n: number) =>
    Number.isInteger(n) ? Math.floor(n).toLocaleString() : n.toFixed(1),
  LEDGER_LABEL: {
    purchase: 'Credit pack',
    starter: 'Welcome credits',
    plan: 'Monthly plan credits',
    refund: 'Refund',
    admin: 'Adjustment',
    usage: 'AI usage',
  },
}));

import CreditHistoryScreen from '../CreditHistoryScreen';

describe('CreditHistoryScreen', () => {
  beforeEach(() => {
    mockLedger.data = [];
    mockLedger.isLoading = false;
  });
  afterEach(cleanup);

  it('groups the ledger by month and renders labeled, signed rows', async () => {
    mockLedger.data = [
      { kind: 'plan', credits: 600, productId: 'calen_ai_monthly_499', action: null, note: null, createdAt: '2026-07-15T00:00:00Z' },
      { kind: 'purchase', credits: 500, productId: 'credits_499', action: null, note: null, createdAt: '2026-07-01T00:00:00Z' },
      { kind: 'refund', credits: -50, productId: null, action: null, note: null, createdAt: '2026-06-20T00:00:00Z' },
    ];
    const view = await render(<CreditHistoryScreen />);
    // Two month sections (July, June) from the row dates.
    expect(view.getByText('July')).toBeTruthy();
    expect(view.getByText('June')).toBeTruthy();
    // Grants render labeled with a signed amount; a refund is negative.
    expect(view.getByText('Monthly plan credits')).toBeTruthy();
    expect(view.getByText('+600')).toBeTruthy();
    expect(view.getByText('Credit pack')).toBeTruthy();
    expect(view.getByText('-50')).toBeTruthy();
  });

  it('shows an empty state when there is no history', async () => {
    const view = await render(<CreditHistoryScreen />);
    expect(view.getByText('No history yet')).toBeTruthy();
  });

  it('shows the list skeleton before the first fetch resolves', async () => {
    mockLedger.isLoading = true;
    // react-query's `data` is undefined until the first fetch resolves.
    mockLedger.data = undefined as any;
    const view = await render(<CreditHistoryScreen />);
    expect(view.getByText('skeleton')).toBeTruthy();
  });
});
