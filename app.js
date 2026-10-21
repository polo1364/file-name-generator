pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const THUMB_PLACEHOLDER = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="80" height="100"%3E%3Crect fill="%231a1a2e" width="80" height="100"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23a0a0b5" font-size="24"%3E📄%3C/text%3E%3C/svg%3E';

// 資源管理
const ResourceManager = {
  urls: new Set(),
  createURL(blob) {
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    return url;
  },
  revoke(url) {
    if (this.urls.has(url)) {
      URL.revokeObjectURL(url);
      this.urls.delete(url);
    }
  },
  clearAll() {
    this.urls.forEach(u => URL.revokeObjectURL(u));
    this.urls.clear();
  }
};

class Application {
  constructor() {
    this.files = [];
    this.isProcessing = false;
    this.isImporting = false;
    this.cancelRequested = false;
    this.ocrWorker = null;
    this.progressFrame = null;
    this.pendingProgress = null;
    this.activeOutputMonth = '';
    this.hugeFileBytes = 30 * 1024 * 1024;
    this.VALID_PIPE_LETTERS = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
    /** 每列管別按鈕可選字母（與現場管別一致） */
    this.PIPE_LETTER_CHOICES = ['A', 'B', 'C', 'D', 'E', 'F', 'J', 'M', 'N', 'O', 'P', 'Q', 'R'];
    this.lowPerfMode = false;
    this.pdfRenderScale = 5.15;
    this.titleRegionScale = 2.1;
    this.headerOcrScale = 2.75;
    this.topHalfOcrScale = 1.65;
    this.concurrencyLimit = 1;
    /** 長邊上限：避免超大圖一次塞滿 canvas / getImageData 導致分頁崩潰 */
    this.maxOcrImageEdge = 4500;
    /** 區塊放大後單邊上限（低效能再縮緊） */
    this.maxUpscaleEdge = 3200;
    /** 批次辨識中：不逐筆顯示最終檔名，等全部跑完再 renderList（含 -1、-2） */
    this.deferBatchUi = false;
    /** Client Hints：true=Win11，false=非 Win11 或他系統，null=尚無法判斷（多為 NT 10.0 UA） */
    this.isWindows11 = null;
    /** 低效能且「非 Win11」（含未知）：採最嚴格 OCR／記憶體參數；Win11+低效能用較寬鬆一級 */
    this.strictLowPerf = false;
    this.win7ExtremeMode = false;
    this.pdfCompatibilityMode = false;
    /** 每次「清空」遞增；匯入中途被清空時丟棄該批，避免舊檔案又冒出來 */
    this.clearGeneration = 0;
    /** 已載入大圖預覽的檔案 id，舊→新 */
    this.previewOrder = [];
    /** 批次中按「清空」：等目前檔案辨識完再清 */
    this.pendingClear = false;
  }

  /**
   * Vista～8.1（NT 6.0～6.3）。Win10/11 UA 多為 NT 10.0，需另靠 probeWindowsPlatform。
   */
  detectLegacyWindows() {
    try {
      var ua = navigator.userAgent || '';
      if (/Windows NT 6\.[0-3]/i.test(ua)) return true;
    } catch (e) {}
    return false;
  }

  /** 以 UA-CH 區分 Win11（platformVersion 主版 ≥13）與 Win10 等 */
  async probeWindowsPlatform() {
    this.isWindows11 = null;
    try {
      var ua = navigator.userAgent || '';
      if (!/Windows/i.test(ua)) {
        this.isWindows11 = false;
        return;
      }
      if (this.detectLegacyWindows()) {
        this.isWindows11 = false;
        return;
      }
      if (navigator.userAgentData && typeof navigator.userAgentData.getHighEntropyValues === 'function') {
        var h = await navigator.userAgentData.getHighEntropyValues(['platformVersion']);
        var pv = (h && h.platformVersion) ? String(h.platformVersion) : '';
        var major = parseInt(pv.split('.')[0], 10);
        if (navigator.userAgentData.platform === 'Windows' && !isNaN(major)) {
          this.isWindows11 = major >= 13;
          return;
        }
      }
      if (/Windows NT 10\.0/i.test(ua)) {
        this.isWindows11 = null;
        return;
      }
      this.isWindows11 = false;
    } catch (e) {
      this.isWindows11 = null;
    }
  }

  /** 推測是否為低階環境（僅供預設勾選，可手動改） */
  detectLowEndDevice() {
    try {
      if (this.detectLegacyWindows()) return true;
      var dm = navigator.deviceMemory;
      if (typeof dm === 'number' && dm <= 6) return true;
      var hc = navigator.hardwareConcurrency;
      if (typeof hc === 'number' && hc <= 2) return true;
    } catch (e) {}
    return false;
  }

  getOcrDpi() {
    if (!this.lowPerfMode) return '300';
    return this.strictLowPerf ? '150' : '180';
  }

  getLargeFilePauseMs(file) {
    if (!file || !file.size || file.size <= this.hugeFileBytes) return 0;
    if (this.strictLowPerf) return 500;
    if (this.lowPerfMode) return 320;
    return 160;
  }

  async pauseForLargeFile(file) {
    var ms = this.getLargeFilePauseMs(file);
    if (ms > 0) await new Promise(function(r) { setTimeout(r, ms); });
  }

  releaseCanvas(canvas) {
    if (!canvas) return;
    try {
      canvas.width = 0;
      canvas.height = 0;
    } catch (e) {}
  }

  dataUrlToBlob(dataUrl) {
    var parts = dataUrl.split(',');
    var match = parts[0].match(/:(.*?);/);
    var mime = match ? match[1] : 'image/png';
    var bin = atob(parts[1] || '');
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  canvasToBlobSafe(canvas, type, quality) {
    var self = this;
    return new Promise(function(resolve) {
      if (canvas && typeof canvas.toBlob === 'function') {
        try {
          canvas.toBlob(function(blob) {
            if (blob) return resolve(blob);
            try {
              resolve(self.dataUrlToBlob(canvas.toDataURL(type || 'image/png', quality)));
            } catch (e2) {
              resolve(null);
            }
          }, type, quality);
          return;
        } catch (e) {}
      }
      try {
        resolve(self.dataUrlToBlob(canvas.toDataURL(type || 'image/png', quality)));
      } catch (e3) {
        resolve(null);
      }
    });
  }

  /** 拖曳／選檔匯入上限（防一次解碼過多或單檔過大導致崩潰） */
  getImportLimits() {
    if (this.win7ExtremeMode) return { maxFiles: 30, maxBytes: 20 * 1024 * 1024 };
    if (this.strictLowPerf) return { maxFiles: 80, maxBytes: 40 * 1024 * 1024 };
    if (this.lowPerfMode) return { maxFiles: 120, maxBytes: 64 * 1024 * 1024 };
    return { maxFiles: 200, maxBytes: 96 * 1024 * 1024 };
  }

  getPerfModeLabel() {
    if (this.win7ExtremeMode) return 'Win7 極限模式';
    if (this.lowPerfMode) return '低效能模式';
    return '一般模式';
  }

  /** 接受副檔名／MIME（部分環境 type 為空） */
  acceptImportFile(file) {
    var t = file.type || '';
    if (t === 'application/pdf') return true;
    if (t.indexOf('image/') === 0) return true;
    var n = (file.name || '').toLowerCase();
    return /\.(pdf|jpe?g|png|gif|webp|bmp|tif|tiff)$/i.test(n);
  }

  async addFilesSafe(fileList) {
    if (this.isImporting) {
      alert('目前正在加入檔案，請等這批載入完成後再加入下一批。');
      return;
    }
    this.isImporting = true;
    try {
      await this.addFiles(fileList);
    } catch (e) {
      console.error(e);
      alert('加入檔案時發生錯誤（可能為記憶體不足）。請減少一次加入的數量、縮小檔案或開啟「低效能模式」後再試。');
    } finally {
      this.isImporting = false;
    }
  }

  async applyPerfProfile() {
    var chk = document.getElementById('lowPerfMode');
    if (chk) {
      this.lowPerfMode = !!chk.checked;
      try {
        localStorage.setItem('ocrLowPerf', this.lowPerfMode ? '1' : '0');
      } catch (e) {}
    } else {
      this.lowPerfMode = this.detectLowEndDevice();
    }
    this.win7ExtremeMode = !!(this.detectLegacyWindows() && this.lowPerfMode);
    this.strictLowPerf = !!(this.lowPerfMode && this.isWindows11 !== true);

    try {
      var reduceHeavyFx = this.win7ExtremeMode || (this.lowPerfMode && this.isWindows11 !== true);
      document.body.classList.toggle('legacy-win', reduceHeavyFx);
    } catch (e) {}

    if (this.lowPerfMode) {
      if (this.win7ExtremeMode) {
        this.pdfRenderScale = 0.9;
        this.titleRegionScale = 1.0;
        this.headerOcrScale = 1.15;
        this.topHalfOcrScale = 0.75;
        this.maxOcrImageEdge = 1100;
        this.maxUpscaleEdge = 1000;
      } else if (this.strictLowPerf) {
        this.pdfRenderScale = 1.2;
        this.titleRegionScale = 1.18;
        this.headerOcrScale = 1.38;
        this.topHalfOcrScale = 0.88;
        this.maxOcrImageEdge = 1440;
        this.maxUpscaleEdge = 1152;
      } else {
        this.pdfRenderScale = 1.35;
        this.titleRegionScale = 1.32;
        this.headerOcrScale = 1.58;
        this.topHalfOcrScale = 1.0;
        this.maxOcrImageEdge = 1920;
        this.maxUpscaleEdge = 1600;
      }
    } else {
      this.pdfRenderScale = 1.6;
      this.titleRegionScale = 2.1;
      this.headerOcrScale = 2.75;
      this.topHalfOcrScale = 1.65;
      this.maxOcrImageEdge = 4500;
      this.maxUpscaleEdge = 3200;
      if (this.isWindows11 === false || this.detectLegacyWindows()) {
        this.pdfRenderScale = 1.45;
        this.maxOcrImageEdge = 3200;
        this.maxUpscaleEdge = 2600;
      }
    }
    /** 單一 Tesseract worker 不應並行 recognize，一律序列化避免競態與崩潰 */
    this.concurrencyLimit = 1;
    if (this.ocrWorker) {
      await this.resetChiTraWorkerDefaults(this.ocrWorker);
    }
    try {
      this.updateUploadHint();
    } catch (e) {}
  }

  init() {
    const dropZone = document.getElementById('uploadArea');
    const input = document.getElementById('fileInput');
    var outputMonthInput = document.getElementById('outputMonth');
    this.getOutputMonth();
    if (outputMonthInput) {
      outputMonthInput.addEventListener('change', () => this.getOutputMonth());
    }
    
    dropZone.onclick = () => input.click();
    input.onchange = (e) => {
      var fl = Array.prototype.slice.call(e.target.files, 0);
      e.target.value = '';
      this.addFilesSafe(fl);
    };
    
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.style.borderColor = 'var(--primary)'; };
    dropZone.ondragleave = () => { dropZone.style.borderColor = ''; };
    dropZone.ondrop = (e) => {
      e.preventDefault();
      dropZone.style.borderColor = '';
      this.addFilesSafe(e.dataTransfer.files);
    };

    // ESC 關閉大圖預覽（只註冊一次，避免每次開預覽都多掛一個 listener）
    document.addEventListener('keydown', (e) => {
      var modal = document.getElementById('previewModal');
      if (e.key === 'Escape' && modal && modal.classList.contains('active')) {
        this.closePreview();
      }
    });

    var lowChk = document.getElementById('lowPerfMode');
    if (lowChk) {
      try {
        var saved = localStorage.getItem('ocrLowPerf');
        if (this.detectLegacyWindows()) lowChk.checked = true;
        else if (saved === '1' || saved === '0') lowChk.checked = saved === '1';
        else lowChk.checked = this.detectLowEndDevice();
      } catch (err) {
        lowChk.checked = this.detectLegacyWindows() || this.detectLowEndDevice();
      }
      lowChk.addEventListener('change', function() {
        App.applyPerfProfile().then(function() { App.updateUploadHint(); });
      });
    }
    var self = this;
    this.probeWindowsPlatform().then(function() {
      return self.applyPerfProfile();
    }).catch(function() {
      return self.applyPerfProfile();
    }).then(function() {
      self.updateUploadHint();
    });
  }

  getOutputMonth() {
    if (this.activeOutputMonth) return this.activeOutputMonth;
    var now = new Date();
    var fallback = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    var input = document.getElementById('outputMonth');
    var value = normalizeOutputMonth(input ? input.value : '', fallback);
    if (input && input.value !== value) input.value = value;
    return value;
  }

  updateUploadHint() {
    var el = document.getElementById('uploadHint');
    if (!el) return;
    var L = this.getImportLimits();
    el.textContent = '目前：' + this.getPerfModeLabel() + '。可一次拖入多個檔案（目前上限約 ' + L.maxFiles + ' 個）；PDF 會先讀文字層，無文字層才改用 OCR。大型圖片或異常大檔會自動略過。';
  }

  async addFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    var limits = this.getImportLimits();
    var arr = Array.prototype.slice.call(fileList, 0);
    if (arr.length > limits.maxFiles) {
      alert('一次最多處理 ' + limits.maxFiles + ' 個檔案，已只取前 ' + limits.maxFiles + ' 個。');
      arr = arr.slice(0, limits.maxFiles);
    }
    const newFiles = [];
    const generation = this.clearGeneration;
    const yieldToUI = function() { return new Promise(function(r) { setTimeout(r, 0); }); };
    var skippedSize = 0;
    var skippedType = 0;

    // 逐檔序列載入縮圖，避免一次拖入大量 PDF 時同時啟動多個 pdf.js 解析。
    for (var i = 0; i < arr.length; i++) {
      if (generation !== this.clearGeneration) return;
      var f = arr[i];
      if (!this.acceptImportFile(f)) {
        skippedType++;
        continue;
      }
      if (f.size > limits.maxBytes) {
        skippedSize++;
        continue;
      }
      if (!f.size) continue;
      await this.pauseForLargeFile(f);

      var fileData = {
        id: Math.random().toString(36).substr(2, 9),
        file: f,
        originalName: f.name,
        newName: '',
        processed: false,
        selectedPipeLetter: null,
        thumbnailUrl: null,
        previewUrl: null
      };
      try {
        await this.generateThumbnail(fileData);
      } catch (err) {
        console.error('縮圖失敗', f.name, err);
        fileData.thumbnailUrl = null;
        fileData.previewUrl = null;
      }
      newFiles.push(fileData);
      await yieldToUI();
      if (this.lowPerfMode) {
        var gap = this.strictLowPerf ? 48 : 20;
        await new Promise(function(r) { setTimeout(r, gap); });
      } else if (arr.length > 10) {
        await new Promise(function(r) { setTimeout(r, 6); });
      }
    }

    if (skippedSize > 0 || skippedType > 0) {
      var parts = [];
      if (skippedSize > 0) parts.push('PDF 太大或大型圖片超過約 ' + Math.round(limits.maxBytes / (1024 * 1024)) + ' MB：' + skippedSize + ' 個');
      if (skippedType > 0) parts.push('不支援的格式：' + skippedType + ' 個');
      alert('已略過部分檔案（' + parts.join('；') + '）');
    }

    if (generation !== this.clearGeneration) return;
    this.files = this.files.concat(newFiles);
    this.renderList();
  }

  async generateThumbnail(fileData) {
    try {
      var f = fileData.file;
      var isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');

      if (isPdf) {
        // 大量 PDF 匯入時不立即 render 首頁，避免一次拖入時暴增 canvas 記憶體。
        fileData.thumbnailUrl = null;
        fileData.previewUrl = null;
        fileData.previewPending = true;
        return;
      } else {
        var thumbW = 80;
        var thumbH = 100;
        var thumbFromBitmap = false;
        if (typeof createImageBitmap === 'function') {
          try {
            // 匯入階段只解碼小縮圖；大圖等滑鼠預覽時才載入，避免 Win7/10 被 6000×6000 bitmap 拖慢。
            var b = await createImageBitmap(f, { resizeWidth: thumbW * 2, resizeQuality: 'low' });
            var c1 = document.createElement('canvas');
            var x1 = c1.getContext('2d');
            c1.width = thumbW;
            c1.height = thumbH;
            var sca = Math.min(thumbW / b.width, thumbH / b.height);
            var sw = b.width * sca;
            var sh = b.height * sca;
            var ox = (thumbW - sw) / 2;
            var oy = (thumbH - sh) / 2;
            x1.fillStyle = '#1a1a2e';
            x1.fillRect(0, 0, thumbW, thumbH);
            x1.drawImage(b, ox, oy, sw, sh);
            b.close();
            var c1Blob = await this.canvasToBlobSafe(c1, 'image/png');
            if (c1Blob) fileData.thumbnailUrl = ResourceManager.createURL(c1Blob);
            this.releaseCanvas(c1);
            fileData.previewPending = true;
            thumbFromBitmap = true;
          } catch (eBm) {
            thumbFromBitmap = false;
          }
        }
        if (!thumbFromBitmap) {
          const originalUrl = ResourceManager.createURL(f);
          const img = new Image();
          await new Promise(function(resolve, reject) {
            img.onload = resolve;
            img.onerror = reject;
            img.src = originalUrl;
          });
          var nw = img.naturalWidth || img.width;
          var nh = img.naturalHeight || img.height;
          var maxPx = this.strictLowPerf ? 18e6 : 35e6;
          if (nw * nh > maxPx) {
            ResourceManager.revoke(originalUrl);
            fileData.previewUrl = null;
            fileData.thumbnailUrl = null;
            fileData.previewPending = true;
            return;
          }
          const c2 = document.createElement('canvas');
          var x2 = c2.getContext('2d');
          c2.width = thumbW;
          c2.height = thumbH;
          var sca2 = Math.min(thumbW / nw, thumbH / nh);
          var sw2 = nw * sca2;
          var sh2 = nh * sca2;
          var ox2 = (thumbW - sw2) / 2;
          var oy2 = (thumbH - sh2) / 2;
          x2.fillStyle = '#1a1a2e';
          x2.fillRect(0, 0, thumbW, thumbH);
          x2.drawImage(img, ox2, oy2, sw2, sh2);
          var c2Blob = await this.canvasToBlobSafe(c2, 'image/png');
          if (c2Blob) fileData.thumbnailUrl = ResourceManager.createURL(c2Blob);
          this.releaseCanvas(c2);
          ResourceManager.revoke(originalUrl);
          try { img.src = ''; } catch (eImg) {}
          fileData.previewPending = true;
        }
      }
    } catch (e) {
      console.error('生成縮圖失敗:', e);
      fileData.thumbnailUrl = null;
      fileData.previewUrl = null;
    }
  }

  /** 依辨識結果分區：生產日報表、設備點檢表；尚未辨識或失敗歸待辨識 */
  getFileReportGroup(f) {
    if (f.reportType === '生產日報表') return 'production';
    if (f.reportType === '設備點檢表') return 'equipment';
    return 'pending';
  }

  buildPipeLetterButtonsHTML(f) {
    if (f.processed || f.status === 'error') return '';
    const sel = f.selectedPipeLetter || '';
    const customVal = (sel && this.PIPE_LETTER_CHOICES.indexOf(sel) === -1) ? sel : '';
    const parts = [];
    parts.push('<div class="pipe-letter-row" id="pipe-row-' + f.id + '">');
    parts.push('<span class="pipe-letter-label">管別</span>');
    for (let i = 0; i < this.PIPE_LETTER_CHOICES.length; i++) {
      const L = this.PIPE_LETTER_CHOICES[i];
      const active = sel === L ? ' pipe-letter-btn--active' : '';
      parts.push('<button type="button" class="pipe-letter-btn' + active + '" onclick="App.selectPipeLetter(\'' + f.id + '\',\'' + L + '\')">' + L + '</button>');
    }
    parts.push(
      '<input type="text" class="pipe-letter-input" id="pipe-custom-' + f.id + '" maxlength="1" autocomplete="off" spellcheck="false" ' +
      'placeholder="其他" value="' + customVal + '" aria-label="自訂管別字母（A–Z）" title="可輸入按鈕未列出的英文字母" ' +
      'oninput="App.onPipeCustomInput(\'' + f.id + '\')">'
    );
    parts.push('</div>');
    return parts.join('');
  }

  buildFileRowHTML(f) {
    const thumbnailSrc = f.thumbnailUrl || THUMB_PLACEHOLDER;
    const needsCheckRow = f.processed && (f.pipeNeedsReview || f.reportTypeGuess);
    const visualState = getFileVisualState(f, this.getFileReportGroup(f));
    const statusText = f.processed && f.newName
      ? `新檔名：<span class="file-status__filename">${escapeHtml(f.newName)}</span>${f.reportTypeGuess ? ` <span>（報表類型為推測，請確認是否為生產／點檢）</span>` : ''}${f.pipeNeedsReview ? ` <span>（管別未選，請按「編輯檔名」修正）</span>` : ''}`
      : (f.status === 'error' ? `失敗: ${escapeHtml(f.errorMessage || '錯誤')}` : (f.selectedPipeLetter
        ? `等待中　<strong>已選管別 ${f.selectedPipeLetter}</strong>，可開始批次辨識`
        : `等待中　<strong>尚未選管別</strong>，請先選擇或輸入管別`));
    const badgeClass = f.processed
      ? (needsCheckRow ? 'status-badge processing' : 'status-badge completed')
      : (f.status === 'error' ? 'status-badge error' : 'status-badge pending');
    const badgeText = f.processed ? (needsCheckRow ? 'Check' : 'OK') : (f.status === 'error' ? 'Error' : 'Pending');
    const editDisplay = f.processed ? 'block' : 'none';
    const editRowDisplay = 'none';
    const largePreviewSrc = (f.previewUrl || thumbnailSrc).replace(/"/g, '&quot;');
    const previewTitle = f.previewPending ? '滑鼠移入載入預覽；雙擊全螢幕' : '滑鼠移入可看大圖；雙擊全螢幕';
    const previewFocusClass = getPreviewFocusClass(f.reportType);

    return `
      <div class="thumb-hover-wrap" onmouseenter="App.loadFilePreview('${f.id}', this)">
        <div class="thumbnail-container">
          <img class="thumbnail" src="${thumbnailSrc}" alt="縮圖" id="thumb-${f.id}" ondblclick="App.showPreview('${f.id}')" title="${previewTitle}"
            onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'80\\' height=\\'100\\'%3E%3Crect fill=\\'%231a1a2e\\' width=\\'80\\' height=\\'100\\'/%3E%3Ctext x=\\'50%25\\' y=\\'50%25\\' text-anchor=\\'middle\\' dy=\\'.3em\\' fill=\\'%23a0a0b5\\' font-size=\\'24\\'%3E📄%3C/text%3E%3C/svg%3E'">
        </div>
        <div class="thumb-hover-pop ${previewFocusClass}" aria-hidden="true">
          <img src="${largePreviewSrc}" alt="" id="preview-pop-${f.id}">
        </div>
      </div>
      <div class="file-info">
        ${this.buildPipeLetterButtonsHTML(f)}
        <div class="file-name" title="${escapeHtml(f.originalName)}">${escapeHtml(f.originalName)}</div>
        <div class="file-name-edit" id="edit-${f.id}" style="display: ${editRowDisplay};">
          <input type="text" class="file-name-input" id="input-${f.id}" placeholder="輸入新檔名"
            onkeydown="if (event.key === 'Enter') App.saveFileName('${f.id}'); else if (event.key === 'Escape') App.cancelEdit('${f.id}');">
          <button class="edit-btn" onclick="App.saveFileName('${f.id}')">儲存</button>
          <button class="edit-btn" onclick="App.cancelEdit('${f.id}')" style="background: #6c757d;">取消</button>
        </div>
      </div>
      <div class="file-row-actions" style="display: flex; flex-direction: column; gap: 8px; align-items: flex-end;">
        <span class="${badgeClass}" id="badge-${f.id}">${badgeText}</span>
        <button class="edit-btn" onclick="App.editFileName('${f.id}')" id="btn-edit-${f.id}" style="display: ${editDisplay}; padding: 4px 8px; font-size: 0.7rem;">編輯檔名</button>
      </div>
      <div class="file-status file-status--${visualState}" id="status-${f.id}">${statusText}</div>
    `;
  }

  renderList() {
    const container = document.getElementById('fileListContainer');
    const card = document.getElementById('listCard');

    if (this.files.length === 0) {
      card.style.display = 'none';
      return;
    }

    card.style.display = 'block';

    const n = this.files.length;
    const nProd = this.files.filter(f => this.getFileReportGroup(f) === 'production').length;
    const nEquip = this.files.filter(f => this.getFileReportGroup(f) === 'equipment').length;
    const nPend = n - nProd - nEquip;
    document.getElementById('fileCount').innerText =
      `檔案列表（${n}）　生產日報表 ${nProd}　設備點檢表 ${nEquip}　待辨識 ${nPend}`;

    const pending = this.files.filter(f => this.getFileReportGroup(f) === 'pending');
    const production = this.files.filter(f => this.getFileReportGroup(f) === 'production');
    const equipment = this.files.filter(f => this.getFileReportGroup(f) === 'equipment');

    container.innerHTML = '';

    const appendSection = (title, items, group) => {
      if (items.length === 0) return;
      const h = document.createElement('div');
      h.className = 'file-group-title file-group-title--' + group;
      h.textContent = `${title}（${items.length}）`;
      container.appendChild(h);
      items.forEach(f => {
        const div = document.createElement('div');
        const visualState = getFileVisualState(f, group);
        div.className = 'file-item file-item--' + group + (visualState === 'pipe-selected' ? ' file-item--pipe-selected' : '');
        div.id = f.id;
        div.innerHTML = this.buildFileRowHTML(f);
        container.appendChild(div);
      });
    };

    appendSection('待辨識', pending, 'pending');
    appendSection('生產日報表', production, 'production');
    appendSection('設備點檢表', equipment, 'equipment');
  }

  async getWorker() {
    if (!this.ocrWorker) {
      this.ocrWorker = await Tesseract.createWorker('chi_tra+eng');
      await this.resetChiTraWorkerDefaults(this.ocrWorker);
    }
    return this.ocrWorker;
  }

  async getPdfDocument(buffer) {
    const base = {
      data: buffer,
      stopAtErrors: true,
      useWorkerFetch: false,
      isEvalSupported: false
    };
    try {
      this.pdfCompatibilityMode = false;
      // pdf.js 會把 data 的 ArrayBuffer transfer 給 worker（原 buffer 變成 detached）；
      // 第一次若可能失敗後重試，就先給副本，讓相容模式拿到完整資料。
      return await pdfjsLib.getDocument(Object.assign({}, base, {
        data: this.win7ExtremeMode ? buffer : buffer.slice(0),
        disableWorker: !!this.win7ExtremeMode
      })).promise;
    } catch (e) {
      if (this.win7ExtremeMode) throw e;
      try {
        this.pdfCompatibilityMode = true;
        return await pdfjsLib.getDocument(Object.assign({}, base, {
          disableWorker: true
        })).promise;
      } catch (e2) {
        throw e2;
      }
    }
  }

  async extractPdfNativeTextFromDocument(pdf) {
    try {
      var fullText = '';
      var maxPages = this.strictLowPerf ? 1 : Math.min(pdf.numPages || 1, 2);
      for (var i = 1; i <= maxPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = (textContent.items || []).map(function(item) {
          return item && item.str ? item.str : '';
        }).join(' ');
        fullText += pageText + '\n';
        // 一旦文字層含報表關鍵字，就不再讀後續頁，避免不必要的 PDF 解析。
        if (this.isUsefulPdfText(fullText)) return fullText;
      }
      return fullText;
    } catch (e) {
      console.warn('PDF 原生文字抽取失敗，改走 OCR', e);
      return '';
    }
  }

  async extractPdfNativeText(file) {
    var pdf = null;
    try {
      const buffer = await file.arrayBuffer();
      pdf = await this.getPdfDocument(buffer);
      return await this.extractPdfNativeTextFromDocument(pdf);
    } catch (e) {
      console.warn('PDF 開啟失敗，改走 OCR', e);
      return '';
    } finally {
      try {
        if (pdf && typeof pdf.destroy === 'function') await pdf.destroy();
      } catch (ePdf) {}
    }
  }

  isUsefulPdfText(text) {
    var t = normalizeOcrForReportMatch(text || '');
    if (!t || t.length <= 5) return false;
    return /(生產日報表|設備點檢表|生產|日報|設備|點檢|管別|編號)/.test(t);
  }

  getFriendlyErrorMessage(error, fileData) {
    var msg = error && error.message ? String(error.message) : String(error || '');
    var name = (fileData && fileData.originalName) || '';
    var isPdf = /\.pdf$/i.test(name) || (fileData && fileData.file && fileData.file.type === 'application/pdf');
    if (/password|encrypted|加密|密碼/i.test(msg)) return 'PDF 已加密或需要密碼，已略過';
    if (/InvalidPDF|format|corrupt|damaged|xref|壞|損毀/i.test(msg)) return 'PDF 格式異常或檔案損毀，已略過';
    if (/worker|fake worker|setting up fake worker|PDFWorker/i.test(msg)) return 'PDF worker 失敗，已嘗試相容模式；仍無法讀取';
    if (/memory|allocation|quota|out of memory|insufficient resources|Array buffer allocation/i.test(msg)) {
      return isPdf ? 'OCR 記憶體不足（建議開啟 Win7 極限模式或分批處理）' : '圖片記憶體不足（建議縮小圖片或分批處理）';
    }
    if (/too large|canvas|maximum|exceed/i.test(msg)) return isPdf ? 'PDF 渲染尺寸過大，已略過' : '圖片尺寸過大，已略過';
    return msg || '未知錯誤';
  }

  async recycleOcrWorkerIfNeeded(doneCount, totalCount) {
    if (!this.lowPerfMode || !this.ocrWorker) return this.ocrWorker;
    const every = this.strictLowPerf ? 6 : 10;
    if (doneCount > 0 && doneCount < totalCount && doneCount % every === 0) {
      try {
        await this.ocrWorker.terminate();
      } catch (e) {}
      this.ocrWorker = null;
      await new Promise(function(r) { setTimeout(r, 80); });
      return await this.getWorker();
    }
    return this.ocrWorker;
  }

  async resetChiTraWorkerDefaults(worker) {
    await worker.setParameters({
      preserve_interword_spaces: '1',
      user_defined_dpi: this.getOcrDpi(),
      tessedit_pageseg_mode: '3',
      tessjs_create_hocr: '0',
      tessjs_create_tsv: '0',
      tessjs_create_box: '0',
      tessjs_create_unlv: '0',
    });
  }

  async processAll() {
    const pending = this.files.filter(f => !f.processed);
    if (pending.length === 0) return alert('沒有需要處理的檔案');

    const missingPipeFile = findFirstFileWithoutPipe(pending);
    if (missingPipeFile) {
      alert('檔案「' + missingPipeFile.originalName + '」尚未選擇管別，請先選擇或輸入管別。');
      this.focusMissingPipeSelection(missingPipeFile.id);
      return;
    }

    this.isProcessing = true;
    this.cancelRequested = false;
    this.deferBatchUi = true;
    this.activeOutputMonth = this.getOutputMonth();
    const outputMonthInput = document.getElementById('outputMonth');
    if (outputMonthInput) outputMonthInput.disabled = true;
    document.getElementById('btnProcess').disabled = true;
    const cancelBtn = document.getElementById('btnCancel');
    if (cancelBtn) {
      cancelBtn.disabled = false;
      cancelBtn.style.display = 'block';
    }
    let worker = null;
    let completedCount = 0;
    const total = pending.length;

    // 重設上一批留下的進度與「已取消」文字；上一批 2 秒後隱藏的計時也取消，免得把這批的進度條收掉
    clearTimeout(this.hidePanelTimer);
    this.pendingProgress = null;
    const batchBar = document.getElementById('batchBar');
    const batchCounter = document.getElementById('batchCounter');
    const batchStatus = document.getElementById('batchStatusText');
    if (batchBar) batchBar.style.width = '0%';
    if (batchCounter) batchCounter.textContent = `0 / ${total}`;
    if (batchStatus) batchStatus.textContent = '正在處理第 1 個檔案...';
    this.showBatchPanel(true);

    const yieldToUI = () => new Promise(function(r) { setTimeout(r, 0); });

    try {
      // 單一 Tesseract worker 序列處理，避免弱機或舊系統因併發 OCR 爆記憶體
      for (let i = 0; i < pending.length; i++) {
        if (this.cancelRequested) break;
        const fileData = pending[i];
        await this.processSingleFile(fileData, worker);

        completedCount++;
        this.updateBatchProgress(completedCount, total);
        worker = this.ocrWorker;
        worker = await this.recycleOcrWorkerIfNeeded(completedCount, total);
        await yieldToUI();
        if (this.cancelRequested) break;
      }
    } catch (e) {
      // 例如 worker 回收失敗：保留已完成結果，下面照常還原按鈕狀態
      console.error('批次處理中斷', e);
      alert('批次處理中斷：' + this.getFriendlyErrorMessage(e, null) + '。已完成的檔案會保留。');
    }

    this.deferBatchUi = false;
    // 處理重複檔名：為相同類型、管別、日期的檔案加上後綴
    this.handleDuplicateNames();
    this.renderList();

    this.isProcessing = false;
    if (outputMonthInput) outputMonthInput.disabled = false;
    this.activeOutputMonth = '';
    document.getElementById('btnProcess').disabled = false;
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.style.display = 'none';
    }
    document.getElementById('btnDownload').disabled = !this.files.some(f => f.processed && f.newName);
    if (this.cancelRequested) {
      // 丟棄尚未繪製的進度，避免下一個 frame 又把「已取消」蓋回「正在處理」
      this.pendingProgress = null;
      const statusText = document.getElementById('batchStatusText');
      if (statusText) statusText.textContent = this.pendingClear ? '已清空' : '已取消，保留已完成結果';
    }

    this.hidePanelTimer = setTimeout(() => this.showBatchPanel(false), 2000); // 2秒後隱藏進度條
    if (this.pendingClear) {
      this.pendingClear = false;
      await this.clearAll();
    }
  }

  cancelProcessing() {
    this.cancelRequested = true;
    const btn = document.getElementById('btnCancel');
    if (btn) btn.disabled = true;
    const statusText = document.getElementById('batchStatusText');
    if (statusText) statusText.textContent = '正在取消，完成目前檔案後停止...';
  }

  focusMissingPipeSelection(fileId) {
    document.querySelectorAll('.file-item--pipe-required').forEach(function(item) {
      item.classList.remove('file-item--pipe-required');
    });
    const item = document.getElementById(fileId);
    if (!item) return;
    item.classList.add('file-item--pipe-required');
    try {
      var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      item.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    } catch (e) {
      item.scrollIntoView();
    }
    const target = item.querySelector('.pipe-letter-btn, .pipe-letter-input');
    if (target) target.focus();
  }

  /** 由報表類型、管別、年月組成檔名主體（不含副檔名與重複後綴） */
  buildBaseNameFromMeta(f) {
    if (!f.dateStr || !f.pipeName) return '';
    if (f.reportType === '生產日報表') {
      return `成型上生產日報表${f.pipeName}-${f.dateStr}`;
    }
    if (f.reportType === '設備點檢表') {
      return `設備點檢表成型上${f.pipeName}-${f.dateStr}`;
    }
    return `${f.reportType}${f.pipeName}-${f.dateStr}`;
  }

  /** 同報表類型＋同管別＋同年月 為一組；鍵值正規化避免空白／字元不一致導致未合併 */
  duplicateGroupKey(f) {
    return [
      String(f.reportType || '').trim(),
      String(f.pipeName || '').trim(),
      String(f.dateStr || '').trim()
    ].join('\u0001');
  }

  handleDuplicateNames() {
    const groups = {};
    this.files.forEach(f => {
      // 使用者手動改過的檔名不再被自動編號覆蓋
      if (f.processed && !f.manualName && f.reportType && f.pipeName && f.dateStr) {
        const key = this.duplicateGroupKey(f);
        if (!groups[key]) groups[key] = [];
        groups[key].push(f);
      }
    });
    Object.keys(groups).forEach(key => {
      const files = groups[key].slice().sort(function(a, b) {
        const na = (a.originalName || '') + '\0' + (a.id || '');
        const nb = (b.originalName || '') + '\0' + (b.id || '');
        return na.localeCompare(nb, 'zh-Hant');
      });
      files.forEach((f, idx) => {
        const ext = getFileExtension(f.originalName, f.file && f.file.type);
        const base = this.buildBaseNameFromMeta(f);
        if (!base) return;
        if (files.length === 1) {
          f.newName = `${base}.${ext}`;
        } else {
          // 同組多筆：一律加 -1、-2、-3…（接在年月後），例如 …-2026-04-1.pdf
          f.newName = `${base}-${idx + 1}.${ext}`;
        }
      });
    });
  }

  /** 等待中：預選管別字母；再點同一字母取消。辨識完成後改以「編輯檔名」調整 */
  selectPipeLetter(fileId, letter) {
    const f = this.files.find(x => x.id === fileId);
    if (!f || f.processed || f.status === 'error') return;
    const L = String(letter).toUpperCase();
    if (this.PIPE_LETTER_CHOICES.indexOf(L) === -1) return;
    f.selectedPipeLetter = (f.selectedPipeLetter === L) ? null : L;
    this.renderList();
  }

  /** 自訂輸入格：可選 A–Z 中未出現在快捷按鈕上的字母（與 validatePipeLetter 規則一致） */
  onPipeCustomInput(fileId) {
    const el = document.getElementById('pipe-custom-' + fileId);
    const f = this.files.find(x => x.id === fileId);
    if (!el || !f || f.processed || f.status === 'error') return;
    const raw = (el.value || '').trim();
    if (!raw) {
      f.selectedPipeLetter = null;
      this.syncPipeRowUI(fileId);
      return;
    }
    const L = this.validatePipeLetter(raw.charAt(0));
    if (!L) {
      el.value = '';
      this.syncPipeRowUI(fileId);
      return;
    }
    f.selectedPipeLetter = L;
    if (this.PIPE_LETTER_CHOICES.indexOf(L) !== -1) {
      el.value = '';
    } else {
      el.value = L;
    }
    this.syncPipeRowUI(fileId);
  }

  syncPipeRowUI(fileId) {
    const f = this.files.find(x => x.id === fileId);
    if (!f) return;
    const row = document.getElementById('pipe-row-' + fileId);
    if (!row) return;
    const sel = f.selectedPipeLetter || '';
    row.querySelectorAll('.pipe-letter-btn').forEach(function(btn) {
      const L = btn.textContent.trim();
      btn.classList.toggle('pipe-letter-btn--active', sel === L);
    });
    const inp = document.getElementById('pipe-custom-' + fileId);
    if (inp) {
      if (sel && this.PIPE_LETTER_CHOICES.indexOf(sel) === -1) inp.value = sel;
      else inp.value = '';
    }
    const item = document.getElementById(fileId);
    if (item) item.classList.toggle('file-item--pipe-selected', !!sel);
    const statusEl = document.getElementById('status-' + fileId);
    if (statusEl && !f.processed && f.status !== 'error') {
      statusEl.className = 'file-status file-status--' + (sel ? 'pipe-selected' : 'pipe-missing');
      statusEl.innerHTML = sel
        ? '等待中　<strong>已選管別 ' + sel + '</strong>，可開始批次辨識'
        : '等待中　<strong>尚未選管別</strong>，請先選擇或輸入管別';
    }
    if (sel) {
      if (item) item.classList.remove('file-item--pipe-required');
    }
  }

  buildTextRegionBundle(text) {
    var raw = text || '';
    var clean = normalizeOcrForReportMatch(raw);
    return {
      centerTopText: raw,
      centerTopClean: clean,
      leftTopClean: clean,
      rightTopClean: clean,
      headerStripClean: clean,
      headerStripRaw: raw,
      leftTopRaw: raw,
      rightTopRaw: raw,
      topHalfClean: clean,
      fullClean: clean,
      topHalfRaw: raw,
      fullRaw: raw
    };
  }

  finishFileFromReportType(fileData, reportType, reportTypeGuess, fullText, statusEl, badgeEl) {
    const PIPE_PLACEHOLDER = '未辨識管';
    let pipeName = PIPE_PLACEHOLDER;
    let pipeNeedsReview = true;
    const preSel = fileData.selectedPipeLetter ? String(fileData.selectedPipeLetter).toUpperCase() : '';
    const validLetter = preSel ? this.validatePipeLetter(preSel.charAt(0)) : '';
    if (validLetter) {
      pipeName = validLetter + '管';
      pipeNeedsReview = false;
      fileData.selectedPipeLetter = validLetter;
    } else {
      fileData.selectedPipeLetter = null;
    }

    // 使用批次開始前選定的產出月份；重複檔名在全部完成後由 handleDuplicateNames 統一編號
    const dateStr = this.getOutputMonth();
    fileData.processed = true;
    fileData.ocrText = fullText || '';
    fileData.reportType = reportType;
    fileData.pipeName = pipeName;
    fileData.dateStr = dateStr;
    fileData.pipeNeedsReview = pipeNeedsReview;
    fileData.reportTypeGuess = reportTypeGuess;
    fileData.manualName = false;
    const ext = getFileExtension(fileData.originalName, fileData.file && fileData.file.type);
    const finalName = `${this.buildBaseNameFromMeta(fileData)}.${ext}`;
    fileData.newName = finalName;

    const needsCheck = pipeNeedsReview || reportTypeGuess;
    if (this.deferBatchUi) {
      statusEl.innerText = '待彙整…';
      statusEl.style.color = '#7f8c8d';
      badgeEl.className = 'status-badge processing';
      badgeEl.innerText = '…';
    } else {
      const typeGuessHint = reportTypeGuess
        ? ` <span style="color:#f1c40f;font-size:0.78rem">（報表類型為推測，請確認是否為生產／點檢）</span>`
        : '';
      const reviewHint = pipeNeedsReview
        ? ` <span style="color:#f1c40f;font-size:0.78rem">（管別未選，請按「編輯檔名」修正）</span>`
        : '';
      statusEl.innerHTML = `新檔名: <span style="color: var(--text-primary)">${escapeHtml(finalName)}</span>${typeGuessHint}${reviewHint}`;
      statusEl.style.color = 'var(--text-secondary)';
      badgeEl.className = needsCheck ? 'status-badge processing' : 'status-badge completed';
      badgeEl.innerText = needsCheck ? 'Check' : 'OK';
      const editBtn = document.getElementById(`btn-edit-${fileData.id}`);
      if (editBtn) editBtn.style.display = 'block';
    }
  }

  async tryProcessPdfNativeText(fileData, statusEl, badgeEl, pdfDocument) {
    const text = pdfDocument
      ? await this.extractPdfNativeTextFromDocument(pdfDocument)
      : await this.extractPdfNativeText(fileData.file);
    if (this.pdfCompatibilityMode && statusEl && !this.isUsefulPdfText(text)) {
      statusEl.innerText = 'PDF 相容模式：無可用文字層，改用 OCR...';
    }
    if (!this.isUsefulPdfText(text)) return false;
    const regions = this.buildTextRegionBundle(text);
    var reportType = classifyReportType(regions);
    var reportTypeGuess = false;
    if (!reportType) {
      reportType = guessReportTypeByScore(regions);
      if (reportType) reportTypeGuess = true;
    }
    if (!reportType) return false;
    this.finishFileFromReportType(fileData, reportType, reportTypeGuess, text, statusEl, badgeEl);
    return true;
  }

  async processSingleFile(fileData, worker) {
    const statusEl = document.getElementById(`status-${fileData.id}`);
    const badgeEl = document.getElementById(`badge-${fileData.id}`);
    if (!statusEl || !badgeEl) return;

    delete fileData.status;
    delete fileData.errorMessage;

    // 更新 UI：處理中（移除該列管別按鈕，避免與「正在識別」並存）
    statusEl.innerText = '正在識別...';
    statusEl.style.color = '#f1c40f';
    badgeEl.className = 'status-badge processing';
    badgeEl.innerText = 'Processing';
    const pipeRowEl = document.getElementById('pipe-row-' + fileData.id);
    if (pipeRowEl) pipeRowEl.remove();

    let imgUrl = null;
    let canvas = null;
    let origCanvas = null;
    let pdfDocument = null;
    var yieldMs = 0;
    if (this.lowPerfMode) yieldMs = this.strictLowPerf ? 28 : 12;
    const yieldUi = () => new Promise(r => setTimeout(r, yieldMs));
    try {
      await this.pauseForLargeFile(fileData.file);
      const isPdf = fileData.file.type === 'application/pdf' || /\.pdf$/i.test(fileData.originalName || '');
      if (isPdf) {
        statusEl.innerText = '正在讀取 PDF 文字層...';
        const buffer = await fileData.file.arrayBuffer();
        pdfDocument = await this.getPdfDocument(buffer);
        const usedNativeText = await this.tryProcessPdfNativeText(fileData, statusEl, badgeEl, pdfDocument);
        if (usedNativeText) return;
        if (!this.pdfCompatibilityMode) statusEl.innerText = 'PDF 為掃描影像，正在辨識...';
        await yieldUi();
        imgUrl = await this.pdfDocumentToImg(pdfDocument);
        await pdfDocument.destroy();
        pdfDocument = null;
      } else {
        imgUrl = ResourceManager.createURL(fileData.file);
      }

      worker = worker || await this.getWorker();

      // 使用區域識別來檢查中間靠上方區域（中文標題位置）
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = imgUrl;
      });

      canvas = this.buildOcrCanvasFromImage(img);
      const ctx = canvas.getContext('2d');
      if (imgUrl) {
        ResourceManager.revoke(imgUrl);
        imgUrl = null;
      }
      try { img.src = ''; } catch (e0) {}
      if (this.lowPerfMode) await yieldUi();

      // 先只辨識中央標題；成功時不建立整頁副本、不做 Otsu，也不建立其他裁切。
      const centerTopX = canvas.width * 0.12;
      const centerTopY = canvas.height * 0.02;
      const centerTopWidth = canvas.width * 0.76;
      const centerTopHeight = canvas.height * 0.28;

      const ts = this.titleRegionScale;
      const centerTopLo = this.cropCanvasRegion(canvas, centerTopX, centerTopY, centerTopWidth, centerTopHeight);
      const centerTopCanvas = this.upscaleCanvas(centerTopLo, ts);
      const centerTopDataUrl = centerTopCanvas.toDataURL();
      this.releaseCanvas(centerTopLo);
      this.releaseCanvas(centerTopCanvas);

      // 標題區塊用 PSM6（單一文字區），較利於橫式表頭中文
      let reportType = '';
      let fullText = '';
      let leftTopText = '';
      let rightTopText = '';
      let topHalfText = '';
      let fullPageText = '';

      var ocrDpi = this.getOcrDpi();
      await worker.setParameters({
        preserve_interword_spaces: '1',
        user_defined_dpi: ocrDpi,
        tessedit_pageseg_mode: '6',
      });
      var centerTopResult = await worker.recognize(centerTopDataUrl);
      const centerTopText = centerTopResult.data.text;
      const centerTopClean = centerTopText.replace(/\s+/g, '').toLowerCase();

      var topHalfClean = '';
      var fullClean = '';

      const regionBundle = {
        centerTopText: centerTopText,
        centerTopClean: centerTopClean,
        leftTopClean: '',
        rightTopClean: '',
        headerStripClean: '',
        headerStripRaw: '',
        leftTopRaw: '',
        rightTopRaw: '',
        topHalfClean: '',
        fullClean: '',
        topHalfRaw: '',
        fullRaw: ''
      };

      reportType = classifyReportType(regionBundle);
      if (reportType) {
        await this.resetChiTraWorkerDefaults(worker);
      } else {
        // 中央標題不明確時才跑四個補充區域；常見成功路徑由 5 次 OCR 降為 1 次。
        // 只有 fallback 才保留原圖並做整頁 Otsu，避免 Win7/10 在常見路徑搬動數千萬像素。
        origCanvas = document.createElement('canvas');
        origCanvas.width = canvas.width;
        origCanvas.height = canvas.height;
        origCanvas.getContext('2d').drawImage(canvas, 0, 0);

        {
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const px = imgData.data;
          const totalPx = canvas.width * canvas.height;
          const gray = new Uint8Array(totalPx);
          for (let i = 0; i < px.length; i += 4) {
            gray[i >> 2] = Math.round(px[i] * 0.299 + px[i+1] * 0.587 + px[i+2] * 0.114);
          }
          const hist = new Array(256).fill(0);
          for (let i = 0; i < totalPx; i++) hist[gray[i]]++;
          let sum = 0;
          for (let t = 0; t < 256; t++) sum += t * hist[t];
          let sumB = 0, wB = 0, maxVar = 0, thr = 128;
          for (let t = 0; t < 256; t++) {
            wB += hist[t];
            if (!wB) continue;
            const wF = totalPx - wB;
            if (!wF) break;
            sumB += t * hist[t];
            const diff = sumB / wB - (sum - sumB) / wF;
            const v = wB * wF * diff * diff;
            if (v > maxVar) { maxVar = v; thr = t; }
          }
          for (let i = 0; i < totalPx; i++) {
            const val = gray[i] < thr ? 0 : 255;
            const j = i * 4;
            px[j] = px[j+1] = px[j+2] = val;
          }
          ctx.putImageData(imgData, 0, 0);
        }

        const cornerWidth = canvas.width * 0.42;
        const cornerHeight = canvas.height * 0.28;
        const leftTopLo = this.cropCanvasRegion(origCanvas, 0, 0, cornerWidth, cornerHeight);
        const leftTopCanvas = this.upscaleCanvas(leftTopLo, ts);
        const leftTopDataUrl = leftTopCanvas.toDataURL();
        this.releaseCanvas(leftTopLo);
        this.releaseCanvas(leftTopCanvas);

        const rightTopLo = this.cropCanvasRegion(origCanvas, canvas.width - cornerWidth, 0, cornerWidth, cornerHeight);
        const rightTopCanvas = this.upscaleCanvas(rightTopLo, ts);
        const rightTopDataUrl = rightTopCanvas.toDataURL();
        this.releaseCanvas(rightTopLo);
        this.releaseCanvas(rightTopCanvas);

        const headerH = Math.round(canvas.height * 0.26);
        const hs = this.headerOcrScale;
        const headerStripLo = this.cropCanvasRegion(canvas, 0, 0, canvas.width, headerH);
        const headerStripCanvas = this.upscaleCanvas(headerStripLo, hs);
        const headerStripDataUrl = headerStripCanvas.toDataURL();
        this.releaseCanvas(headerStripLo);
        this.releaseCanvas(headerStripCanvas);

        const headerStripOrigLo = this.cropCanvasRegion(origCanvas, 0, 0, canvas.width, headerH);
        const headerStripOrigCanvas = this.upscaleCanvas(headerStripOrigLo, hs);
        const headerStripOrigDataUrl = headerStripOrigCanvas.toDataURL();
        this.releaseCanvas(headerStripOrigLo);
        this.releaseCanvas(headerStripOrigCanvas);

        await yieldUi();
        var leftTopResult = await worker.recognize(leftTopDataUrl);
        await yieldUi();
        var rightTopResult = await worker.recognize(rightTopDataUrl);
        await this.resetChiTraWorkerDefaults(worker);

        await worker.setParameters({
          preserve_interword_spaces: '1',
          user_defined_dpi: ocrDpi,
          tessedit_pageseg_mode: '6',
        });
        var headerStripResult = await worker.recognize(headerStripDataUrl);
        await yieldUi();
        var headerOrigResult = await worker.recognize(headerStripOrigDataUrl);
        await this.resetChiTraWorkerDefaults(worker);

        leftTopText = leftTopResult.data.text;
        rightTopText = rightTopResult.data.text;
        const headerBinRaw = this.normalizeHeaderOcrText(headerStripResult.data.text);
        const headerOrigRaw = this.normalizeHeaderOcrText(headerOrigResult.data.text);
        const headerStripText = headerBinRaw + '\n' + headerOrigRaw;
        regionBundle.leftTopClean = leftTopText.replace(/\s+/g, '').toLowerCase();
        regionBundle.rightTopClean = rightTopText.replace(/\s+/g, '').toLowerCase();
        regionBundle.headerStripClean = headerStripText.replace(/\s+/g, '').toLowerCase();
        regionBundle.headerStripRaw = headerStripText;
        regionBundle.leftTopRaw = leftTopText;
        regionBundle.rightTopRaw = rightTopText;
        reportType = classifyReportType(regionBundle);
      }

      // 第三步：區域＋表頭仍無法分類時，才識別上半部（原圖，避免二值化破壞中文）
      if (!reportType) {
        const thH = canvas.height * 0.42;
        const topHalfLo = this.cropCanvasRegion(origCanvas, 0, 0, canvas.width, thH);
        const topHalfCanvas = this.upscaleCanvas(topHalfLo, this.topHalfOcrScale);
        const topHalfDataUrl = topHalfCanvas.toDataURL();
        this.releaseCanvas(topHalfLo);
        this.releaseCanvas(topHalfCanvas);

        await worker.setParameters({
          preserve_interword_spaces: '1',
          user_defined_dpi: this.getOcrDpi(),
          tessedit_pageseg_mode: '6',
        });
        const topHalfResult = await worker.recognize(topHalfDataUrl);
        await this.resetChiTraWorkerDefaults(worker);

        topHalfText = topHalfResult.data.text;
        fullText = topHalfText;
        topHalfClean = topHalfText.replace(/\s+/g, '').toLowerCase();
        regionBundle.topHalfClean = topHalfClean;
        regionBundle.topHalfRaw = topHalfText;

        reportType = classifyReportType(regionBundle);
      }

      // 第四步：最後手段才全文 OCR（用已縮圖的 canvas，勿再餵原始大圖 URL）
      if (!reportType) {
        if (this.lowPerfMode) await yieldUi();
        var fullQ = this.lowPerfMode ? (this.strictLowPerf ? 0.68 : 0.74) : 0.88;
        const fullPageDataUrl = canvas.toDataURL('image/jpeg', fullQ);
        const fullResult = await worker.recognize(fullPageDataUrl);
        fullPageText = fullResult.data.text;
        fullText = fullPageText;
        fullClean = fullPageText.replace(/\s+/g, '').toLowerCase();
        regionBundle.topHalfClean = topHalfClean;
        regionBundle.fullClean = fullClean;
        regionBundle.fullRaw = fullPageText;

        reportType = classifyReportType(regionBundle);
      }

      var reportTypeGuess = false;
      if (!reportType) {
        reportType = guessReportTypeByScore(regionBundle);
        if (reportType) reportTypeGuess = true;
      }
      if (!reportType) {
        reportType = '生產日報表';
        reportTypeGuess = true;
      }

      // 管別以「等待中」預選字母為準；檔名組合與 PDF 文字層路徑共用
      this.finishFileFromReportType(fileData, reportType, reportTypeGuess, fullText, statusEl, badgeEl);
    } catch (e) {
      console.error(e);
      fileData.status = 'error';
      var msg = this.getFriendlyErrorMessage(e, fileData);
      fileData.errorMessage = msg;
      if (this.deferBatchUi) {
        statusEl.innerText = '待彙整…';
        statusEl.style.color = '#7f8c8d';
        badgeEl.className = 'status-badge processing';
        badgeEl.innerText = '…';
      } else {
        statusEl.innerText = `失敗: ${fileData.errorMessage}`;
        badgeEl.className = 'status-badge error';
        badgeEl.innerText = 'Error';
        const editBtn = document.getElementById(`btn-edit-${fileData.id}`);
        if (editBtn) editBtn.style.display = 'block';
      }
    } finally {
      // 重要：立刻釋放記憶體，否則 30 個檔案會吃光 RAM
      if (imgUrl) ResourceManager.revoke(imgUrl);
      this.releaseCanvas(canvas);
      this.releaseCanvas(origCanvas);
      try {
        if (pdfDocument && typeof pdfDocument.destroy === 'function') await pdfDocument.destroy();
      } catch (ePdf) {}
    }
  }

  /** 整張圖先縮到長邊上限再二值化／裁切，降低 getImageData 與 canvas 像素量，避免弱機種崩潰 */
  buildOcrCanvasFromImage(img) {
    const maxEdge = this.maxOcrImageEdge || 2000;
    const w = (img.naturalWidth || img.width) || 1;
    const h = (img.naturalHeight || img.height) || 1;
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = this.lowPerfMode ? 'low' : 'medium';
    ctx.drawImage(img, 0, 0, w, h, 0, 0, outW, outH);
    return canvas;
  }

  cropCanvasRegion(source, sx, sy, sw, sh) {
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    c.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    return c;
  }

  /** 表頭小字：放大後再送 OCR；低效能時限制輸出邊長避免爆 RAM */
  upscaleCanvas(source, scale) {
    let w = Math.round(source.width * scale);
    let h = Math.round(source.height * scale);
    const cap = this.maxUpscaleEdge || 3200;
    if (Math.max(w, h) > cap) {
      const s = cap / Math.max(w, h);
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = this.lowPerfMode ? 'low' : 'high';
    ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, w, h);
    return c;
  }

  /** 表頭 OCR 常見誤字，利於後續正則擷取管別 */
  normalizeHeaderOcrText(s) {
    return (s || '')
      .replace(/\u200b/g, '')
      .replace(/菅\s*別/g, '管別')
      .replace(/符\s*別/g, '管別')
      .replace(/筲\s*別/g, '管別')
      .replace(/官\s*別/g, '管別');
  }

  validatePipeLetter(letter) {
    if (!letter) return '';
    const upper = letter.toUpperCase();
    if (this.VALID_PIPE_LETTERS.has(upper)) return upper;
    const fixes = {'0':'O','8':'B','6':'G','9':'Q','4':'A','3':'E','1':'J','5':'S','2':'Z','|':'J'};
    const corrected = fixes[letter] || fixes[upper];
    return (corrected && this.VALID_PIPE_LETTERS.has(corrected)) ? corrected : '';
  }

  /** 管別僅英字（無中文）；從 OCR 片段中取出第一個可辨識的英數管別字元 */
  normalizePipeTokenToLetter(raw) {
    if (!raw) return '';
    const s = String(raw).trim();
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (/[A-Za-z0-9|]/.test(ch)) {
        const v = this.validatePipeLetter(ch);
        if (v) return v;
      }
    }
    return '';
  }

  /** maxPixels 只給預覽用：預覽不需要 OCR 等級的解析度 */
  async pdfDocumentToImg(pdf, maxPixels) {
    let canvas = null;
    try {
      const page = await pdf.getPage(1);
      var scale = this.pdfRenderScale;
      var maxPdfPixels = maxPixels || (this.win7ExtremeMode ? 6e6 : (this.strictLowPerf ? 10e6 : (this.lowPerfMode ? 16e6 : 28e6)));
      var viewport = page.getViewport({ scale: scale });
      var guard = 0;
      while (viewport.width * viewport.height > maxPdfPixels && scale > 0.5 && guard < 16) {
        scale *= 0.86;
        viewport = page.getViewport({ scale: scale });
        guard++;
      }
      canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await this.canvasToBlobSafe(canvas, 'image/jpeg', this.win7ExtremeMode ? 0.68 : 0.78);
      if (!blob) throw new Error('PDF 轉圖片失敗：此瀏覽器無法建立影像 Blob');
      return ResourceManager.createURL(blob);
    } finally {
      this.releaseCanvas(canvas);
    }
  }

  async pdfToImg(file, maxPixels) {
    const buffer = await file.arrayBuffer();
    const pdf = await this.getPdfDocument(buffer);
    try {
      return await this.pdfDocumentToImg(pdf, maxPixels);
    } finally {
      try {
        if (pdf && typeof pdf.destroy === 'function') await pdf.destroy();
      } catch (ePdf) {}
    }
  }

  updateBatchProgress(current, total) {
    const percent = (current / total) * 100;
    this.pendingProgress = {
      percent: percent,
      current: current,
      total: total
    };
    if (this.progressFrame) return;
    const run = () => {
      this.progressFrame = null;
      const p = this.pendingProgress;
      if (!p) return;
      const bar = document.getElementById('batchBar');
      const counter = document.getElementById('batchCounter');
      const text = document.getElementById('batchStatusText');
      if (bar) bar.style.width = `${p.percent}%`;
      if (counter) counter.textContent = `${p.current} / ${p.total}`;
      if (text) {
        text.textContent = p.percent === 100
          ? '處理完成！正在準備下載...'
          : `正在處理第 ${p.current} 個檔案...`;
      }
    };
    if (typeof requestAnimationFrame === 'function') {
      this.progressFrame = requestAnimationFrame(run);
    } else {
      this.progressFrame = setTimeout(run, 16);
    }
  }

  showBatchPanel(show) {
    const el = document.getElementById('batchPanel');
    if (show) el.classList.add('active');
    else el.classList.remove('active');
  }

  triggerDownload(blob, name) {
    var a = document.createElement('a');
    var url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  }

  /** 逐檔下載：瀏覽器可能詢問「允許下載多個檔案」 */
  downloadFilesIndividually(files) {
    var self = this;
    var delay = 0;
    var step = this.lowPerfMode ? (this.strictLowPerf ? 500 : 380) : 200;
    files.forEach(function(f) {
      setTimeout(function() { self.triggerDownload(f.file, f.newName); }, delay);
      delay += step;
    });
  }

  /** JSZip 只在按下載時才載入，不拖慢開頁 */
  loadJsZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (!this.jsZipPromise) {
      this.jsZipPromise = new Promise((resolve, reject) => {
        var s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s.onload = () => (window.JSZip ? resolve(window.JSZip) : reject(new Error('JSZip 未正確載入')));
        s.onerror = () => {
          this.jsZipPromise = null;
          reject(new Error('JSZip 載入失敗（可能無法連線 CDN）'));
        };
        document.head.appendChild(s);
      });
    }
    return this.jsZipPromise;
  }

  /** ZIP 上限：檔案全部讀進記憶體再打包，太大改逐檔下載 */
  getZipMaxBytes() {
    if (this.strictLowPerf) return 300 * 1024 * 1024;
    if (this.lowPerfMode) return 600 * 1024 * 1024;
    return 1500 * 1024 * 1024;
  }

  async downloadAll() {
    var ready = this.files.filter(function(f) { return f.processed && f.newName; });
    if (ready.length === 0) return;
    var totalBytes = ready.reduce(function(sum, f) { return sum + (f.file.size || 0); }, 0);
    // Win7／8 檔案總管不認 ZIP 的 UTF-8 檔名旗標，中文檔名會亂碼，改逐檔下載
    if (ready.length === 1 || this.detectLegacyWindows() || totalBytes > this.getZipMaxBytes()) {
      this.downloadFilesIndividually(ready);
      return;
    }

    var btn = document.getElementById('btnDownload');
    var label = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '打包中…';
    }
    try {
      var JSZip = await this.loadJsZip();
      var zip = new JSZip();
      var used = new Set();
      ready.forEach(function(f) {
        zip.file(uniqueFileName(f.newName, used), f.file, { binary: true });
      });
      // PDF／JPG 本身已壓縮，用 STORE 只打包不壓縮，速度快也省記憶體
      var blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (meta) => {
        if (btn) btn.textContent = '打包中… ' + Math.round(meta.percent) + '%';
      });
      this.triggerDownload(blob, 'ATV批次檔名-' + this.getOutputMonth() + '.zip');
    } catch (e) {
      console.warn('ZIP 打包失敗，改為逐檔下載', e);
      alert('ZIP 打包失敗（' + this.getFriendlyErrorMessage(e, null) + '），改為逐檔下載。');
      this.downloadFilesIndividually(ready);
    } finally {
      if (btn) {
        btn.textContent = label;
        btn.disabled = !this.files.some(function(f) { return f.processed && f.newName; });
      }
    }
  }

  async clearAll() {
    if (this.isProcessing) {
      // 直接中止 OCR worker 會讓目前檔案走錯誤流程；改為取消批次，等目前檔案結束後由 processAll 清空
      this.pendingClear = true;
      this.cancelProcessing();
      const statusText = document.getElementById('batchStatusText');
      if (statusText) statusText.textContent = '正在清空，完成目前檔案後停止...';
      return;
    }
    this.cancelRequested = true;
    this.clearGeneration++;
    this.previewOrder = [];
    this.files = [];
    ResourceManager.clearAll();
    document.getElementById('fileListContainer').innerHTML = '';
    document.getElementById('listCard').style.display = 'none';
    document.getElementById('btnDownload').disabled = true;
    const cancelBtn = document.getElementById('btnCancel');
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.style.display = 'none';
    }
    if (this.ocrWorker) {
      try {
        await this.ocrWorker.terminate();
      } catch (e) {}
      this.ocrWorker = null;
    }
  }

  async ensureFilePreview(fileData) {
    if (!fileData || fileData.previewUrl) return !!(fileData && fileData.previewUrl);
    if (fileData.previewLoading) {
      while (fileData.previewLoading) {
        await new Promise(function(r) { setTimeout(r, 120); });
      }
      return !!fileData.previewUrl;
    }
    var isPdf = fileData.file && (fileData.file.type === 'application/pdf' || /\.pdf$/i.test(fileData.originalName || ''));
    if (!fileData.file) return false;
    // 批次辨識中不改狀態列，避免正在辨識的檔案被改回「等待中」
    const statusEl = this.isProcessing ? null : document.getElementById(`status-${fileData.id}`);
    try {
      fileData.previewLoading = true;
      if (statusEl && !fileData.processed) statusEl.textContent = isPdf ? '正在產生 PDF 預覽...' : '正在載入預覽...';
      fileData.previewUrl = isPdf
        ? await this.pdfToImg(fileData.file, this.getPreviewMaxPixels())
        : ResourceManager.createURL(fileData.file);
      fileData.previewPending = false;
      // PDF 匯入時沒有縮圖：用預覽圖補一張小縮圖，之後預覽被回收也不會變回空白圖示
      if (!fileData.thumbnailUrl) await this.makeThumbnailFromUrl(fileData, fileData.previewUrl);
      const thumb = document.getElementById(`thumb-${fileData.id}`);
      const pop = document.getElementById(`preview-pop-${fileData.id}`);
      if (thumb) {
        thumb.src = fileData.thumbnailUrl || fileData.previewUrl;
        thumb.title = '滑鼠移入可看大圖；雙擊全螢幕';
      }
      if (pop) pop.src = fileData.previewUrl;
      this.rememberPreview(fileData);
      if (statusEl && !fileData.processed) {
        statusEl.className = 'file-status file-status--' + (fileData.selectedPipeLetter ? 'pipe-selected' : 'pipe-missing');
        statusEl.innerHTML = fileData.selectedPipeLetter
          ? `等待中　<strong>已選管別 ${fileData.selectedPipeLetter}</strong>，可開始批次辨識`
          : `等待中　<strong>尚未選管別</strong>，請先選擇或輸入管別`;
      }
      return true;
    } catch (e) {
      console.error('檔案預覽失敗', e);
      if (statusEl && !fileData.processed) statusEl.textContent = '預覽失敗，可直接開始辨識';
      return false;
    } finally {
      fileData.previewLoading = false;
    }
  }

  getPreviewMaxPixels() {
    if (this.win7ExtremeMode) return 1.5e6;
    if (this.lowPerfMode) return 2.5e6;
    return 4e6;
  }

  /** 同時保留的大圖預覽數；超過就釋放最久沒看的，避免一批上百張預覽常駐記憶體 */
  getPreviewKeepCount() {
    if (this.strictLowPerf) return 4;
    if (this.lowPerfMode) return 8;
    return 16;
  }

  async makeThumbnailFromUrl(fileData, url) {
    const img = new Image();
    try {
      await new Promise(function(resolve, reject) {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      const thumbW = 80;
      const thumbH = 100;
      const c = document.createElement('canvas');
      c.width = thumbW;
      c.height = thumbH;
      const x = c.getContext('2d');
      const nw = img.naturalWidth || 1;
      const nh = img.naturalHeight || 1;
      const sca = Math.min(thumbW / nw, thumbH / nh);
      x.fillStyle = '#1a1a2e';
      x.fillRect(0, 0, thumbW, thumbH);
      x.drawImage(img, (thumbW - nw * sca) / 2, (thumbH - nh * sca) / 2, nw * sca, nh * sca);
      const blob = await this.canvasToBlobSafe(c, 'image/png');
      if (blob) fileData.thumbnailUrl = ResourceManager.createURL(blob);
      this.releaseCanvas(c);
    } catch (e) {
      console.warn('縮圖補建失敗', e);
    } finally {
      try { img.src = ''; } catch (eImg) {}
    }
  }

  rememberPreview(fileData) {
    this.previewOrder = this.previewOrder.filter(id => id !== fileData.id);
    this.previewOrder.push(fileData.id);
    const keep = this.getPreviewKeepCount();
    while (this.previewOrder.length > keep) {
      const old = this.files.find(f => f.id === this.previewOrder[0]);
      this.previewOrder.shift();
      if (old) this.releaseFilePreview(old);
    }
  }

  releaseFilePreview(fileData) {
    if (!fileData.previewUrl) return;
    ResourceManager.revoke(fileData.previewUrl);
    fileData.previewUrl = null;
    fileData.previewPending = true;
    const pop = document.getElementById(`preview-pop-${fileData.id}`);
    if (pop) pop.src = fileData.thumbnailUrl || THUMB_PLACEHOLDER;
    const thumb = document.getElementById(`thumb-${fileData.id}`);
    if (thumb) {
      thumb.src = fileData.thumbnailUrl || THUMB_PLACEHOLDER;
      thumb.title = '滑鼠移入載入預覽；雙擊全螢幕';
    }
  }

  positionFilePreview(wrap) {
    if (!wrap) return;
    const pop = wrap.querySelector('.thumb-hover-pop');
    if (!pop) return;
    const anchorRect = wrap.getBoundingClientRect();
    const popupRect = pop.getBoundingClientRect();
    if (!popupRect.width || !popupRect.height) return;
    const position = calculateHoverPreviewPosition(
      anchorRect,
      popupRect,
      { width: window.innerWidth, height: window.innerHeight },
      12,
      10
    );
    pop.style.left = position.left + 'px';
    pop.style.top = position.top + 'px';
  }

  async loadFilePreview(fileId, wrap) {
    const fileData = this.files.find(f => f.id === fileId);
    if (!fileData) return;
    this.positionFilePreview(wrap);
    if (!fileData.previewUrl) await this.ensureFilePreview(fileData);
    this.positionFilePreview(wrap);
  }

  async showPreview(fileId) {
    const fileData = this.files.find(f => f.id === fileId);
    if (!fileData) return;
    if (!fileData.previewUrl) {
      const ok = await this.ensureFilePreview(fileData);
      if (!ok) return;
    }
    
    const modal = document.getElementById('previewModal');
    const img = document.getElementById('previewImg');
    img.src = fileData.previewUrl;
    modal.classList.add('active');
    
    // 點擊外部關閉
    modal.onclick = (e) => {
      if (e.target === modal) {
        this.closePreview();
      }
    };
  }

  closePreview() {
    const modal = document.getElementById('previewModal');
    modal.classList.remove('active');
  }

  editFileName(fileId) {
    const fileData = this.files.find(f => f.id === fileId);
    if (!fileData) return;
    
    const editDiv = document.getElementById(`edit-${fileId}`);
    const input = document.getElementById(`input-${fileId}`);
    const statusEl = document.getElementById(`status-${fileId}`);
    
    if (editDiv && input) {
      // 顯示編輯區域
      editDiv.style.display = 'flex';
      // 填入當前檔名（如果有）
      input.value = fileData.newName || fileData.originalName;
      input.focus();
      input.select();
    }
  }

  saveFileName(fileId) {
    const fileData = this.files.find(f => f.id === fileId);
    if (!fileData) return;
    
    const input = document.getElementById(`input-${fileId}`);
    const editDiv = document.getElementById(`edit-${fileId}`);
    const statusEl = document.getElementById(`status-${fileId}`);
    
    // Windows 不允許的檔名字元換成底線，避免下載時被瀏覽器改名
    const newName = input ? input.value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() : '';
    if (newName) {
      // 確保有副檔名（大小寫不同視為同一副檔名，避免 x.PDF.pdf）
      const ext = getFileExtension(fileData.originalName, fileData.file && fileData.file.type);
      fileData.newName = newName.toLowerCase().endsWith('.' + ext.toLowerCase()) ? newName : `${newName}.${ext}`;
      fileData.manualName = true;
      fileData.processed = true;
      // 使用者已親自確認檔名，移除推測／待修正提示與先前的錯誤狀態
      fileData.pipeNeedsReview = false;
      fileData.reportTypeGuess = false;
      delete fileData.status;
      delete fileData.errorMessage;

      if (editDiv) editDiv.style.display = 'none';
      if (!this.deferBatchUi) this.renderList();
      else if (statusEl) statusEl.innerHTML = `新檔名: <span style="color: var(--text-primary)">${escapeHtml(fileData.newName)}</span>`;
      document.getElementById('btnDownload').disabled = !this.files.some(f => f.processed && f.newName);
    }
  }

  cancelEdit(fileId) {
    const editDiv = document.getElementById(`edit-${fileId}`);
    if (editDiv) editDiv.style.display = 'none';
  }
}

const App = new Application();
window.addEventListener('load', () => App.init());
