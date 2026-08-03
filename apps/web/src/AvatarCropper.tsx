/**
 * Choosing which square of a photo becomes your badge (#112).
 *
 * The server crops to a centre square, because it has to crop to something and
 * the middle is the only defensible guess. But a photo of a person is rarely
 * framed with their face dead centre, so the guess is wrong often enough to
 * matter — and until now there was no way to correct it, or even to see what
 * had happened until the badge appeared.
 *
 * So: show the photo, let it be moved and scaled under a circle that is the
 * badge, and send the square that was chosen. What you see here is what gets
 * stored — the server receives an already-square image, so its own crop has
 * nothing left to take.
 *
 * No cropping library. This is a pan, a zoom and one drawImage; a dependency
 * would be more code than the feature.
 */

import { useEffect, useRef, useState } from 'react';

/** The square sent to the server. Twice the 256px it stores, for retina. */
const OUT = 512;
/** The circle drawn on screen. */
const VIEW = 300;

export function AvatarCropper({ file, busy, onCancel, onConfirm }: {
  file: File;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (square: Blob) => void;
}) {
  const [img, setImg] = useState<ImageBitmap | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Zoom is a multiple of "just covers the circle", so 1 is always the
  // most of the photo that can be shown without a gap at an edge.
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let dead = false;
    // from-image so a portrait phone photo is upright here too. Without it the
    // preview would disagree with the stored result, which is worse than
    // either being wrong on its own.
    createImageBitmap(file, { imageOrientation: 'from-image' })
      .catch(() => createImageBitmap(file))
      .then((b) => { if (!dead) setImg(b); })
      .catch(() => { if (!dead) setError('that file could not be opened as an image'); });
    return () => { dead = true; };
  }, [file]);

  /** Scale at which the photo exactly covers the circle. */
  const cover = img === null ? 1 : VIEW / Math.min(img.width, img.height);

  // Keep the photo covering the circle: panning must never expose a gap,
  // because a gap is a corner of transparent pixels in someone's badge.
  function clamp(next: { x: number; y: number }, z: number) {
    if (img === null) return next;
    const w = img.width * cover * z;
    const h = img.height * cover * z;
    const maxX = Math.max(0, (w - VIEW) / 2);
    const maxY = Math.max(0, (h - VIEW) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }

  useEffect(() => {
    const c = canvas.current;
    if (c === null || img === null) return;
    const ctx = c.getContext('2d');
    if (ctx === null) return;
    const w = img.width * cover * zoom;
    const h = img.height * cover * zoom;
    ctx.clearRect(0, 0, VIEW, VIEW);
    ctx.save();
    ctx.beginPath();
    ctx.arc(VIEW / 2, VIEW / 2, VIEW / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, (VIEW - w) / 2 + offset.x, (VIEW - h) / 2 + offset.y, w, h);
    ctx.restore();
  }, [img, zoom, offset, cover]);

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = drag.current;
    if (d === null) return;
    setOffset(clamp({ x: e.clientX - d.x, y: e.clientY - d.y }, zoom));
  }
  function onPointerUp() { drag.current = null; }

  function onZoom(z: number) {
    setZoom(z);
    setOffset((o) => clamp(o, z));
  }

  function confirm() {
    if (img === null) return;
    const out = document.createElement('canvas');
    out.width = OUT;
    out.height = OUT;
    const ctx = out.getContext('2d');
    if (ctx === null) return;
    // The same geometry as the preview, at OUT instead of VIEW. One scale
    // factor rather than a second set of sums, so the two cannot drift.
    const k = OUT / VIEW;
    const w = img.width * cover * zoom * k;
    const h = img.height * cover * zoom * k;
    ctx.drawImage(img, (OUT - w) / 2 + offset.x * k, (OUT - h) / 2 + offset.y * k, w, h);
    out.toBlob((b) => { if (b !== null) onConfirm(b); }, 'image/jpeg', 0.9);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      {error !== null ? (
        <p className="error" role="alert">{error}</p>
      ) : (
        <>
          <canvas ref={canvas} width={VIEW} height={VIEW}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove}
            onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
            aria-label="Drag to choose which part of the photo to use"
            style={{
              width: VIEW, height: VIEW, maxWidth: '100%', borderRadius: '50%',
              background: 'var(--ss-surface-2)', cursor: drag.current ? 'grabbing' : 'grab',
              touchAction: 'none', border: '1px solid var(--ss-outline)',
            }} />
          <label style={{ width: '100%', maxWidth: VIEW }}>
            <span className="muted">Zoom</span>
            <input type="range" min={1} max={4} step={0.01} value={zoom}
              onChange={(e) => onZoom(Number(e.target.value))}
              style={{ width: '100%' }} />
          </label>
          <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
            Drag the photo to choose what shows. This circle is exactly what other people will see.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn primary" disabled={busy || img === null}
              onClick={confirm}>{busy ? 'Uploading…' : 'Use this photo'}</button>
            <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
