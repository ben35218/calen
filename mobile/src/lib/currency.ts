// Currency lookups for trip bookings: the destination country's local currency
// (to prefill a new booking's Currency picker) and the display symbol shown
// beside a cost. Static tables, not Intl — Hermes's Intl subset varies by
// platform and a wrong guess here should degrade to the ISO code, not throw.

// ISO 3166-1 alpha-2 country → ISO 4217 currency. Deliberately broad (a trip
// can go anywhere); an unlisted country simply gets no prefill.
const EURO_COUNTRIES = [
  'AD', 'AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE',
  'IT', 'LT', 'LU', 'LV', 'MC', 'ME', 'MT', 'NL', 'PT', 'SI', 'SK', 'SM',
  'VA', 'XK',
];

const COUNTRY_CURRENCY: Record<string, string> = {
  ...Object.fromEntries(EURO_COUNTRIES.map((c) => [c, 'EUR'])),
  US: 'USD', PR: 'USD', GU: 'USD', VI: 'USD', EC: 'USD', SV: 'USD', PA: 'USD',
  CA: 'CAD',
  GB: 'GBP', JE: 'GBP', GG: 'GBP', IM: 'GBP', GI: 'GIP',
  JP: 'JPY', CN: 'CNY', HK: 'HKD', MO: 'MOP', TW: 'TWD', KR: 'KRW',
  AU: 'AUD', NZ: 'NZD', FJ: 'FJD', PF: 'XPF', NC: 'XPF',
  CH: 'CHF', LI: 'CHF',
  MX: 'MXN', IN: 'INR', BR: 'BRL', AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN',
  UY: 'UYU', BO: 'BOB', PY: 'PYG', VE: 'VES',
  CR: 'CRC', DO: 'DOP', GT: 'GTQ', HN: 'HNL', NI: 'NIO', CU: 'CUP', HT: 'HTG',
  BS: 'BSD', BB: 'BBD', JM: 'JMD', TT: 'TTD', KY: 'KYD', BM: 'BMD',
  AW: 'AWG', CW: 'ANG',
  DK: 'DKK', SE: 'SEK', NO: 'NOK', IS: 'ISK',
  PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON', BG: 'BGN', RS: 'RSD',
  AL: 'ALL', MK: 'MKD', BA: 'BAM', MD: 'MDL', BY: 'BYN', UA: 'UAH',
  TR: 'TRY', RU: 'RUB', GE: 'GEL', AM: 'AMD', AZ: 'AZN', KZ: 'KZT', UZ: 'UZS',
  MN: 'MNT',
  IL: 'ILS', AE: 'AED', SA: 'SAR', QA: 'QAR', KW: 'KWD', BH: 'BHD', OM: 'OMR',
  JO: 'JOD', LB: 'LBP',
  EG: 'EGP', MA: 'MAD', TN: 'TND', ZA: 'ZAR', NG: 'NGN', KE: 'KES', GH: 'GHS',
  ET: 'ETB', TZ: 'TZS', UG: 'UGX', RW: 'RWF', ZM: 'ZMW', BW: 'BWP', NA: 'NAD',
  MU: 'MUR', SC: 'SCR', MV: 'MVR',
  TH: 'THB', VN: 'VND', ID: 'IDR', MY: 'MYR', SG: 'SGD', PH: 'PHP',
  KH: 'KHR', LA: 'LAK', MM: 'MMK', LK: 'LKR', BD: 'BDT', PK: 'PKR', NP: 'NPR',
};

export function currencyForCountry(countryCode?: string | null): string | null {
  if (!countryCode) return null;
  return COUNTRY_CURRENCY[countryCode.toUpperCase()] ?? null;
}

// Display symbol for a currency code. Currencies sharing a symbol ($ , ¥, kr)
// keep the bare glyph — the Currency row right below the cost names the code.
const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$', CAD: '$', AUD: '$', NZD: '$', SGD: '$', HKD: '$', TWD: '$',
  MXN: '$', ARS: '$', CLP: '$', COP: '$', BSD: '$', BBD: '$', JMD: '$',
  TTD: '$', KYD: '$', BMD: '$', BND: '$', UYU: '$',
  EUR: '€', GBP: '£', GIP: '£', JPY: '¥', CNY: '¥', KRW: '₩', INR: '₹',
  THB: '฿', VND: '₫', PHP: '₱', ILS: '₪', TRY: '₺', RUB: '₽', UAH: '₴',
  NGN: '₦', PYG: '₲', CRC: '₡', GHS: '₵', LAK: '₭', KHR: '៛', MNT: '₮',
  AZN: '₼', GEL: '₾', KZT: '₸',
  DKK: 'kr', SEK: 'kr', NOK: 'kr', ISK: 'kr',
  PLN: 'zł', CZK: 'Kč', HUF: 'Ft', ZAR: 'R', BRL: 'R$', PEN: 'S/',
};

export function currencySymbol(code?: string | null): string {
  if (!code) return '';
  return CURRENCY_SYMBOL[code.toUpperCase()] ?? code.toUpperCase();
}
