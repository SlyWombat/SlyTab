/**
 * Minimal JPEG EXIF reader: extracts only the GPS position, for the
 * receipt-photo → local-currency hint (issue #9 item 1 / issue #21).
 * Photos never leave the device unshrunk, and canvas re-encoding strips
 * EXIF — so the GPS must be read from the ORIGINAL file bytes before
 * upload. Returns null for anything that isn't a JPEG with GPS tags
 * (PNG screenshots, stripped images, corrupt files).
 */

export interface GpsPosition { lat: number; lon: number }

export function gpsFromJpeg(bytes: ArrayBuffer | Uint8Array): GpsPosition | null {
  try {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null; // not a JPEG

    // Walk JPEG segments looking for APP1/Exif.
    let off = 2;
    while (off + 4 <= b.length) {
      if (b[off] !== 0xff) return null;
      const marker = b[off + 1]!;
      if (marker === 0xda || marker === 0xd9) return null; // image data / EOI — no EXIF
      const size = (b[off + 2]! << 8) | b[off + 3]!;
      if (marker === 0xe1 && size >= 8
        && b[off + 4] === 0x45 && b[off + 5] === 0x78 && b[off + 6] === 0x69 && b[off + 7] === 0x66) { // "Exif"
        return gpsFromTiff(b.subarray(off + 10, off + 2 + size));
      }
      off += 2 + size;
    }
    return null;
  } catch {
    return null;
  }
}

function gpsFromTiff(t: Uint8Array): GpsPosition | null {
  if (t.length < 8) return null;
  const little = t[0] === 0x49 && t[1] === 0x49; // "II" vs "MM"
  if (!little && !(t[0] === 0x4d && t[1] === 0x4d)) return null;
  const u16 = (o: number) => little ? t[o]! | (t[o + 1]! << 8) : (t[o]! << 8) | t[o + 1]!;
  const u32 = (o: number) => little
    ? (t[o]! | (t[o + 1]! << 8) | (t[o + 2]! << 16) | (t[o + 3]! << 24)) >>> 0
    : ((t[o]! << 24) | (t[o + 1]! << 16) | (t[o + 2]! << 8) | t[o + 3]!) >>> 0;

  // IFD0 → find the GPS IFD pointer (tag 0x8825).
  const ifd0 = u32(4);
  if (ifd0 + 2 > t.length) return null;
  let gpsIfd = -1;
  const n0 = u16(ifd0);
  for (let i = 0; i < n0; i++) {
    const e = ifd0 + 2 + i * 12;
    if (e + 12 > t.length) return null;
    if (u16(e) === 0x8825) { gpsIfd = u32(e + 8); break; }
  }
  if (gpsIfd < 0 || gpsIfd + 2 > t.length) return null;

  // GPS IFD: refs are ASCII in the value slot; coords are 3 rationals.
  let latRef = '', lonRef = '';
  let lat: number | null = null, lon: number | null = null;
  const rational3 = (valueOff: number): number | null => {
    if (valueOff + 24 > t.length) return null;
    const d = u32(valueOff), m = u32(valueOff + 8), s = u32(valueOff + 16);
    const dd = u32(valueOff + 4), md = u32(valueOff + 12), sd = u32(valueOff + 20);
    if (dd === 0 || md === 0 || sd === 0) return null;
    return d / dd + m / md / 60 + s / sd / 3600;
  };
  const nG = u16(gpsIfd);
  for (let i = 0; i < nG; i++) {
    const e = gpsIfd + 2 + i * 12;
    if (e + 12 > t.length) return null;
    const tag = u16(e);
    if (tag === 1) latRef = String.fromCharCode(t[e + 8]!);
    else if (tag === 2) lat = rational3(u32(e + 8));
    else if (tag === 3) lonRef = String.fromCharCode(t[e + 8]!);
    else if (tag === 4) lon = rational3(u32(e + 8));
  }
  if (lat === null || lon === null) return null;
  if (latRef === 'S') lat = -lat;
  if (lonRef === 'W') lon = -lon;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}
