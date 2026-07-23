/**
 * Supported currencies — the ECB reference set (matches what the FX feed
 * can convert), ordered with the household defaults first. Pickers must
 * use this list; free-text currency entry is not allowed (issue #1).
 */
export const CURRENCIES = [
  'CAD', 'USD', 'EUR', 'GBP', 'MXN',
  'AUD', 'BGN', 'BRL', 'CHF', 'CNY', 'CZK', 'DKK', 'HKD', 'HUF', 'IDR',
  'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN',
  'RON', 'SEK', 'SGD', 'THB', 'TRY', 'ZAR',
] as const;

export type Currency = (typeof CURRENCIES)[number];

/** Curated emoji for the group-emoji picker (issue #1 item 7). */
export const GROUP_EMOJI = [
  '🏠', '🏕️', '✈️', '🚗', '⛷️', '🏖️', '🍽️', '🍺', '🎉', '💑',
  '👨‍👩‍👧‍👦', '🐶', '⚽', '🏒', '🎣', '⛵', '🎿', '🧗', '🛒', '💡',
] as const;
