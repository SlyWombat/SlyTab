/**
 * The mobile icon set (issue #102).
 *
 * Deliberately the SAME geometry as the web set (`apps/web/src/Icon.tsx`), on
 * Material Symbols paths, so the two clients look like one product rather
 * than two apps that happen to share a name. SF Symbols would be more native
 * on iOS, but it has no Android counterpart, and having the platforms diverge
 * costs more here than the last few percent of native feel gains.
 *
 * The important properties, all of which emoji failed:
 *
 *  - `currentColor` equivalent: the icon takes an explicit colour, so a
 *    selected control can change colour and weight instead of only dimming;
 *  - a FIXED pixel size that does not scale with Dynamic Type, so it cannot
 *    outgrow its container — which is how the split checkbox came to clip and
 *    hide who was being charged (#96);
 *  - hidden from the accessibility tree, so the surrounding Pressable keeps
 *    owning the label rather than VoiceOver reading out a punctuation mark.
 *
 * Group emoji stays as it is: that is content the user picked, not chrome.
 */

import Svg, { Path } from 'react-native-svg';

export type IconName =
  | 'back' | 'forward' | 'add' | 'check' | 'group' | 'person'
  | 'receipt' | 'sort' | 'search' | 'wallet' | 'home' | 'clock'
  | 'close' | 'edit' | 'checkboxOn' | 'checkboxOff' | 'approx';

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
  home: 'M11.3 3.3a1 1 0 0 1 1.4 0l8 7.5a1 1 0 0 1-1.4 1.4l-.3-.3V20a1 1 0 0 1-1 1h-4v-6h-3v6H6a1 1 0 0 1-1-1v-8.1l-.3.3a1 1 0 1 1-1.4-1.4Z',
  clock: 'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm1 5v5.3l3.6 2.1a1 1 0 0 1-1 1.7l-4.1-2.4A1 1 0 0 1 11 13V7a1 1 0 0 1 2 0Z',
  close: 'M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 0 0-1.4 1.4l4.9 4.9-4.9 4.9a1 1 0 1 0 1.4 1.4l4.9-4.9 4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z',
  edit: 'M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25ZM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.75 3.75Z',
  // Drawn rather than ☑/☐ — a real box scales with its container, not the
  // font, so it cannot clip at accessibility text sizes (#96).
  checkboxOn: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm5.6 14.2 7-7a1 1 0 0 0-1.4-1.42l-6.3 6.3-2.4-2.4a1 1 0 1 0-1.4 1.42Z',
  checkboxOff: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 2v14h14V5Z',
  approx: 'M4 9.5c1.2-1.6 2.4-2.4 3.6-2.4 1.6 0 2.6 1.5 4.4 1.5 1 0 2-.6 3-1.9l1.6 1.3c-1.2 1.6-2.4 2.4-3.6 2.4-1.6 0-2.6-1.5-4.4-1.5-1 0-2 .6-3 1.9Zm0 5c1.2-1.6 2.4-2.4 3.6-2.4 1.6 0 2.6 1.5 4.4 1.5 1 0 2-.6 3-1.9l1.6 1.3c-1.2 1.6-2.4 2.4-3.6 2.4-1.6 0-2.6-1.5-4.4-1.5-1 0-2 .6-3 1.9Z',
};

export function Icon({ name, size = 18, color }: {
  name: IconName;
  /** Fixed pixels on purpose — an icon that grows with Dynamic Type is #96. */
  size?: number;
  color: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}>
      <Path d={PATHS[name]} fill={color} />
    </Svg>
  );
}
