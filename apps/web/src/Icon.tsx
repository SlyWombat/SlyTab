/**
 * The icon set (issue #102).
 *
 * SlyTab drew its controls with emoji and punctuation — 👥 for a group, ✓ for
 * settled, ‹ for back, ＋ for add. That is not only unpolished for an app
 * handling other people's money; it is three real problems:
 *
 *  - emoji render in full colour, so a selected control can only be shown by
 *    dimming it — no colour or weight is available;
 *  - they scale with the text size and overflow fixed containers, which is
 *    exactly how the split checkbox came to clip at accessibility sizes and
 *    hide who was being charged (#96);
 *  - a screen reader reads the character, so `‹` announces as "single
 *    left-pointing angle quotation mark" unless separately labelled.
 *
 * These are inline SVG on Material Symbols geometry: they inherit
 * `currentColor`, take a fixed pixel size independent of Dynamic Type, and
 * are hidden from the accessibility tree — the surrounding control carries
 * the label. Group emoji is untouched: that is content the user chose, not
 * chrome we imposed.
 */

export type IconName =
  | 'back' | 'forward' | 'add' | 'check' | 'group' | 'person'
  | 'receipt' | 'sort' | 'search' | 'wallet' | 'apple' | 'android' | 'close'
  | 'home' | 'clock';

const PATHS: Record<IconName, string> = {
  back: 'M15.7 4.3a1 1 0 0 1 0 1.4L9.4 12l6.3 6.3a1 1 0 1 1-1.4 1.4l-7-7a1 1 0 0 1 0-1.4l7-7a1 1 0 0 1 1.4 0Z',
  forward: 'M8.3 4.3a1 1 0 0 0 0 1.4L14.6 12l-6.3 6.3a1 1 0 1 0 1.4 1.4l7-7a1 1 0 0 0 0-1.4l-7-7a1 1 0 0 0-1.4 0Z',
  add: 'M12 5a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H6a1 1 0 1 1 0-2h5V6a1 1 0 0 1 1-1Z',
  check: 'M20.3 5.7a1 1 0 0 1 0 1.4l-10 10a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.4l4.3 4.29 9.3-9.29a1 1 0 0 1 1.4 0Z',
  group: 'M16 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3Zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3Zm0 2c-2.3 0-7 1.2-7 3.5V19h9v-2.5c0-.9.4-1.7 1-2.4A12 12 0 0 0 8 13Zm8 0a11 11 0 0 0-1.6.1A4 4 0 0 1 16 16.5V19h7v-2.5c0-2.3-4.7-3.5-7-3.5Z',
  person: 'M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-2.7 0-8 1.3-8 4v2h16v-2c0-2.7-5.3-4-8-4Z',
  receipt: 'M6 2 4.5 3.5 3 2v20l1.5-1.5L6 22l1.5-1.5L9 22l1.5-1.5L12 22l1.5-1.5L15 22l1.5-1.5L18 22l1.5-1.5L21 22V2l-1.5 1.5L18 2l-1.5 1.5L15 2l-1.5 1.5L12 2l-1.5 1.5L9 2 7.5 3.5Zm11 6H7V6h10Zm0 5H7v-2h10Zm0 5H7v-2h10Z',
  sort: 'M3 6h12a1 1 0 1 1 0 2H3a1 1 0 0 1 0-2Zm0 5h9a1 1 0 1 1 0 2H3a1 1 0 1 1 0-2Zm0 5h6a1 1 0 1 1 0 2H3a1 1 0 1 1 0-2Z',
  search: 'M10 4a6 6 0 1 0 3.7 10.7l4.3 4.3a1 1 0 0 0 1.4-1.4l-4.3-4.3A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z',
  wallet: 'M4 5h13a2 2 0 0 1 2 2v1h-6a3 3 0 0 0 0 6h6v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm9 5h7a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-7a2 2 0 0 1 0-4Z',
  apple: 'M16.4 12.7c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.15-2.8.85-3.5.85s-1.8-.83-3-.8A4.5 4.5 0 0 0 4.7 9.8c-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 3 2.35 1.2-.05 1.6-.78 3.1-.78s1.8.78 3 .75c1.3 0 2.1-1.15 2.9-2.3a10 10 0 0 0 1.3-2.7c-.03 0-2.8-1.07-2.8-4.7ZM14.1 5.9A4 4 0 0 0 15 3a4.2 4.2 0 0 0-2.7 1.4 3.9 3.9 0 0 0-1 2.8 3.5 3.5 0 0 0 2.8-1.3Z',
  android: 'M6 9v8a1 1 0 0 0 1 1h1v3a1.5 1.5 0 0 0 3 0v-3h2v3a1.5 1.5 0 0 0 3 0v-3h1a1 1 0 0 0 1-1V9Zm-2.5-.5A1.5 1.5 0 0 0 2 10v5a1.5 1.5 0 0 0 3 0v-5a1.5 1.5 0 0 0-1.5-1.5Zm17 0A1.5 1.5 0 0 0 19 10v5a1.5 1.5 0 0 0 3 0v-5a1.5 1.5 0 0 0-1.5-1.5ZM15.5 3.9l1-1.7a.4.4 0 0 0-.7-.4l-1 1.8a6.6 6.6 0 0 0-5.6 0l-1-1.8a.4.4 0 0 0-.7.4l1 1.7A5.7 5.7 0 0 0 6 8h12a5.7 5.7 0 0 0-2.5-4.1ZM9.5 6.2a.6.6 0 1 1 .6-.6.6.6 0 0 1-.6.6Zm5 0a.6.6 0 1 1 .6-.6.6.6 0 0 1-.6.6Z',
  home: 'M11.3 3.3a1 1 0 0 1 1.4 0l8 7.5a1 1 0 0 1-1.4 1.4l-.3-.3V20a1 1 0 0 1-1 1h-4v-6h-3v6H6a1 1 0 0 1-1-1v-8.1l-.3.3a1 1 0 1 1-1.4-1.4Z',
  clock: 'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm1 5v5.3l3.6 2.1a1 1 0 0 1-1 1.7l-4.1-2.4A1 1 0 0 1 11 13V7a1 1 0 0 1 2 0Z',
  close: 'M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 0 0-1.4 1.4l4.9 4.9-4.9 4.9a1 1 0 1 0 1.4 1.4l4.9-4.9 4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z',
};

export function Icon({ name, size = 18, className, style }: {
  name: IconName;
  /** Pixels, deliberately fixed — an icon that grows with Dynamic Type is #96. */
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0, verticalAlign: '-0.15em', ...style }}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
