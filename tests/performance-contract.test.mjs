import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function inlineScript() {
  const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  return blocks.map((match) => match[1]).find((source) => source.includes('class Application'));
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} body should be complete`);
}

function previewHelpers() {
  const source = inlineScript();
  const code = [
    extractFunction(source, 'calculateHoverPreviewPosition'),
    extractFunction(source, 'getPreviewFocusClass'),
    'helpers = { calculateHoverPreviewPosition, getPreviewFocusClass };',
  ].join('\n');
  const context = {};
  runInNewContext(code, context);
  return context.helpers;
}

function monthHelpers() {
  const source = inlineScript();
  const code = [
    extractFunction(source, 'normalizeOutputMonth'),
    'helpers = { normalizeOutputMonth };',
  ].join('\n');
  const context = {};
  runInNewContext(code, context);
  return context.helpers;
}

function pipeValidationHelpers() {
  const source = inlineScript();
  const code = [
    extractFunction(source, 'findFirstFileWithoutPipe'),
    'helpers = { findFirstFileWithoutPipe };',
  ].join('\n');
  const context = {};
  runInNewContext(code, context);
  return context.helpers;
}

function fileVisualHelpers() {
  const source = inlineScript();
  const code = [
    extractFunction(source, 'getFileVisualState'),
    'helpers = { getFileVisualState };',
  ].join('\n');
  const context = {};
  runInNewContext(code, context);
  return context.helpers;
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

test('hover preview flips sides and stays inside a small viewport', () => {
  const { calculateHoverPreviewPosition } = previewHelpers();
  const viewport = { width: 768, height: 720 };
  const popup = { width: 518, height: 371.421875 };
  const anchorNearLeftBottom = { left: 64, right: 144, top: 561.15625, height: 100 };

  const rightSide = calculateHoverPreviewPosition(anchorNearLeftBottom, popup, viewport, 12, 10);
  assert.ok(rightSide.left >= 12);
  assert.ok(rightSide.top >= 12);
  assert.ok(rightSide.left + popup.width <= viewport.width - 12);
  assert.ok(rightSide.top + popup.height <= viewport.height - 12);

  const anchorNearRight = { left: 650, right: 730, top: 120, height: 100 };
  const smallerPopup = { width: 300, height: 260 };
  const leftSide = calculateHoverPreviewPosition(anchorNearRight, smallerPopup, viewport, 12, 10);
  assert.ok(leftSide.left < anchorNearRight.left, 'preview should use the available left side');
  assert.ok(leftSide.left >= 12);
});

test('report type selects the requested paper quarter for hover preview', () => {
  const { getPreviewFocusClass } = previewHelpers();
  assert.equal(getPreviewFocusClass('生產日報表'), 'preview-focus-top-left');
  assert.equal(getPreviewFocusClass('設備點檢表'), 'preview-focus-top-right');
  assert.equal(getPreviewFocusClass(''), '');
});

test('output month accepts YYYY-MM and falls back when invalid', () => {
  const { normalizeOutputMonth } = monthHelpers();
  const fallback = '2026-08';

  assert.equal(normalizeOutputMonth('2025-03', fallback), '2025-03');
  assert.equal(normalizeOutputMonth('2025-13', fallback), fallback);
  assert.equal(normalizeOutputMonth('2025-3', fallback), fallback);
  assert.equal(normalizeOutputMonth('', fallback), fallback);
});

test('output month field drives both filename generation paths', () => {
  const source = inlineScript();
  const finishStart = source.indexOf('finishFileFromReportType(fileData');
  const finishEnd = source.indexOf('async tryProcessPdfNativeText(', finishStart);
  const finishSource = source.slice(finishStart, finishEnd);
  const processStart = source.indexOf('async processSingleFile(fileData, worker)');
  const processEnd = source.indexOf('/** 整張圖先縮到長邊上限', processStart);
  const processSource = source.slice(processStart, processEnd);

  assert.match(html, /<input[^>]+type="month"[^>]+id="outputMonth"/);
  assert.match(finishSource, /const dateStr = this\.getOutputMonth\(\)/);
  assert.match(processSource, /const dateStr = this\.getOutputMonth\(\)/);
});

test('file report groups use distinct visual classes', () => {
  const source = inlineScript();
  const renderStart = source.indexOf('renderList()');
  const renderEnd = source.indexOf('async getWorker()', renderStart);
  const renderSource = source.slice(renderStart, renderEnd);

  assert.match(html, /\.file-group-title--pending/);
  assert.match(html, /\.file-group-title--production/);
  assert.match(html, /\.file-group-title--equipment/);
  assert.match(html, /\.file-item--pending/);
  assert.match(html, /\.file-item--production/);
  assert.match(html, /\.file-item--equipment/);
  assert.match(renderSource, /appendSection\('待辨識', pending, 'pending'\)/);
  assert.match(renderSource, /appendSection\('生產日報表', production, 'production'\)/);
  assert.match(renderSource, /appendSection\('設備點檢表', equipment, 'equipment'\)/);
});

test('batch processing finds the first missing pipe before OCR starts', () => {
  const { findFirstFileWithoutPipe } = pipeValidationHelpers();
  const files = [
    { id: 'ready', selectedPipeLetter: 'A' },
    { id: 'missing-first', selectedPipeLetter: null },
    { id: 'missing-second', selectedPipeLetter: '' },
  ];
  assert.equal(findFirstFileWithoutPipe(files).id, 'missing-first');
  assert.equal(findFirstFileWithoutPipe([{ id: 'custom', selectedPipeLetter: 'Z' }]), null);

  const source = inlineScript();
  const processStart = source.indexOf('async processAll()');
  const processEnd = source.indexOf('cancelProcessing()', processStart);
  const processSource = source.slice(processStart, processEnd);
  const missingGuard = processSource.indexOf('findFirstFileWithoutPipe(pending)');
  const processingStart = processSource.indexOf('this.isProcessing = true');
  assert.ok(missingGuard >= 0, 'batch processing should validate pipe selection');
  assert.ok(missingGuard < processingStart, 'pipe validation must happen before OCR state starts');
  assert.match(processSource, /this\.focusMissingPipeSelection\(missingPipeFile\.id\)/);
});

test('pipe selection and completed filenames use distinct visual states', () => {
  const { getFileVisualState } = fileVisualHelpers();
  assert.equal(getFileVisualState({ processed: false, selectedPipeLetter: null }, 'pending'), 'pipe-missing');
  assert.equal(getFileVisualState({ processed: false, selectedPipeLetter: 'A' }, 'pending'), 'pipe-selected');
  assert.equal(getFileVisualState({ processed: true }, 'production'), 'production');
  assert.equal(getFileVisualState({ processed: true }, 'equipment'), 'equipment');
  assert.equal(getFileVisualState({ processed: false, status: 'error' }, 'pending'), 'error');

  const source = inlineScript();
  assert.match(html, /\.file-item--pending\.file-item--pipe-selected/);
  assert.match(html, /\.file-status--pipe-missing/);
  assert.match(html, /\.file-status--pipe-selected/);
  assert.match(html, /\.file-status--production/);
  assert.match(html, /\.file-status--equipment/);
  assert.match(source, /file-status file-status--\$\{visualState\}/);
  assert.match(source, /classList\.toggle\('file-item--pipe-selected', !!sel\)/);
});

test('status rows use the full card width on small screens', () => {
  const source = inlineScript();
  assert.match(source, /<div class="file-row-actions"/);
  assert.match(source, /<div class="file-status file-status--\$\{visualState\}"/);
  assert.match(html, /\.file-status\s*\{[\s\S]*?flex:\s*0 0 calc\(100% - 96px\)/);
  assert.match(html, /@media \(max-width: 520px\)[\s\S]*?\.file-status\s*\{[\s\S]*?flex-basis:\s*100%/);
  assert.match(html, /@media \(max-width: 520px\)[\s\S]*?\.file-item\s*\{[\s\S]*?flex-direction:\s*column/);
  assert.match(html, /@media \(max-width: 520px\)[\s\S]*?\.file-row-actions\s*\{[\s\S]*?position:\s*absolute/);
});
