/**
 * Coarse country bounding boxes (Natural Earth 110m via
 * sandstrom/country-bounding-boxes) + primary currency per country
 * (mledoze/countries). Generated 2026-07-24 — regenerate rather than
 * hand-edit. Antimeridian-wrapping boxes (RU, FJ) are dropped.
 *
 * Boxes overlap near borders, and box sizes vary wildly (the US box is
 * the contiguous 48, inside which most of Canada's population also
 * falls), so the containing box with the nearest normalized center
 * wins — that resolves Santiago into CL (not AR) and Ottawa/Vancouver
 * into CA (not US). This is a HINT source (receipt-photo EXIF GPS ->
 * likely currency), not a geocoder.
 */

type Box = [iso: string, lon1: number, lat1: number, lon2: number, lat2: number, currency: string];

const BOXES: readonly Box[] = [
  ['AE', 51.58, 22.5, 56.4, 26.06, 'AED'], // United Arab Emirates
  ['AF', 60.53, 29.32, 75.16, 38.49, 'AFN'], // Afghanistan
  ['AL', 19.3, 39.62, 21.02, 42.69, 'ALL'], // Albania
  ['AM', 43.58, 38.74, 46.51, 41.25, 'AMD'], // Armenia
  ['AO', 11.64, -17.93, 24.08, -4.44, 'AOA'], // Angola
  ['AR', -73.42, -55.25, -53.63, -21.83, 'ARS'], // Argentina
  ['AT', 9.48, 46.43, 16.98, 49.04, 'EUR'], // Austria
  ['AU', 113.34, -43.63, 153.57, -10.67, 'AUD'], // Australia
  ['AZ', 44.79, 38.27, 50.39, 41.86, 'AZN'], // Azerbaijan
  ['BA', 15.75, 42.65, 19.6, 45.23, 'BAM'], // Bosnia and Herzegovina
  ['BD', 88.08, 20.67, 92.67, 26.45, 'BDT'], // Bangladesh
  ['BE', 2.51, 49.53, 6.16, 51.48, 'EUR'], // Belgium
  ['BF', -5.47, 9.61, 2.18, 15.12, 'XOF'], // Burkina Faso
  ['BG', 22.38, 41.23, 28.56, 44.23, 'EUR'], // Bulgaria
  ['BI', 29.02, -4.5, 30.75, -2.35, 'BIF'], // Burundi
  ['BJ', 0.77, 6.14, 3.8, 12.24, 'XOF'], // Benin
  ['BN', 114.2, 4.01, 115.45, 5.45, 'BND'], // Brunei
  ['BO', -69.59, -22.87, -57.5, -9.76, 'BOB'], // Bolivia
  ['BR', -73.99, -33.77, -34.73, 5.24, 'BRL'], // Brazil
  ['BS', -78.98, 23.71, -77.0, 27.04, 'BSD'], // Bahamas
  ['BT', 88.81, 26.72, 92.1, 28.3, 'BTN'], // Bhutan
  ['BW', 19.9, -26.83, 29.43, -17.66, 'BWP'], // Botswana
  ['BY', 23.2, 51.32, 32.69, 56.17, 'BYN'], // Belarus
  ['BZ', -89.23, 15.89, -88.11, 18.5, 'BZD'], // Belize
  ['CA', -141.0, 41.68, -52.65, 73.23, 'CAD'], // Canada
  ['CD', 12.18, -13.26, 31.17, 5.26, 'CDF'], // Congo (Kinshasa)
  ['CF', 14.46, 2.27, 27.37, 11.14, 'XAF'], // Central African Republic
  ['CG', 11.09, -5.04, 18.45, 3.73, 'XAF'], // Congo (Brazzaville)
  ['CH', 6.02, 45.78, 10.44, 47.83, 'CHF'], // Switzerland
  ['CI', -8.6, 4.34, -2.56, 10.52, 'XOF'], // Ivory Coast
  ['CL', -75.64, -55.61, -66.96, -17.58, 'CLP'], // Chile
  ['CM', 8.49, 1.73, 16.01, 12.86, 'XAF'], // Cameroon
  ['CN', 73.68, 18.2, 135.03, 53.46, 'CNY'], // China
  ['CO', -78.99, -4.3, -66.88, 12.44, 'COP'], // Colombia
  ['CR', -85.94, 8.23, -82.55, 11.22, 'CRC'], // Costa Rica
  ['CU', -84.97, 19.86, -74.18, 23.19, 'CUC'], // Cuba
  ['CY', 32.26, 34.57, 34.0, 35.17, 'EUR'], // Cyprus
  ['CZ', 12.24, 48.56, 18.85, 51.12, 'CZK'], // Czech Republic
  ['DE', 5.99, 47.3, 15.02, 54.98, 'EUR'], // Germany
  ['DJ', 41.66, 10.93, 43.32, 12.7, 'DJF'], // Djibouti
  ['DK', 8.09, 54.8, 12.69, 57.73, 'DKK'], // Denmark
  ['DO', -71.95, 17.6, -68.32, 19.88, 'DOP'], // Dominican Republic
  ['DZ', -8.68, 19.06, 12.0, 37.12, 'DZD'], // Algeria
  ['EC', -80.97, -4.96, -75.23, 1.38, 'USD'], // Ecuador
  ['EE', 23.34, 57.47, 28.13, 59.61, 'EUR'], // Estonia
  ['EG', 24.7, 22.0, 36.87, 31.59, 'EGP'], // Egypt
  ['ER', 36.32, 12.46, 43.08, 18.0, 'ERN'], // Eritrea
  ['ES', -9.39, 35.95, 3.04, 43.75, 'EUR'], // Spain
  ['ET', 32.95, 3.42, 47.79, 14.96, 'ETB'], // Ethiopia
  ['FI', 20.65, 59.85, 31.52, 70.16, 'EUR'], // Finland
  ['FK', -61.2, -52.3, -57.75, -51.1, 'FKP'], // Falkland Islands
  ['FR', -5.0, 42.5, 9.56, 51.15, 'EUR'], // France
  ['GA', 8.8, -3.98, 14.43, 2.33, 'XAF'], // Gabon
  ['GB', -7.57, 49.96, 1.68, 58.64, 'GBP'], // United Kingdom
  ['GE', 39.96, 41.06, 46.64, 43.55, 'GEL'], // Georgia
  ['GH', -3.24, 4.71, 1.06, 11.1, 'GHS'], // Ghana
  ['GL', -73.3, 60.04, -12.21, 83.65, 'DKK'], // Greenland
  ['GM', -16.84, 13.13, -13.84, 13.88, 'GMD'], // Gambia
  ['GN', -15.13, 7.31, -7.83, 12.59, 'GNF'], // Guinea
  ['GQ', 9.31, 1.01, 11.29, 2.28, 'XAF'], // Equatorial Guinea
  ['GR', 20.15, 34.92, 26.6, 41.83, 'EUR'], // Greece
  ['GT', -92.23, 13.74, -88.23, 17.82, 'GTQ'], // Guatemala
  ['GW', -16.68, 11.04, -13.7, 12.63, 'XOF'], // Guinea Bissau
  ['GY', -61.41, 1.27, -56.54, 8.37, 'GYD'], // Guyana
  ['HN', -89.35, 12.98, -83.15, 16.01, 'HNL'], // Honduras
  ['HR', 13.66, 42.48, 19.39, 46.5, 'EUR'], // Croatia
  ['HT', -74.46, 18.03, -71.62, 19.92, 'HTG'], // Haiti
  ['HU', 16.2, 45.76, 22.71, 48.62, 'HUF'], // Hungary
  ['ID', 95.29, -10.36, 141.03, 5.48, 'IDR'], // Indonesia
  ['IE', -9.98, 51.67, -6.03, 55.13, 'EUR'], // Ireland
  ['IL', 34.27, 29.5, 35.84, 33.28, 'ILS'], // Israel
  ['IN', 68.18, 7.97, 97.4, 35.49, 'INR'], // India
  ['IQ', 38.79, 29.1, 48.57, 37.39, 'IQD'], // Iraq
  ['IR', 44.11, 25.08, 63.32, 39.71, 'IRR'], // Iran
  ['IS', -24.33, 63.5, -13.61, 66.53, 'ISK'], // Iceland
  ['IT', 6.75, 36.62, 18.48, 47.12, 'EUR'], // Italy
  ['JM', -78.34, 17.7, -76.2, 18.52, 'JMD'], // Jamaica
  ['JO', 34.92, 29.2, 39.2, 33.38, 'JOD'], // Jordan
  ['JP', 129.41, 31.03, 145.54, 45.55, 'JPY'], // Japan
  ['KE', 33.89, -4.68, 41.86, 5.51, 'KES'], // Kenya
  ['KG', 69.46, 39.28, 80.26, 43.3, 'KGS'], // Kyrgyzstan
  ['KH', 102.35, 10.49, 107.61, 14.57, 'KHR'], // Cambodia
  ['KP', 124.27, 37.67, 130.78, 42.99, 'KPW'], // North Korea
  ['KR', 126.12, 34.39, 129.47, 38.61, 'KRW'], // South Korea
  ['KW', 46.57, 28.53, 48.42, 30.06, 'KWD'], // Kuwait
  ['KZ', 46.47, 40.66, 87.36, 55.39, 'KZT'], // Kazakhstan
  ['LA', 100.12, 13.88, 107.56, 22.46, 'LAK'], // Laos
  ['LB', 35.13, 33.09, 36.61, 34.64, 'LBP'], // Lebanon
  ['LK', 79.7, 5.97, 81.79, 9.82, 'LKR'], // Sri Lanka
  ['LR', -11.44, 4.36, -7.54, 8.54, 'LRD'], // Liberia
  ['LS', 27.0, -30.65, 29.33, -28.65, 'LSL'], // Lesotho
  ['LT', 21.06, 53.91, 26.59, 56.37, 'EUR'], // Lithuania
  ['LU', 5.67, 49.44, 6.24, 50.13, 'EUR'], // Luxembourg
  ['LV', 21.06, 55.62, 28.18, 57.97, 'EUR'], // Latvia
  ['LY', 9.32, 19.58, 25.16, 33.14, 'LYD'], // Libya
  ['MA', -17.02, 21.42, -1.12, 35.76, 'MAD'], // Morocco
  ['MD', 26.62, 45.49, 30.02, 48.47, 'MDL'], // Moldova
  ['ME', 18.45, 41.88, 20.34, 43.52, 'EUR'], // Montenegro
  ['MG', 43.25, -25.6, 50.48, -12.04, 'MGA'], // Madagascar
  ['MK', 20.46, 40.84, 22.95, 42.32, 'MKD'], // Macedonia
  ['ML', -12.17, 10.1, 4.27, 24.97, 'XOF'], // Mali
  ['MM', 92.3, 9.93, 101.18, 28.34, 'MMK'], // Myanmar
  ['MN', 87.75, 41.6, 119.77, 52.05, 'MNT'], // Mongolia
  ['MR', -17.06, 14.62, -4.92, 27.4, 'MRU'], // Mauritania
  ['MW', 32.69, -16.8, 35.77, -9.23, 'MWK'], // Malawi
  ['MX', -117.13, 14.54, -86.81, 32.72, 'MXN'], // Mexico
  ['MY', 100.09, 0.77, 119.18, 6.93, 'MYR'], // Malaysia
  ['MZ', 30.18, -26.74, 40.78, -10.32, 'MZN'], // Mozambique
  ['NA', 11.73, -29.05, 25.08, -16.94, 'NAD'], // Namibia
  ['NC', 164.03, -22.4, 167.12, -20.11, 'XPF'], // New Caledonia
  ['NE', 0.3, 11.66, 15.9, 23.47, 'XOF'], // Niger
  ['NG', 2.69, 4.24, 14.58, 13.87, 'NGN'], // Nigeria
  ['NI', -87.67, 10.73, -83.15, 15.02, 'NIO'], // Nicaragua
  ['NL', 3.31, 50.8, 7.09, 53.51, 'EUR'], // Netherlands
  ['NO', 4.99, 58.08, 31.29, 70.92, 'NOK'], // Norway
  ['NP', 80.09, 26.4, 88.17, 30.42, 'NPR'], // Nepal
  ['NZ', 166.51, -46.64, 178.52, -34.45, 'NZD'], // New Zealand
  ['OM', 52.0, 16.65, 59.81, 26.4, 'OMR'], // Oman
  ['PA', -82.97, 7.22, -77.24, 9.61, 'PAB'], // Panama
  ['PE', -81.41, -18.35, -68.67, -0.06, 'PEN'], // Peru
  ['PG', 141.0, -10.65, 156.02, -2.5, 'PGK'], // Papua New Guinea
  ['PH', 117.17, 5.58, 126.54, 18.51, 'PHP'], // Philippines
  ['PK', 60.87, 23.69, 77.84, 37.13, 'PKR'], // Pakistan
  ['PL', 14.07, 49.03, 24.03, 54.85, 'PLN'], // Poland
  ['PR', -67.24, 17.95, -65.59, 18.52, 'USD'], // Puerto Rico
  ['PS', 34.93, 31.35, 35.55, 32.53, 'EGP'], // West Bank
  ['PT', -9.53, 36.84, -6.39, 42.28, 'EUR'], // Portugal
  ['PY', -62.69, -27.55, -54.29, -19.34, 'PYG'], // Paraguay
  ['QA', 50.74, 24.56, 51.61, 26.11, 'QAR'], // Qatar
  ['RO', 20.22, 43.69, 29.63, 48.22, 'RON'], // Romania
  ['RS', 18.83, 42.25, 22.99, 46.17, 'RSD'], // Serbia
  ['RW', 29.02, -2.92, 30.82, -1.13, 'RWF'], // Rwanda
  ['SA', 34.63, 16.35, 55.67, 32.16, 'SAR'], // Saudi Arabia
  ['SB', 156.49, -10.83, 162.4, -6.6, 'SBD'], // Solomon Islands
  ['SD', 21.94, 8.62, 38.41, 22.0, 'SDG'], // Sudan
  ['SE', 11.03, 55.36, 23.9, 69.11, 'SEK'], // Sweden
  ['SI', 13.7, 45.45, 16.56, 46.85, 'EUR'], // Slovenia
  ['SK', 16.88, 47.76, 22.56, 49.57, 'EUR'], // Slovakia
  ['SL', -13.25, 6.79, -10.23, 10.05, 'SLE'], // Sierra Leone
  ['SN', -17.63, 12.33, -11.47, 16.6, 'XOF'], // Senegal
  ['SO', 40.98, -1.68, 51.13, 12.02, 'SOS'], // Somalia
  ['SR', -58.04, 1.82, -53.96, 6.03, 'SRD'], // Suriname
  ['SS', 23.89, 3.51, 35.3, 12.25, 'SSP'], // South Sudan
  ['SV', -90.1, 13.15, -87.72, 14.42, 'USD'], // El Salvador
  ['SY', 35.7, 32.31, 42.35, 37.23, 'SYP'], // Syria
  ['SZ', 30.68, -27.29, 32.07, -25.66, 'SZL'], // Swaziland
  ['TD', 13.54, 7.42, 23.89, 23.41, 'XAF'], // Chad
  ['TF', 68.72, -49.78, 70.56, -48.63, 'EUR'], // French Southern Territories
  ['TG', -0.05, 5.93, 1.87, 11.02, 'XOF'], // Togo
  ['TH', 97.38, 5.69, 105.59, 20.42, 'THB'], // Thailand
  ['TJ', 67.44, 36.74, 74.98, 40.96, 'TJS'], // Tajikistan
  ['TL', 124.97, -9.39, 127.34, -8.27, 'USD'], // East Timor
  ['TM', 52.5, 35.27, 66.55, 42.75, 'TMT'], // Turkmenistan
  ['TN', 7.52, 30.31, 11.49, 37.35, 'TND'], // Tunisia
  ['TR', 26.04, 35.82, 44.79, 42.14, 'TRY'], // Turkey
  ['TT', -61.95, 10.0, -60.9, 10.89, 'TTD'], // Trinidad and Tobago
  ['TW', 120.11, 21.97, 121.95, 25.3, 'TWD'], // Taiwan
  ['TZ', 29.34, -11.72, 40.32, -0.95, 'TZS'], // Tanzania
  ['UA', 22.09, 44.36, 40.08, 52.34, 'UAH'], // Ukraine
  ['UG', 29.58, -1.44, 35.04, 4.25, 'UGX'], // Uganda
  ['US', -125.0, 25.0, -66.96, 49.5, 'USD'], // United States
  ['UY', -58.43, -34.95, -53.21, -30.11, 'UYU'], // Uruguay
  ['UZ', 55.93, 37.14, 73.06, 45.59, 'UZS'], // Uzbekistan
  ['VE', -73.3, 0.72, -59.76, 12.16, 'VES'], // Venezuela
  ['VN', 102.17, 8.6, 109.34, 23.35, 'VND'], // Vietnam
  ['VU', 166.63, -16.6, 167.84, -14.63, 'VUV'], // Vanuatu
  ['YE', 42.6, 12.59, 53.11, 19.0, 'YER'], // Yemen
  ['ZA', 16.34, -34.82, 32.83, -22.09, 'ZAR'], // South Africa
  ['ZM', 21.89, -17.96, 33.49, -8.24, 'ZMW'], // Zambia
  ['ZW', 25.26, -22.27, 32.85, -15.51, 'BWP'], // Zimbabwe
];

/** Likely ISO-4217 currency at a lat/lon, or null when unknown. */
export function currencyForLocation(lat: number, lon: number): string | null {
  let best: Box | null = null;
  let bestScore = Infinity;
  for (const b of BOXES) {
    const [, lon1, lat1, lon2, lat2] = b;
    if (lon < lon1 || lon > lon2 || lat < lat1 || lat > lat2) continue;
    // Distance to the box center in units of the box's half-extent:
    // 0 at dead center, 1 at an edge midpoint, ~1.41 in a corner.
    const dx = (lon - (lon1 + lon2) / 2) / ((lon2 - lon1) / 2 || 1);
    const dy = (lat - (lat1 + lat2) / 2) / ((lat2 - lat1) / 2 || 1);
    const score = dx * dx + dy * dy;
    if (score < bestScore) { best = b; bestScore = score; }
  }
  return best === null ? null : best[5];
}
