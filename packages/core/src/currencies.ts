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

/** Curated emoji for the group-emoji picker (issue #1 item 7). */
export const GROUP_EMOJI = [
  '🏠', '🏕️', '✈️', '🚗', '⛷️', '🏖️', '🍽️', '🍺', '🎉', '💑',
  '👨‍👩‍👧‍👦', '🐶', '⚽', '🏒', '🎣', '⛵', '🎿', '🧗', '🛒', '💡',
] as const;
