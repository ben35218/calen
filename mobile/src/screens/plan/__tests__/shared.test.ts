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

import { addonForPackage, packForRcPackage, unlockPackage } from '../shared';
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

  it('never claims the app unlock or credit-pack products', () => {
    expect(addonForPackage(pkg('app.householdcalendar.app_unlock_499'))).toBeNull();
    expect(addonForPackage(pkg('app.householdcalendar.credits_500'))).toBeNull();
  });
});

describe('packForRcPackage', () => {
  it('matches store packages to catalog packs by product id', () => {
    expect(packForRcPackage(pkg('app.householdcalendar.credits_999'), PACKS)?.credits).toBe(1050);
    expect(packForRcPackage(pkg('app.householdcalendar.credits_499'), PACKS)?.productId).toBe('credits_499');
  });

  it('never cross-claims add-on or unlock products', () => {
    expect(packForRcPackage(pkg('app.householdcalendar.addon_meals'), PACKS)).toBeNull();
    expect(packForRcPackage(pkg('app.householdcalendar.app_unlock_499'), PACKS)).toBeNull();
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
