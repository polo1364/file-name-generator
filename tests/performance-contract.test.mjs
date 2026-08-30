import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function inlineScript() {
  const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  return blocks.map((match) => match[1]).find((source) => source.includes('class Application'));
}

test('image thumbnail path never forces every image into a maxSide square', () => {
  const source = inlineScript();
  assert.ok(source, 'application script should exist');
  assert.doesNotMatch(
    source,
    /resizeWidth:\s*maxSide,\s*resizeHeight:\s*maxSide/,
    'forcing both dimensions creates a huge square bitmap and distorts the source image',
  );
  assert.match(
    source,
    /createImageBitmap\(f,\s*\{\s*resizeWidth:\s*thumbW\s*\*\s*2,\s*resizeQuality:\s*'low'\s*\}\)/,
    'the import path should decode only a small aspect-ratio-preserving thumbnail',
  );
});

test('large image preview is created lazily instead of during import', () => {
  const source = inlineScript();
  const thumbnailPath = source.slice(
    source.indexOf('async generateThumbnail(fileData)'),
    source.indexOf('getFileReportGroup(f)'),
  );
  assert.doesNotMatch(thumbnailPath, /previewUrl\s*=\s*ResourceManager\.createURL\(scBlob\)/);
  assert.match(thumbnailPath, /fileData\.previewPending\s*=\s*true/);
  assert.match(source, /async ensureFilePreview\(fileData\)/);
});

test('center title classification happens before optional corner OCR', () => {
  const source = inlineScript();
  assert.ok(source, 'application script should exist');

  const centerRecognize = source.indexOf('centerTopResult = await worker.recognize(centerTopDataUrl)');
  const leftRecognize = source.indexOf('leftTopResult = await worker.recognize(leftTopDataUrl)');
  const earlyClassify = source.indexOf('classifyReportType(regionBundle)', centerRecognize);

  assert.ok(centerRecognize >= 0, 'center title OCR should exist');
  assert.ok(leftRecognize > centerRecognize, 'corner OCR should remain as a fallback');
  assert.ok(
    earlyClassify > centerRecognize && earlyClassify < leftRecognize,
    'the common path should classify and stop before the expensive corner OCR calls',
  );
});

test('full-page binarization and fallback crops are deferred until center title is ambiguous', () => {
  const source = inlineScript();
  const centerRecognize = source.indexOf('centerTopResult = await worker.recognize(centerTopDataUrl)');
  const earlyClassify = source.indexOf('classifyReportType(regionBundle)', centerRecognize);
  const fullPagePixels = source.indexOf('const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)');
  const leftCrop = source.indexOf('const leftTopLo = this.cropCanvasRegion');

  assert.ok(earlyClassify > centerRecognize, 'center title should be classified first');
  assert.ok(fullPagePixels > earlyClassify, 'full-page Otsu work should be fallback-only');
  assert.ok(leftCrop > earlyClassify, 'corner crop creation should be fallback-only');
});

test('file chooser snapshots the live FileList before clearing the input', () => {
  const source = inlineScript();
  const handlerStart = source.indexOf('input.onchange = (e) => {');
  const handlerEnd = source.indexOf('};', handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  const snapshot = handler.indexOf('Array.prototype.slice.call(e.target.files, 0)');
  const reset = handler.indexOf("e.target.value = ''");

  assert.ok(snapshot >= 0, 'the selected files should be copied out of the live FileList');
  assert.ok(reset > snapshot, 'the input should only be cleared after the snapshot is created');
});

test('scanned PDF processing reuses one opened document for text and image paths', () => {
  const source = inlineScript();
  const processStart = source.indexOf('async processSingleFile(fileData, worker)');
  const processEnd = source.indexOf('/** 整張圖先縮到長邊上限', processStart);
  const processSource = source.slice(processStart, processEnd);

  assert.match(processSource, /pdfDocument\s*=\s*await this\.getPdfDocument\(buffer\)/);
  assert.match(processSource, /tryProcessPdfNativeText\(fileData, statusEl, badgeEl, pdfDocument\)/);
  assert.match(processSource, /pdfDocumentToImg\(pdfDocument\)/);
  assert.doesNotMatch(
    processSource,
    /pdfToImg\(fileData\.file\)/,
    'the OCR fallback must not parse the same PDF a second time',
  );
});
