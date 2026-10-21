import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const helpers = require('../helpers.js');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

function inlineScript() {
  return appSource;
}

const previewHelpers = () => helpers;
const monthHelpers = () => helpers;
const pipeValidationHelpers = () => helpers;
const fileVisualHelpers = () => helpers;
const safetyHelpers = () => helpers;

test('page loads helpers before the application script', () => {
  const helperTag = html.indexOf('<script src="helpers.js"></script>');
  const appTag = html.indexOf('<script src="app.js"></script>');
  assert.ok(helperTag >= 0 && appTag > helperTag);
  assert.doesNotMatch(html, /<style media="not all">/, 'disabled legacy styles should be removed');
});

test('file names are escaped before being rendered as HTML', () => {
  const { escapeHtml } = safetyHelpers();
  assert.equal(escapeHtml('a&b<img src=x onerror=1>"\''), 'a&amp;b&lt;img src=x onerror=1&gt;&quot;&#39;');
  assert.equal(escapeHtml(null), '');

  const source = inlineScript();
  assert.match(source, /<div class="file-name"[^>]*>\$\{escapeHtml\(f\.originalName\)\}<\/div>/);
  assert.doesNotMatch(source, /\$\{f\.newName\}/, 'newName must not be interpolated raw');
  assert.doesNotMatch(source, /\$\{finalName\}/, 'finalName must not be interpolated raw');
});

test('extension falls back to MIME type when the original name has none', () => {
  const { getFileExtension } = safetyHelpers();
  assert.equal(getFileExtension('scan.PDF', 'application/pdf'), 'PDF');
  assert.equal(getFileExtension('a.b.jpg', ''), 'jpg');
  assert.equal(getFileExtension('scan', 'image/png'), 'png');
  assert.equal(getFileExtension('.hidden', 'application/pdf'), 'pdf');
  assert.equal(getFileExtension('noext', ''), 'bin');
  assert.doesNotMatch(inlineScript(), /originalName\.split\('\.'\)\.pop\(\)/);
});

test('manual filename edits survive later duplicate renumbering', () => {
  const source = inlineScript();
  const dupStart = source.indexOf('handleDuplicateNames() {');
  const dupSource = source.slice(dupStart, source.indexOf('selectPipeLetter(', dupStart));
  assert.match(dupSource, /!f\.manualName/);
  const saveStart = source.indexOf('saveFileName(fileId) {');
  const saveSource = source.slice(saveStart, source.indexOf('cancelEdit(fileId)', saveStart));
  assert.match(saveSource, /fileData\.manualName = true/);
});

test('pdf open keeps a usable buffer for the compatibility retry', () => {
  const source = inlineScript();
  const start = source.indexOf('async getPdfDocument(buffer)');
  const body = source.slice(start, source.indexOf('async extractPdfNativeTextFromDocument', start));
  assert.match(body, /buffer\.slice\(0\)/);
});

test('zip names never collide, ignoring case', () => {
  const { uniqueFileName } = helpers;
  const used = new Set();
  assert.equal(uniqueFileName('a.pdf', used), 'a.pdf');
  assert.equal(uniqueFileName('A.PDF', used), 'A (2).PDF');
  assert.equal(uniqueFileName('a.pdf', used), 'a (3).pdf');
  assert.equal(uniqueFileName('noext', used), 'noext');
  assert.equal(uniqueFileName('noext', used), 'noext (2)');
});

test('download all packs a zip and falls back to per-file downloads', () => {
  const source = inlineScript();
  const start = source.indexOf('async downloadAll()');
  const body = source.slice(start, source.indexOf('async clearAll()', start));
  assert.match(body, /this\.loadJsZip\(\)/);
  assert.match(body, /uniqueFileName\(f\.newName, used\)/);
  assert.match(body, /this\.detectLegacyWindows\(\)/, 'Win7 Explorer garbles UTF-8 zip names');
  assert.match(body, /catch \(e\)[\s\S]*downloadFilesIndividually\(ready\)/);
  assert.match(source, /jszip\/3\.10\.1\/jszip\.min\.js/);
});

test('cdn scripts are pinned to exact versions', () => {
  const srcs = [...html.matchAll(/<script src="(https:[^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.length >= 2);
  for (const src of srcs) assert.match(src, /@?\d+\.\d+\.\d+\//, `${src} should pin an exact version`);
});

test('pdf previews render smaller than OCR images and are capped in number', () => {
  const source = inlineScript();
  assert.match(source, /this\.pdfToImg\(fileData\.file, this\.getPreviewMaxPixels\(\)\)/);
  assert.match(source, /this\.rememberPreview\(fileData\)/);
  const start = source.indexOf('rememberPreview(fileData) {');
  const body = source.slice(start, source.indexOf('positionFilePreview(wrap)', start));
  assert.match(body, /getPreviewKeepCount\(\)/);
  assert.match(body, /ResourceManager\.revoke\(fileData\.previewUrl\)/);
});

test('clearing during a batch waits for the current file instead of killing the worker', () => {
  const source = inlineScript();
  const start = source.indexOf('async clearAll() {');
  const body = source.slice(start, source.indexOf('async ensureFilePreview', start));
  const deferred = body.indexOf('if (this.isProcessing)');
  const terminate = body.indexOf('this.ocrWorker.terminate()');
  assert.ok(deferred >= 0 && deferred < terminate);
  assert.match(body, /this\.pendingClear = true/);
  const processStart = source.indexOf('async processAll()');
  const processBody = source.slice(processStart, source.indexOf('cancelProcessing()', processStart));
  assert.match(processBody, /if \(this\.pendingClear\)[\s\S]*await this\.clearAll\(\)/);
});

test('preview ESC handler is registered once, not on every preview', () => {
  const source = inlineScript();
  const start = source.indexOf('async showPreview(fileId)');
  const body = source.slice(start, source.indexOf('closePreview() {', start));
  assert.doesNotMatch(body, /addEventListener\('keydown'/);
});

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
  assert.match(processSource, /this\.finishFileFromReportType\(fileData, reportType, reportTypeGuess, fullText, statusEl, badgeEl\)/);
  assert.doesNotMatch(processSource, /成型上生產日報表/, 'OCR path should not keep its own copy of the naming rule');
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
