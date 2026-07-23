/**
 * Supported currencies, ordered with the household defaults first, then
 * alphabetical. Most come from the ECB reference feed; the rest (CLP,
 * ARS, PEN, … — added after a receipt scanned in Chile had no CLP) from
 * the secondary daily feed (FxService::EXTRA_CURRENCIES). Pickers must
 * use this list; free-text currency entry is not allowed (issue #1).
 */
export const CURRENCIES = [
  'CAD', 'USD', 'EUR', 'GBP', 'MXN',
  'AED', 'ARS', 'AUD', 'BGN', 'BOB', 'BRL', 'CHF', 'CLP', 'CNY', 'COP',
  'CRC', 'CZK', 'DKK', 'DOP', 'EGP', 'GTQ', 'HKD', 'HUF', 'IDR', 'ILS',
  'INR', 'ISK', 'JOD', 'JPY', 'KES', 'KRW', 'LKR', 'MAD', 'MYR', 'NOK',
  'NZD', 'PEN', 'PHP', 'PKR', 'PLN', 'QAR', 'RON', 'RSD', 'SAR', 'SEK',
  'SGD', 'THB', 'TRY', 'TWD', 'UAH', 'UYU', 'VND', 'ZAR',
] as const;

export type Currency = (typeof CURRENCIES)[number];

/** Full names for pickers — codes alone are unfriendly (user feedback). */
export const CURRENCY_NAMES: Record<Currency, string> = {
  CAD: 'Canadian dollar', USD: 'US dollar', EUR: 'Euro', GBP: 'British pound',
  MXN: 'Mexican peso', AED: 'UAE dirham', ARS: 'Argentine peso',
  AUD: 'Australian dollar', BGN: 'Bulgarian lev', BOB: 'Bolivian boliviano',
  BRL: 'Brazilian real', CHF: 'Swiss franc', CLP: 'Chilean peso',
  CNY: 'Chinese yuan', COP: 'Colombian peso', CRC: 'Costa Rican colón',
  CZK: 'Czech koruna', DKK: 'Danish krone', DOP: 'Dominican peso',
  EGP: 'Egyptian pound', GTQ: 'Guatemalan quetzal', HKD: 'Hong Kong dollar',
  HUF: 'Hungarian forint', IDR: 'Indonesian rupiah', ILS: 'Israeli shekel',
  INR: 'Indian rupee', ISK: 'Icelandic króna', JOD: 'Jordanian dinar',
  JPY: 'Japanese yen', KES: 'Kenyan shilling', KRW: 'South Korean won',
  LKR: 'Sri Lankan rupee', MAD: 'Moroccan dirham', MYR: 'Malaysian ringgit',
  NOK: 'Norwegian krone', NZD: 'New Zealand dollar', PEN: 'Peruvian sol',
  PHP: 'Philippine peso', PKR: 'Pakistani rupee', PLN: 'Polish złoty',
  QAR: 'Qatari riyal', RON: 'Romanian leu', RSD: 'Serbian dinar',
  SAR: 'Saudi riyal', SEK: 'Swedish krona', SGD: 'Singapore dollar',
  THB: 'Thai baht', TRY: 'Turkish lira', TWD: 'New Taiwan dollar',
  UAH: 'Ukrainian hryvnia', UYU: 'Uruguayan peso', VND: 'Vietnamese dong',
  ZAR: 'South African rand',
};

/** Curated emoji for the group-emoji picker (issue #1 item 7). */
export const GROUP_EMOJI = [
  '🏠', '🏕️', '✈️', '🚗', '⛷️', '🏖️', '🍽️', '🍺', '🎉', '💑',
  '👨‍👩‍👧‍👦', '🐶', '⚽', '🏒', '🎣', '⛵', '🎿', '🧗', '🛒', '💡',
] as const;
