/**
 * Issue #32: receipts arriving as PDFs (email exports, e-invoices) —
 * render page 1 to a JPEG so the normal image scan pipeline takes over.
 * pdfjs is heavy, so everything here is lazy-loaded on first use.
 */
export async function pdfFirstPageToJpeg(file: File): Promise<File> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  try {
    const page = await doc.getPage(1);
    // ~2x scale keeps small receipt text readable for the vision model.
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('canvas unavailable');
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    if (blob === null) throw new Error('could not render the PDF');
    return new File([blob], file.name.replace(/\.pdf$/i, '') + '.jpg', { type: 'image/jpeg' });
  } finally {
    void doc.cleanup();
  }
}

export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}
