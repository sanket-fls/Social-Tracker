// Turns a PDF into one JPG per page, right in the browser (PDF.js), so a PDF can go out as an image carousel:
// LinkedIn has no PDF posts through Post for Me, and its image carousels look much the same.
import * as pdfjs from './vendor/pdfjs-6.3.289.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs-6.3.289.worker.min.mjs';

export async function pdfToImages(file, { width = 1200, max = 20, onPage = () => {} } = {}) {
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const pdf = await task.promise;
  const n = Math.min(pdf.numPages, max), base = file.name.replace(/\.pdf$/i, '') || 'page', files = [];
  for (let i = 1; i <= n; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));
    files.push(new File([blob], base + '-' + i + '.jpg', { type: 'image/jpeg' }));
    onPage(i, n);
  }
  const total = pdf.numPages;
  try { await task.destroy(); } catch (e) {}
  return { files, total };
}
