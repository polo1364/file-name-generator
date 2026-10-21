/* 純函式：瀏覽器中為全域函式；Node 測試可直接 require。 */
/**
 * 移除表格內「射球批號」等列，避免與表頭「管別」混淆（與人工只看表頭列一致）。
 */
function stripTableLotNoise(text) {
  return (text || '')
    .split(/\r?\n/)
    .filter(function(line) {
      return !/(射球|批號|批号|Shot|Lot|LOT|批\s*次|material|lot\s*no)/i.test(line);
    })
    .join('\n');
}

/** 單一欄位值若為「字母+數字」長串，視為批號／料號而非管別 */
function isLikelyBatchLotToken(token) {
  const t = String(token).trim();
  if (!t) return false;
  if (/^[A-Za-z]\d{3,}/.test(t)) return true;
  if (/^[A-Za-z]\d{2}\d{2}/.test(t)) return true;
  if (t.length >= 8 && /^[A-Za-z0-9]+$/.test(t)) return true;
  return false;
}

/** 類別外定義，避免部分環境下「後置方法」在執行時尚未掛上 prototype 造成 is not a function */
function extractProductionPipeLetter(app, normText) {
  const t = stripTableLotNoise((normText || '').replace(/\s+/g, ' ').trim());
  if (!t) return '';
  const m1 = t.match(/管\s*[別别]\s*[:：;．。、]?\s*([^\s]+)/);
  if (m1 && !isLikelyBatchLotToken(m1[1])) {
    const v = app.normalizePipeTokenToLetter(m1[1]);
    if (v) return v;
  }
  const m1b = t.match(/管[^A-Za-z\u4e00-\u9fff]{0,3}別\s*[:：;．。、]?\s*([^\s]+)/);
  if (m1b && !isLikelyBatchLotToken(m1b[1])) {
    const v = app.normalizePipeTokenToLetter(m1b[1]);
    if (v) return v;
  }
  const m2 = t.match(/([A-Za-z])管/);
  if (m2) {
    const v = app.validatePipeLetter(m2[1]);
    if (v) return v;
  }
  return '';
}

function extractEquipmentPipeLetter(app, normText) {
  const t = stripTableLotNoise((normText || '').replace(/\s+/g, ' ').trim());
  if (!t) return '';
  let m = t.match(/編號\s*[\):：\s]*([A-Za-z0-9|]+)/);
  if (!m) m = t.match(/(?:設備編號|設備名稱|設備代號|Code|CODE)\s*[\):：\s]*([A-Za-z0-9|]+)/i);
  if (m) {
    const raw = m[1];
    if (!isLikelyBatchLotToken(raw)) {
      const v = app.normalizePipeTokenToLetter(raw);
      if (v) return v;
    }
  }
  const m2 = t.match(/([A-Za-z])管/i);
  if (m2) {
    const v = app.validatePipeLetter(m2[1]);
    if (v) return v;
  }
  return '';
}

/**
 * 二值化／原圖兩路結果：一致則採用；僅一路有則採用；不一致則對「合併字串」再擷取一次，仍無則採二值化。
 * 表頭仍無結果時：生產日報表改採「左上區」、設備點檢表改採「右上區」（與表單欄位位置一致）。
 */
function resolvePipeLetter(app, reportType, binRaw, origRaw, leftTopRaw, rightTopRaw) {
  const norm = function(t) {
    return stripTableLotNoise((t || '').replace(/\s+/g, ' ').trim());
  };
  const extract = reportType === '生產日報表' ? extractProductionPipeLetter : extractEquipmentPipeLetter;
  const a = extract(app, norm(binRaw));
  const b = extract(app, norm(origRaw));
  if (a && b && a === b) return a;
  if (a && !b) return a;
  if (b && !a) return b;
  if (a && b && a !== b) {
    const merged = extract(app, norm(binRaw + '\n' + origRaw));
    if (merged) return merged;
    return a;
  }
  var mergedAll = extract(app, norm(binRaw + '\n' + origRaw));
  if (mergedAll) return mergedAll;
  if (reportType === '生產日報表') {
    var fromLeft = extract(app, norm(app.normalizeHeaderOcrText(leftTopRaw || ''))) || '';
    if (fromLeft) return fromLeft;
  } else {
    var fromRight = extract(app, norm(app.normalizeHeaderOcrText(rightTopRaw || ''))) || '';
    if (fromRight) return fromRight;
  }
  var loose = extractPipeLetterLoose(app, reportType, norm(binRaw + '\n' + origRaw + '\n' + (leftTopRaw || '') + '\n' + (rightTopRaw || '')));
  return loose || '';
}

/** 管別：OCR 空格不規則時的寬鬆擷取（仍排除批號樣式） */
function extractPipeLetterLoose(app, reportType, text) {
  var t = stripTableLotNoise((text || '').replace(/\s+/g, ' ').trim());
  if (!t) return '';
  if (reportType === '生產日報表') {
    var mp = t.match(/管\s*[別别]\s*[:：\s]{0,16}([A-Za-z0-9|])/);
    if (mp && !isLikelyBatchLotToken(mp[1])) {
      var v = app.normalizePipeTokenToLetter(mp[1]);
      if (v) return v;
    }
  } else {
    var me = t.match(/編號\s*[\):：\s]{0,14}([A-Za-z0-9|]+)/);
    if (me && !isLikelyBatchLotToken(me[1])) {
      var v2 = app.normalizePipeTokenToLetter(me[1]);
      if (v2) return v2;
    }
  }
  return '';
}

/** 合併 OCR 字串供比對（保留空白以外的字元，並做常見誤字折一） */
function normalizeOcrForReportMatch(s) {
  return (s || '')
    .replace(/\s+/g, '')
    .replace(/産/g, '產')
    .replace(/課/g, '產')
    .toLowerCase();
}

function scoreProductionSignals(c) {
  if (!c) return 0;
  var score = 0;
  if (c.includes('生產日報表')) score += 12;
  if (/生[產産]日報表/.test(c)) score += 10;
  if (c.includes('生產') && c.includes('日報')) score += 7;
  if (c.includes('成型') && (c.includes('生產') || c.includes('日報'))) score += 6;
  if (c.includes('日報表') && c.indexOf('生') !== -1) score += 5;
  if (c.includes('日報表') && !c.includes('點檢')) score += 4;
  if (c.includes('dailyreport') || (c.includes('daily') && c.includes('report'))) score += 5;
  if (c.includes('production') && !c.includes('inspection')) score += 3;
  return score;
}

function scoreEquipmentSignals(c) {
  if (!c) return 0;
  var score = 0;
  if (c.includes('設備點檢表')) score += 12;
  if (c.includes('設備') && c.includes('點檢')) score += 9;
  if (c.includes('點檢表')) score += 6;
  if (c.includes('點檢') && c.includes('設備')) score += 5;
  if (c.includes('equipment') && (c.includes('inspection') || c.includes('check'))) score += 6;
  if (c.includes('inspection') || c.includes('checklist')) score += 4;
  if (c.includes('設備') && c.includes('編號')) score += 5;
  if (c.includes('machine') && c.includes('check')) score += 3;
  return score;
}

/**
 * 報表類型：中間標題 → 表頭列 → 左上／右上 → 上半 → 全文（與人工先看標題、再看表頭列一致）。
 * 另以「分數」容錯 OCR 斷字、誤字，最後再比較兩類總分。
 */
function classifyReportType(regions) {
  var centerTopText = regions.centerTopText;
  var centerTopClean = regions.centerTopClean;
  var leftTopClean = regions.leftTopClean;
  var rightTopClean = regions.rightTopClean;
  var headerStripClean = regions.headerStripClean || '';
  var topHalfClean = regions.topHalfClean;
  var fullClean = regions.fullClean;

  if (centerTopText.includes('生產日報表') || centerTopClean.includes('生產日報表') ||
      (centerTopClean.includes('成型') && centerTopClean.includes('生產'))) {
    return '生產日報表';
  }
  if (centerTopText.includes('設備點檢表') || centerTopClean.includes('設備點檢表')) {
    return '設備點檢表';
  }

  if (headerStripClean.includes('設備點檢表')) return '設備點檢表';
  if (headerStripClean.includes('生產日報表') ||
      (headerStripClean.includes('成型') && headerStripClean.includes('生產'))) {
    return '生產日報表';
  }

  var isProductionDaily = leftTopClean.includes('production') || leftTopClean.includes('daily') ||
    leftTopClean.includes('report') || (leftTopClean.includes('day') && leftTopClean.includes('report'));
  var isEquipmentInspection = rightTopClean.includes('equipment') || rightTopClean.includes('inspection') ||
    rightTopClean.includes('check') || rightTopClean.includes('machine') ||
    rightTopClean.includes('equip') || rightTopClean.includes('no.') || rightTopClean.includes('number') ||
    rightTopClean.includes('設備') || rightTopClean.includes('編號');

  if (isProductionDaily && !isEquipmentInspection) return '生產日報表';
  if (isEquipmentInspection) return '設備點檢表';
  if (isProductionDaily) return '生產日報表';

  if (topHalfClean) {
    if (topHalfClean.includes('生產日報表') || topHalfClean.includes('production') ||
        topHalfClean.includes('daily') || (topHalfClean.includes('day') && topHalfClean.includes('report'))) {
      return '生產日報表';
    }
    if (topHalfClean.includes('設備點檢表') || topHalfClean.includes('設備') || topHalfClean.includes('編號') ||
        topHalfClean.includes('equipment') || topHalfClean.includes('inspection') || topHalfClean.includes('check') ||
        topHalfClean.includes('machine') || topHalfClean.includes('equip')) {
      return '設備點檢表';
    }
  }

  if (fullClean) {
    if (fullClean.includes('生產日報表') || fullClean.includes('production') ||
        fullClean.includes('daily') || (fullClean.includes('day') && fullClean.includes('report'))) {
      return '生產日報表';
    }
    if (fullClean.includes('設備點檢表') || fullClean.includes('設備') || fullClean.includes('編號') ||
        fullClean.includes('equipment') || fullClean.includes('inspection') || fullClean.includes('check') ||
        fullClean.includes('machine') || fullClean.includes('equip')) {
      return '設備點檢表';
    }
  }

  var merged = normalizeOcrForReportMatch(
    (regions.centerTopText || '') + (regions.headerStripRaw || '') + (regions.leftTopRaw || '') +
    (regions.rightTopRaw || '') + (regions.topHalfRaw || '') + (regions.fullRaw || '')
  );
  var p = scoreProductionSignals(merged);
  var e = scoreEquipmentSignals(merged);
  if (p > e && p >= 3) return '生產日報表';
  if (e > p && e >= 3) return '設備點檢表';

  return '';
}

/** 最後手段：比較全文／上半部兩類關鍵字分數 */
function guessReportTypeByScore(regions) {
  var blob = normalizeOcrForReportMatch(
    (regions.fullRaw || '') + (regions.topHalfRaw || '') + (regions.headerStripRaw || '') +
    (regions.centerTopText || '') + (regions.leftTopRaw || '') + (regions.rightTopRaw || '')
  );
  var p = scoreProductionSignals(blob);
  var e = scoreEquipmentSignals(blob);
  if (p === 0 && e === 0) return '';
  if (p === e) {
    var r = normalizeOcrForReportMatch(regions.rightTopRaw || '');
    var l = normalizeOcrForReportMatch(regions.leftTopRaw || '');
    if (r.includes('編號') || (r.includes('設備') && r.includes('點檢'))) return '設備點檢表';
    if (l.includes('生產') || l.includes('日報') || l.includes('成型')) return '生產日報表';
    return '生產日報表';
  }
  return p > e ? '生產日報表' : '設備點檢表';
}

function calculateHoverPreviewPosition(anchorRect, popupRect, viewport, padding, gap) {
  var edgePadding = typeof padding === 'number' ? padding : 12;
  var previewGap = typeof gap === 'number' ? gap : 10;
  var left = anchorRect.left - popupRect.width - previewGap;
  if (left < edgePadding) left = anchorRect.right + previewGap;
  var maxLeft = Math.max(edgePadding, viewport.width - popupRect.width - edgePadding);
  left = Math.max(edgePadding, Math.min(left, maxLeft));

  var top = anchorRect.top + (anchorRect.height - popupRect.height) / 2;
  var maxTop = Math.max(edgePadding, viewport.height - popupRect.height - edgePadding);
  top = Math.max(edgePadding, Math.min(top, maxTop));
  return { left: left, top: top };
}

function getPreviewFocusClass(reportType) {
  if (reportType === '生產日報表') return 'preview-focus-top-left';
  if (reportType === '設備點檢表') return 'preview-focus-top-right';
  return '';
}

function normalizeOutputMonth(value, fallback) {
  var text = String(value || '').trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(text) ? text : fallback;
}

function findFirstFileWithoutPipe(files) {
  var list = files || [];
  for (var i = 0; i < list.length; i++) {
    var letter = String(list[i].selectedPipeLetter || '').trim().toUpperCase();
    if (!/^[A-Z]$/.test(letter)) return list[i];
  }
  return null;
}

function getFileVisualState(file, group) {
  if (file && file.status === 'error') return 'error';
  if (file && file.processed) {
    if (group === 'production' || group === 'equipment') return group;
    return 'complete';
  }
  return file && file.selectedPipeLetter ? 'pipe-selected' : 'pipe-missing';
}

/** 檔名／錯誤訊息塞進 innerHTML 前先跳脫，避免 &、< 等字元破壞版面或被當成 HTML */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 取副檔名；原檔名無副檔名時改由 MIME 推斷，避免把整個原檔名當成副檔名 */
function getFileExtension(name, mime) {
  var n = String(name || '');
  var dot = n.lastIndexOf('.');
  if (dot > 0 && dot < n.length - 1) return n.slice(dot + 1);
  var byMime = {
    'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/bmp': 'bmp', 'image/tiff': 'tif'
  };
  return byMime[String(mime || '').toLowerCase()] || 'bin';
}

/** ZIP 內同名檔會互相覆蓋：重複時（不分大小寫）在副檔名前加 (2)、(3)… */
function uniqueFileName(name, used) {
  var base = String(name || 'file');
  var dot = base.lastIndexOf('.');
  var stem = dot > 0 ? base.slice(0, dot) : base;
  var ext = dot > 0 ? base.slice(dot) : '';
  var candidate = base;
  for (var n = 2; used.has(candidate.toLowerCase()); n++) {
    candidate = stem + ' (' + n + ')' + ext;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    stripTableLotNoise,
    isLikelyBatchLotToken,
    extractProductionPipeLetter,
    extractEquipmentPipeLetter,
    resolvePipeLetter,
    extractPipeLetterLoose,
    normalizeOcrForReportMatch,
    scoreProductionSignals,
    scoreEquipmentSignals,
    classifyReportType,
    guessReportTypeByScore,
    calculateHoverPreviewPosition,
    getPreviewFocusClass,
    normalizeOutputMonth,
    findFirstFileWithoutPipe,
    getFileVisualState,
    escapeHtml,
    getFileExtension,
    uniqueFileName
  };
}
