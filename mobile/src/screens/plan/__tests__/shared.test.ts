// addonForPackage maps RevenueCat packages to add-on keys by product id — the
// contract between the RC dashboard's product naming and the store screen.
// The heavy runtime deps of shared.ts are stubbed; only the pure mapping runs.
jest.mock('react-native', () => ({ Alert: { alert: jest.fn() }, Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default } }));
jest.mock('../../../store/auth', () => ({ useAuth: () => ({ user: null }) }));
jest.mock('../../../hooks/useBilling', () => ({
  useBilling: jest.fn(),
  useUnlockActivation: jest.fn(),
  useCreditsActivation: jest.fn(),
  useAddonActivation: jest.fn(),
  useAiPlanActivation: jest.fn(),
}));
jest.mock('../../../lib/purchases', () => ({
  isPurchasesConfigured: () => false,
  configurePurchases: jest.fn(),
  logInPurchases: jest.fn(),
  getCurrentOffering: jest.fn(),
  getOfferingById: jest.fn(),
  purchasePackage: jest.fn(),
  restorePurchases: jest.fn(),
}));

import { addonForPackage, aiPlanPackage, packForRcPackage, unlockPackage } from '../shared';
import type { CreditPack } from '../../../api';

function pkg(productId: string, packageId = productId, packageType = 'LIFETIME') {
  return { identifier: packageId, packageType, product: { identifier: productId } } as any;
}

const PACKS: CreditPack[] = [
  { productId: 'credits_499', label: 'Starter', price: 4.99, credits: 500 },
  { productId: 'credits_999', label: 'Plus', price: 9.99, credits: 1050 },
];

describe('addonForPackage', () => {
  it('maps each add-on product id to its calendar key', () => {
    expect(addonForPackage(pkg('app.householdcalendar.addon_meals'))).toBe('recipes');
    expect(addonForPackage(pkg('app.householdcalendar.addon_maintenance'))).toBe('maintenance');
    expect(addonForPackage(pkg('app.householdcalendar.addon_trips'))).toBe('trips');
  });

  it('maps the bundle product to the bundle key', () => {
    expect(addonForPackage(pkg('app.householdcalendar.addon_bundle'))).toBe('bundle');
  });

  it('ignores the retired birthdays product (Birthdays ships free)', () => {
    expect(addonForPackage(pkg('app.householdcalendar.addon_birthdays'))).toBeNull();
  });

  it('never claims the app unlock, credit-pack, or AI-plan products', () => {
    expect(addonForPackage(pkg('app.householdcalendar.app_unlock_499'))).toBeNull();
    expect(addonForPackage(pkg('app.householdcalendar.credits_500'))).toBeNull();
    expect(addonForPackage(pkg('app.householdcalendar.calen_ai_monthly_499'))).toBeNull();
  });
});

describe('packForRcPackage', () => {
  it('matches store packages to catalog packs by product id', () => {
    expect(packForRcPackage(pkg('app.householdcalendar.credits_999'), PACKS)?.credits).toBe(1050);
    expect(packForRcPackage(pkg('app.householdcalendar.credits_499'), PACKS)?.productId).toBe('credits_499');
  });

  it('never cross-claims add-on, unlock, or AI-plan products', () => {
    expect(packForRcPackage(pkg('app.householdcalendar.addon_meals'), PACKS)).toBeNull();
    expect(packForRcPackage(pkg('app.householdcalendar.app_unlock_499'), PACKS)).toBeNull();
    expect(packForRcPackage(pkg('app.householdcalendar.calen_ai_monthly_499'), PACKS)).toBeNull();
    expect(packForRcPackage(pkg('app.householdcalendar.something_else'), PACKS)).toBeNull();
  });
});

describe('unlockPackage', () => {
  it('prefers the lifetime package, falls back to a product-id match', () => {
    const lifetime = pkg('app.householdcalendar.app_unlock_499');
    const custom = pkg('app.householdcalendar.app_unlock_499', 'custom_pkg', 'CUSTOM');
    expect(unlockPackage([pkg('app.householdcalendar.credits_499', 'c', 'CUSTOM'), lifetime])).toBe(lifetime);
    expect(unlockPackage([custom])).toBe(custom);
    expect(unlockPackage([pkg('app.householdcalendar.credits_499', 'c', 'CUSTOM')])).toBeNull();
    expect(unlockPackage([])).toBeNull();
  });
});

describe('aiPlanPackage', () => {
  const PLAN_ID = 'calen_ai_monthly_499';

  it('matches the catalog product id in the ai_plan offering', () => {
    const plan = pkg('app.householdcalendar.calen_ai_monthly_499', 'monthly', 'MONTHLY');
    expect(aiPlanPackage([plan], PLAN_ID)).toBe(plan);
  });

  it('falls back to the monthly package when the product id is mis-set', () => {
    const monthly = pkg('app.householdcalendar.some_other_sub', 'monthly', 'MONTHLY');
    expect(aiPlanPackage([monthly], PLAN_ID)).toBe(monthly);
  });

  it('never cross-claims credit-pack, unlock, or add-on products', () => {
    // Even as MONTHLY-typed packages (a misconfigured offering), the other
    // product classes stay unclaimable — the plan CTA can't sell a pack.
    const strays = [
      pkg('app.householdcalendar.credits_499', 'c', 'MONTHLY'),
      pkg('app.householdcalendar.app_unlock_499', 'u', 'MONTHLY'),
      pkg('app.householdcalendar.addon_meals', 'a', 'MONTHLY'),
    ];
    expect(aiPlanPackage(strays, PLAN_ID)).toBeNull();
    expect(aiPlanPackage([], PLAN_ID)).toBeNull();
  });

  it('prefers the product-id match over an incidental monthly package', () => {
    const monthly = pkg('app.householdcalendar.some_other_sub', 'monthly', 'MONTHLY');
    const plan = pkg('app.householdcalendar.calen_ai_monthly_499', 'plan', 'CUSTOM');
    expect(aiPlanPackage([monthly, plan], PLAN_ID)).toBe(plan);
  });
});
