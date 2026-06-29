(function () {
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CODE', 'PRE',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION'
  ]);
  const SKIP_ATTR_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CODE', 'PRE']);

  const ARYA_PHRASES = [
    'Arya 正在翻译…',
    '让 Arya 帮你看懂世界 ✨',
    '正在打破语言壁垒…',
    '正在为你阅读世界…',
    'Arya 正在施展魔法 ✨',
    '以爱连接每一种语言 💙',
    '快好了，请稍候…',
    'Arya 从不放弃 💪',
    '每一个词都认真对待…',
    'Arya 看清了整个世界 🌍',
  ];

  function getAryaPhrase() {
    return ARYA_PHRASES[Math.floor(Math.random() * ARYA_PHRASES.length)];
  }

  const translatedNodes = new WeakMap();
  const translatedAttrs = new WeakMap();
  const MUTATION_DEBOUNCE_MS = 350;
  const SKIP_ANCESTOR_CLASSES = new Set(['sr-only', 'visually-hidden', 'notranslate']);
  const isTopFrame = window === window.top;

  function isCrossOriginSubframe() {
    if (isTopFrame) return false;
    try {
      void window.parent.document;
      return false;
    } catch {
      return true;
    }
  }

  function shouldHandlePageTranslate() {
    return isTopFrame || isCrossOriginSubframe();
  }

  let isTranslating = false;
  let isProcessingIncremental = false;
  let isApplyingTranslation = false;
  let cancelRequested = false;
  let watchModeActive = false;
  let sessionId = null;
  let batchCounter = 0;
  let overlayEl = null;
  let domObserver = null;
  let mutationDebounceTimer = null;
  let activeSettings = null;
  const pendingIncrementalNodes = new Set();
  let sessionUsage = { inputChars: 0, estimatedTokens: 0 };
  let cachedSelection = null;
  let currentLangHint = '';
  let selectionBubbleEl = null;
  let selectionBubbleRaf = null;

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function scriptCounts(text) {
    const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const kana = (text.match(/[\u3040-\u30ff]/g) || []).length;
    const hangul = (text.match(/[\uac00-\ud7af]/g) || []).length;
    const latin = (text.match(/[a-zA-ZÀ-ÿ]/g) || []).length;
    const cyrillic = (text.match(/[\u0400-\u04ff]/g) || []).length;
    return { cjk, kana, hangul, latin, cyrillic, total: text.length };
  }

  function isLikelyNonTranslatable(text) {
    const t = text.trim();
    if (t.length < 2) return true;
    if (/^https?:\/\/\S+$/i.test(t)) return true;
    if (/^[\d\s.,:+\-/()%#]+$/.test(t)) return true;
    return false;
  }

  function likelyAlreadyTargetLanguage(text, targetLang) {
    if (!text || !targetLang) return false;
    if (isLikelyNonTranslatable(text)) return true;

    const { cjk, kana, hangul, latin, cyrillic, total } = scriptCounts(text);
    if (total === 0) return true;

    const lang = targetLang.toLowerCase();
    if (lang.includes('中文') || lang.includes('chinese')) {
      return cjk / total > 0.55 && latin / total < 0.2;
    }
    if (lang === 'english') {
      return latin / total > 0.65 && cjk === 0 && kana === 0 && hangul === 0;
    }
    if (lang.includes('日本')) {
      return (kana + cjk) / total > 0.4 && kana > 0;
    }
    if (lang.includes('한국') || lang.includes('korean')) {
      return hangul / total > 0.4;
    }
    if (lang.includes('français') || lang.includes('francais') || lang.includes('deutsch')
      || lang.includes('español') || lang.includes('espanol')) {
      return latin / total > 0.7 && cjk === 0 && kana === 0;
    }
    if (lang.includes('рус') || lang.includes('russian')) {
      return cyrillic / total > 0.45;
    }
    return false;
  }

  function detectPageLanguage(textNodes) {
    let combined = '';
    for (const node of textNodes) {
      const t = node.textContent.trim();
      if (t.length < 4 || isLikelyNonTranslatable(t)) continue;
      combined += `${t} `;
      if (combined.length > 2500) break;
    }
    if (!combined.trim()) return '未知';

    const { cjk, kana, hangul, latin, cyrillic, total } = scriptCounts(combined);
    if (total === 0) return '未知';
    if (kana / total > 0.06 && kana >= cjk * 0.05) return '日本語';
    if (hangul / total > 0.2) return '한국어';
    if (cyrillic / total > 0.2) return 'Русский';
    if (cjk / total > 0.22) return '中文';
    if (latin / total > 0.35) return 'English';
    return '混合';
  }

  function buildLangHint(sourceLang, targetLang) {
    return `Detected: ${sourceLang} → ${targetLang}`;
  }

  function pageLangMatchesTarget(sourceLang, targetLang) {
    if (!sourceLang || sourceLang === '未知' || sourceLang === '混合') return false;

    const target = targetLang.toLowerCase();
    if (sourceLang === '中文') {
      return target.includes('中文') || target.includes('chinese');
    }
    if (sourceLang === 'English') return target === 'english';
    if (sourceLang === '日本語') return target.includes('日本');
    if (sourceLang === '한국어') return target.includes('한국') || target.includes('korean');
    if (sourceLang === 'Русский') return target.includes('рус') || target.includes('russian');
    return false;
  }

  const AUTO_TRANSLATE_DELAY_MS = 1500;
  const AUTO_SKIP_SESSION_KEY = 'arya-auto-skip-url';
  const AUTO_DONE_SESSION_KEY = 'arya-auto-done-url';
  let autoTranslateTimer = null;

  function markAutoTranslateSkippedForPage() {
    try { sessionStorage.setItem(AUTO_SKIP_SESSION_KEY, location.href); } catch { /* ignore */ }
  }

  function wasAutoTranslateSkippedForPage() {
    try { return sessionStorage.getItem(AUTO_SKIP_SESSION_KEY) === location.href; } catch { return false; }
  }

  function markAutoTranslateDoneForPage() {
    try { sessionStorage.setItem(AUTO_DONE_SESSION_KEY, location.href); } catch { /* ignore */ }
  }

  function wasAutoTranslateDoneForPage() {
    try { return sessionStorage.getItem(AUTO_DONE_SESSION_KEY) === location.href; } catch { return false; }
  }

  function isRestrictedPageUrl() {
    const url = location.href;
    return url.startsWith('chrome://') || url.startsWith('edge://')
      || url.startsWith('chrome-extension://') || url.startsWith('moz-extension://')
      || url.startsWith('about:');
  }

  function hasTranslationAccess() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getConfig' }, (response) => {
        resolve(Boolean(response?.config?.hasApiKey));
      });
    });
  }

  async function maybeAutoTranslate() {
    if (!shouldHandlePageTranslate()) return;
    if (isRestrictedPageUrl()) return;
    if (isTranslating || isProcessingIncremental || watchModeActive) return;
    if (wasAutoTranslateSkippedForPage() || wasAutoTranslateDoneForPage()) return;

    const settings = await getSettings();
    if (!settings.autoTranslate) return;

    const canTranslate = await hasTranslationAccess();
    if (!canTranslate) return;

    const scannedNodes = await collectTextNodesAsync(() => {}, null);
    const detected = detectPageLanguage(scannedNodes);
    if (pageLangMatchesTarget(detected, settings.targetLang)) {
      markAutoTranslateDoneForPage();
      return;
    }

    const textNodes = scannedNodes.filter((node) => {
      const text = node.textContent.trim();
      return !likelyAlreadyTargetLanguage(text, settings.targetLang);
    });
    const attrItems = await collectAttrItemsAsync(settings.targetLang);
    if (!textNodes.length && !attrItems.length) {
      markAutoTranslateDoneForPage();
      return;
    }

    markAutoTranslateDoneForPage();
    await translatePage();
  }

  function scheduleAutoTranslate() {
    if (autoTranslateTimer) clearTimeout(autoTranslateTimer);
    autoTranslateTimer = setTimeout(() => {
      autoTranslateTimer = null;
      maybeAutoTranslate();
    }, AUTO_TRANSLATE_DELAY_MS);
  }

  function updateCachedSelection() {
    const sel = window.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) {
      hideSelectionBubble();
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      hideSelectionBubble();
      return;
    }
    try {
      cachedSelection = {
        text,
        range: sel.getRangeAt(0).cloneRange()
      };
      scheduleSelectionBubble();
    } catch {
      hideSelectionBubble();
    }
  }

  function isOurBubbleElement(el) {
    return el?.id === 'arya-selection-bubble' || Boolean(el?.closest?.('#arya-selection-bubble'));
  }

  function hideSelectionBubble() {
    if (selectionBubbleRaf) {
      cancelAnimationFrame(selectionBubbleRaf);
      selectionBubbleRaf = null;
    }
    if (selectionBubbleEl) {
      selectionBubbleEl.remove();
      selectionBubbleEl = null;
    }
  }

  function isSelectionInEditableContext(range) {
    let node = range.commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    while (node) {
      if (SKIP_TAGS.has(node.tagName)) return true;
      if (node.isContentEditable) return true;
      if (shouldSkipElement(node)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function scheduleSelectionBubble() {
    if (selectionBubbleRaf) cancelAnimationFrame(selectionBubbleRaf);
    selectionBubbleRaf = requestAnimationFrame(() => {
      selectionBubbleRaf = null;
      showSelectionBubble();
    });
  }

  function showSelectionBubble() {
    if (isTranslating || isProcessingIncremental) return;

    const sel = window.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) {
      hideSelectionBubble();
      return;
    }

    const text = sel.toString().trim();
    if (!text || text.length < 2 || isLikelyNonTranslatable(text)) {
      hideSelectionBubble();
      return;
    }

    let range;
    try {
      range = sel.getRangeAt(0);
      if (isSelectionInEditableContext(range)) {
        hideSelectionBubble();
        return;
      }
    } catch {
      hideSelectionBubble();
      return;
    }

    ensureOverlayStyles();
    hideSelectionBubble();

    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      hideSelectionBubble();
      return;
    }

    const bubble = document.createElement('div');
    bubble.id = 'arya-selection-bubble';
    bubble.innerHTML = '<button type="button" class="arya-bubble-btn" title="翻译选中文本">译</button>';

    const left = Math.min(Math.max(rect.right + 8, 8), window.innerWidth - 44);
    const top = Math.max(rect.top - 36, 8);
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;

    bubble.querySelector('.arya-bubble-btn').addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    bubble.querySelector('.arya-bubble-btn').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideSelectionBubble();
      translateSelection().then((result) => {
        if (result?.success) {
          const usage = formatUsageSuffix();
          showOverlay(`完成！已翻译选中内容${usage}`, 100);
          setTimeout(hideOverlay, 1800);
        } else if (result?.error && !result?.cancelled) {
          showOverlay(result.error, 0);
          setTimeout(hideOverlay, 2200);
        }
      });
    });

    document.documentElement.appendChild(bubble);
    selectionBubbleEl = bubble;
  }

  document.addEventListener('mouseup', updateCachedSelection, true);
  document.addEventListener('keyup', updateCachedSelection, true);
  document.addEventListener('scroll', hideSelectionBubble, true);
  document.addEventListener('mousedown', (e) => {
    if (!isOurBubbleElement(e.target)) hideSelectionBubble();
  }, true);

  function resetSessionUsage() {
    sessionUsage = { inputChars: 0, estimatedTokens: 0 };
  }

  function addSessionUsage(usage) {
    if (!usage) return;
    sessionUsage.inputChars += usage.inputChars || 0;
    sessionUsage.estimatedTokens += usage.estimatedTokens || 0;
  }

  function formatUsageSuffix() {
    if (sessionUsage.estimatedTokens <= 0) return '';
    return ` · 约 ${sessionUsage.estimatedTokens.toLocaleString()} tokens`;
  }

  function isOurOverlayElement(el) {
    return el?.id === 'bailian-translate-overlay' || el?.id === 'bailian-translate-styles'
      || Boolean(el?.closest?.('#bailian-translate-overlay'))
      || isOurBubbleElement(el);
  }

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (isOurOverlayElement(el)) return true;
    if (el.getAttribute('translate') === 'no') return true;
    for (const cls of el.classList || []) {
      if (SKIP_ANCESTOR_CLASSES.has(cls)) return true;
    }
    return false;
  }

  function isValidTranslation(text) {
    return text != null && String(text).trim().length > 0;
  }

  function attrsForElement(el) {
    const attrs = ['title', 'aria-label'];
    if (el.tagName === 'IMG') attrs.push('alt');
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') attrs.push('placeholder');
    return attrs;
  }

  function shouldCollectAttrsFrom(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (isOurOverlayElement(el) || shouldSkipElement(el)) return false;
    if (SKIP_ATTR_TAGS.has(el.tagName)) return false;
    return true;
  }

  function isAttrAlreadyTranslated(el, attr) {
    return translatedAttrs.get(el)?.has(attr);
  }

  function collectTextNodesFromRootTree(root, nodes, targetLang) {
    if (!root) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.textContent.trim();
        if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
        if (shouldSkipNode(node)) return NodeFilter.FILTER_REJECT;
        if (targetLang && likelyAlreadyTargetLanguage(text, targetLang)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    while (walker.nextNode()) nodes.push(walker.currentNode);

    const elWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (elWalker.nextNode()) {
      const el = elWalker.currentNode;
      if (el.shadowRoot) collectTextNodesFromRootTree(el.shadowRoot, nodes, targetLang);
      if (el.tagName === 'IFRAME') {
        try {
          const iframeBody = el.contentDocument?.body;
          if (iframeBody) collectTextNodesFromRootTree(iframeBody, nodes, targetLang);
        } catch {
          // 跨域 iframe
        }
      }
    }
  }

  function collectAttrItemsFromRoot(root, items, targetLang) {
    if (!root) return;

    const elWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (elWalker.nextNode()) {
      const el = elWalker.currentNode;
      if (!shouldCollectAttrsFrom(el)) continue;
      for (const attr of attrsForElement(el)) {
        const val = el.getAttribute(attr);
        if (!val || val.trim().length < 2) continue;
        if (isAttrAlreadyTranslated(el, attr)) continue;
        const text = val.trim();
        if (targetLang && likelyAlreadyTargetLanguage(text, targetLang)) continue;
        items.push({ element: el, attr, text });
      }
      if (el.shadowRoot) collectAttrItemsFromRoot(el.shadowRoot, items, targetLang);
      if (el.tagName === 'IFRAME') {
        try {
          const iframeBody = el.contentDocument?.body;
          if (iframeBody) collectAttrItemsFromRoot(iframeBody, items, targetLang);
        } catch {
          // 跨域 iframe
        }
      }
    }
  }

  function shouldSkipNode(node) {
    if (translatedNodes.has(node)) return true;
    let parent = node.parentElement;
    while (parent) {
      if (SKIP_TAGS.has(parent.tagName)) return true;
      if (shouldSkipElement(parent)) return true;
      parent = parent.parentElement;
    }
    return false;
  }

  function isNodeInSkipContext(node) {
    let parent = node.parentElement;
    while (parent) {
      if (SKIP_TAGS.has(parent.tagName)) return true;
      if (shouldSkipElement(parent)) return true;
      parent = parent.parentElement;
    }
    return false;
  }

  function getRangeWalkerRoot(range) {
    let root = range.commonAncestorContainer;
    if (root.nodeType === Node.TEXT_NODE) root = root.parentNode;
    return root;
  }

  function extractRangeTextSegments(range) {
    const segments = [];
    if (!range || range.collapsed) return segments;

    const root = getRangeWalkerRoot(range);
    if (!root) return segments;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        try {
          if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
        } catch {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    while (walker.nextNode()) {
      const node = walker.currentNode;
      let start = 0;
      let end = node.textContent.length;

      if (node === range.startContainer) start = range.startOffset;
      if (node === range.endContainer) end = range.endOffset;

      const rawText = node.textContent.substring(start, end);
      const text = rawText.trim();
      if (!text) continue;
      if (isNodeInSkipContext(node)) continue;

      segments.push({
        node,
        text,
        rawText,
        start,
        end,
        isFullNode: start === 0 && end === node.textContent.length
      });
    }
    return segments;
  }

  function applySegmentTranslation(segment, translated) {
    const { node, start, end, isFullNode, rawText } = segment;
    if (!isValidTranslation(translated)) return;

    if (isFullNode) {
      applyTranslation(node, translated);
      return;
    }

    isApplyingTranslation = true;
    try {
      const full = node.textContent;
      const before = full.substring(0, start);
      const after = full.substring(end);
      const parent = node.parentNode;
      if (!parent) return;

      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));

      const mid = document.createTextNode(translated);
      translatedNodes.set(mid, rawText.trim());
      frag.appendChild(mid);

      if (after) frag.appendChild(document.createTextNode(after));
      parent.replaceChild(frag, node);
    } finally {
      isApplyingTranslation = false;
    }
  }

  async function translateSelectionSegments(segments, settings) {
    const textToSegments = new Map();
    const uniqueTexts = [];

    for (const seg of segments) {
      if (!textToSegments.has(seg.text)) {
        textToSegments.set(seg.text, []);
        uniqueTexts.push(seg.text);
      }
      textToSegments.get(seg.text).push(seg);
    }

    const batches = settings.isMt
      ? chunkUniqueTexts(uniqueTexts)
      : chunkUniqueByCount(uniqueTexts, settings.batchSize);

    let applied = 0;

    for (const batch of batches) {
      if (cancelRequested) break;
      const translations = settings.isMt
        ? await translateBatchStreaming(batch.texts)
        : await translateBatchWithRetry(batch.texts);

      batch.globalIndices.forEach((uniqueIdx, i) => {
        const translated = translations[i];
        const segs = textToSegments.get(uniqueTexts[uniqueIdx]) || [];
        segs.forEach((seg) => {
          applySegmentTranslation(seg, translated);
          applied += 1;
        });
      });
    }

    return { count: applied };
  }

  function resolveSelectionRange(message = {}) {
    const sel = window.getSelection();
    const liveText = sel?.toString()?.trim();

    if (liveText && sel?.rangeCount && !sel.isCollapsed) {
      try {
        const range = sel.getRangeAt(0).cloneRange();
        cachedSelection = { text: liveText, range: range.cloneRange() };
        return { text: liveText, range };
      } catch {
        // fall through
      }
    }

    if (cachedSelection?.range) {
      try {
        const range = cachedSelection.range.cloneRange();
        const text = message.selectionText?.trim() || cachedSelection.text || range.toString().trim();
        if (text) return { text, range };
      } catch {
        cachedSelection = null;
      }
    }

    return null;
  }

  function ensureOverlayStyles() {
    if (document.getElementById('bailian-translate-styles')) return;
    const style = document.createElement('style');
    style.id = 'bailian-translate-styles';
    style.textContent = `
      #bailian-translate-overlay {
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        pointer-events: none;
      }
      .bailian-overlay-card {
        pointer-events: auto;
        background: rgba(255,255,255,0.97); border-radius: 12px; padding: 10px 14px;
        min-width: 200px; max-width: 280px;
        box-shadow: 0 6px 24px rgba(99,102,241,0.15), 0 1px 4px rgba(0,0,0,0.08);
        border: 1px solid rgba(99,102,241,0.15);
      }
      .bailian-overlay-header {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        margin-bottom: 6px;
      }
      .bailian-overlay-title {
        font-size: 13px; font-weight: 700; letter-spacing: 0.3px;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        background-clip: text;
      }
      .bailian-overlay-close {
        border: none; background: none; color: #bbb; font-size: 16px; line-height: 1;
        cursor: pointer; padding: 0 2px; transition: color 0.15s;
      }
      .bailian-overlay-close:hover { color: #dc2626; }
      .bailian-overlay-message { font-size: 11px; color: #555; margin-bottom: 8px; line-height: 1.5; }
      .bailian-overlay-lang {
        font-size: 10px; color: #6366f1; font-weight: 600; margin-bottom: 4px;
      }
      .bailian-overlay-status { font-size: 11px; color: #555; line-height: 1.5; }
      .bailian-overlay-bar { height: 3px; background: #eee; border-radius: 2px; overflow: hidden; }
      .bailian-overlay-fill { height: 100%; background: linear-gradient(90deg, #6366f1, #8b5cf6); width: 0%; transition: width 0.3s; }
      #arya-selection-bubble {
        position: fixed; z-index: 2147483646;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        pointer-events: auto;
      }
      #arya-selection-bubble .arya-bubble-btn {
        border: none; cursor: pointer;
        width: 32px; height: 32px; border-radius: 16px;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        color: #fff; font-size: 13px; font-weight: 700;
        box-shadow: 0 4px 14px rgba(99,102,241,0.35);
        transition: transform 0.12s, box-shadow 0.12s;
      }
      #arya-selection-bubble .arya-bubble-btn:hover {
        transform: scale(1.06);
        box-shadow: 0 6px 18px rgba(99,102,241,0.45);
      }
    `;
    document.head.appendChild(style);
  }

  function showOverlay(message, progress, langHint) {
    if (!isTopFrame) return;
    ensureOverlayStyles();
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.id = 'bailian-translate-overlay';
      overlayEl.innerHTML = `
        <div class="bailian-overlay-card">
          <div class="bailian-overlay-header">
            <div class="bailian-overlay-title">Arya Translate</div>
            <button class="bailian-overlay-close" type="button" title="取消">×</button>
          </div>
          <div class="bailian-overlay-message"></div>
          <div class="bailian-overlay-bar"><div class="bailian-overlay-fill"></div></div>
        </div>
      `;
      document.documentElement.appendChild(overlayEl);
      overlayEl.querySelector('.bailian-overlay-close').addEventListener('click', cancelTranslation);
    }

    if (langHint !== undefined) currentLangHint = langHint || '';

    const msgEl = overlayEl.querySelector('.bailian-overlay-message');
    if (currentLangHint) {
      msgEl.innerHTML = `<div class="bailian-overlay-lang">${escapeHtml(currentLangHint)}</div>`
        + `<div class="bailian-overlay-status">${escapeHtml(message)}</div>`;
    } else {
      msgEl.textContent = message;
    }

    overlayEl.querySelector('.bailian-overlay-fill').style.width = `${progress}%`;
    overlayEl.style.display = 'block';
  }

  function hideOverlay() {
    if (overlayEl && isTopFrame) overlayEl.style.display = 'none';
  }

  function showCancelledAndHide() {
    if (!isTopFrame) return;
    if (overlayEl) {
      const msgEl = overlayEl.querySelector('.bailian-overlay-message');
      if (currentLangHint) {
        msgEl.innerHTML = `<div class="bailian-overlay-lang">${escapeHtml(currentLangHint)}</div>`
          + `<div class="bailian-overlay-status">Arya 已停止，下次见 👋</div>`;
      } else {
        msgEl.textContent = 'Arya 已停止，下次见 👋';
      }
      overlayEl.querySelector('.bailian-overlay-fill').style.width = '0%';
    }
    setTimeout(hideOverlay, 1200);
  }

  const MT_BATCH_MAX_CHARS = 5800;
  const MT_BATCH_MAX_SEGMENTS = 45;
  const BATCH_TIMEOUT_MS = 90000;

  function yieldToMain() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function collectTextNodesAsync(onProgress, targetLang) {
    const nodes = [];
    if (document.body) {
      collectTextNodesFromRootTree(document.body, nodes, targetLang);
      if (nodes.length >= 400) {
        onProgress(`Arya 正在扫描… 已发现 ${nodes.length} 段文本`);
        await yieldToMain();
      }
    }
    return nodes;
  }

  async function collectAttrItemsAsync(targetLang) {
    const items = [];
    if (document.body) collectAttrItemsFromRoot(document.body, items, targetLang);
    return items;
  }

  async function collectMissedTextNodes() {
    const settings = activeSettings || await getSettings();
    const all = await collectTextNodesAsync(() => {}, settings.targetLang);
    return all.filter((node) => !translatedNodes.has(node));
  }

  async function sweepMissedNodes(settings) {
    let total = 0;
    for (let round = 0; round < 2; round++) {
      const missed = await collectMissedTextNodes();
      if (!missed.length || cancelRequested) break;
      showOverlay(`Arya 正在补译… 遗漏 ${missed.length} 段`, 85);
      const result = await translateNodeList(missed, settings, { incremental: true });
      total += result.count;
      if (!result.count) break;
    }
    return total;
  }

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(
        {
          batchSize: 40,
          concurrency: 4,
          model: 'qwen-mt-flash',
          targetLang: '简体中文',
          autoTranslate: false
        },
        (stored) => {
          const isMt = stored.model?.trim().toLowerCase().startsWith('qwen-mt');
          resolve({
            batchSize: Number(stored.batchSize) || 40,
            concurrency: Number(stored.concurrency) || 4,
            targetLang: stored.targetLang || '简体中文',
            autoTranslate: Boolean(stored.autoTranslate),
            isMt
          });
        }
      );
    });
  }

  function buildUniqueTextPlan(textNodes) {
    const textToNodes = new Map();
    const uniqueTexts = [];

    for (const node of textNodes) {
      const text = node.textContent.trim();
      if (!textToNodes.has(text)) {
        textToNodes.set(text, []);
        uniqueTexts.push(text);
      }
      textToNodes.get(text).push(node);
    }

    return { uniqueTexts, textToNodes, totalNodes: textNodes.length };
  }

  function buildUniqueAttrPlan(attrItems) {
    const textToItems = new Map();
    const uniqueTexts = [];

    for (const item of attrItems) {
      if (!textToItems.has(item.text)) {
        textToItems.set(item.text, []);
        uniqueTexts.push(item.text);
      }
      textToItems.get(item.text).push(item);
    }

    return { uniqueTexts, textToItems, totalItems: attrItems.length };
  }

  function chunkUniqueTexts(uniqueTexts, maxChars = MT_BATCH_MAX_CHARS, maxSegments = MT_BATCH_MAX_SEGMENTS) {
    const batches = [];
    let texts = [];
    let globalIndices = [];
    let charCount = 0;

    for (let i = 0; i < uniqueTexts.length; i++) {
      const text = uniqueTexts[i];
      const extra = texts.length ? 1 : 0;
      const wouldExceed = texts.length >= maxSegments || charCount + text.length + extra > maxChars;

      if (wouldExceed && texts.length) {
        batches.push({ texts: [...texts], globalIndices: [...globalIndices], charCount });
        texts = [];
        globalIndices = [];
        charCount = 0;
      }

      texts.push(text);
      globalIndices.push(i);
      charCount += text.length + (texts.length > 1 ? 1 : 0);
    }

    if (texts.length) batches.push({ texts, globalIndices, charCount });
    return batches;
  }

  function chunkUniqueByCount(uniqueTexts, batchSize) {
    const batches = [];
    for (let i = 0; i < uniqueTexts.length; i += batchSize) {
      const texts = uniqueTexts.slice(i, i + batchSize);
      batches.push({
        texts,
        globalIndices: texts.map((_, j) => i + j)
      });
    }
    return batches;
  }

  async function translateBatchWithRetry(texts, maxRetries = 3) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await translateBatch(texts);
      } catch (error) {
        if (error.cancelled) throw error;
        lastError = error;
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }

  function translateBatchStreaming(texts, onPartial) {
    const requestId = `${sessionId}-${batchCounter++}`;

    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'translate' });
      let settled = false;

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        port.disconnect();
        reject(new Error('翻译请求超时，请刷新插件后重试'));
      }, BATCH_TIMEOUT_MS);

      port.onMessage.addListener((msg) => {
        if (msg.type === 'partial' && onPartial) {
          onPartial(msg.segments);
        } else if (msg.type === 'done') {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          port.disconnect();
          addSessionUsage(msg.usage);
          resolve(msg.translations);
        } else if (msg.type === 'error') {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          port.disconnect();
          const err = new Error(msg.error || '翻译失败');
          err.cancelled = Boolean(msg.cancelled);
          reject(err);
        }
      });

      port.onDisconnect.addListener(() => {
        if (settled) return;
        if (chrome.runtime.lastError) {
          settled = true;
          clearTimeout(timeoutId);
          reject(new Error(chrome.runtime.lastError.message));
        }
      });

      port.postMessage({ action: 'translateBatch', texts, requestId });
    });
  }

  function translateBatch(texts) {
    const requestId = `${sessionId}-${batchCounter++}`;

    const batchPromise = new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'ping' }).catch(() => {});
      chrome.runtime.sendMessage({ action: 'translateBatch', texts, requestId }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.success) {
          const err = new Error(response?.error || '翻译失败');
          err.cancelled = Boolean(response?.cancelled);
          reject(err);
          return;
        }
        addSessionUsage(response.usage);
        resolve(response.translations);
      });
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('翻译请求超时，请刷新插件后重试')), BATCH_TIMEOUT_MS);
    });

    return Promise.race([batchPromise, timeoutPromise]);
  }

  function startBatchHeartbeat(batchIndex, totalBatches, onTick) {
    let elapsed = 0;
    let phraseIndex = Math.floor(Math.random() * ARYA_PHRASES.length);
    return setInterval(() => {
      elapsed += 3;
      phraseIndex = (phraseIndex + 1) % ARYA_PHRASES.length;
      onTick(batchIndex, totalBatches, elapsed, ARYA_PHRASES[phraseIndex]);
    }, 3000);
  }

  function applyTranslation(node, translated) {
    if (!translatedNodes.has(node)) {
      translatedNodes.set(node, node.textContent);
    }
    isApplyingTranslation = true;
    try {
      node.textContent = translated;
    } finally {
      isApplyingTranslation = false;
    }
  }

  function applyAttrTranslation(item, translated) {
    const { element, attr } = item;
    if (!translatedAttrs.has(element)) translatedAttrs.set(element, new Map());
    const originals = translatedAttrs.get(element);
    if (!originals.has(attr)) originals.set(attr, element.getAttribute(attr));
    isApplyingTranslation = true;
    try {
      element.setAttribute(attr, translated);
    } finally {
      isApplyingTranslation = false;
    }
  }

  function stopWatchMode() {
    watchModeActive = false;
    activeSettings = null;
    pendingIncrementalNodes.clear();
    if (mutationDebounceTimer) {
      clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = null;
    }
    if (domObserver) {
      domObserver._spaCleanup?.();
      domObserver._iframeCleanup?.();
      domObserver.disconnect();
      domObserver = null;
    }
  }

  function restoreInRoot(root) {
    if (!root) return;
    const scope = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE || root.nodeType === Node.ELEMENT_NODE
      ? root
      : root.body;
    if (!scope?.querySelectorAll) return;

    scope.querySelectorAll('.arya-translated').forEach((wrapper) => {
      const textNode = wrapper.firstChild;
      if (textNode?.nodeType === Node.TEXT_NODE && wrapper.parentNode) {
        const original = translatedNodes.get(textNode);
        if (original !== undefined) {
          textNode.textContent = original;
          translatedNodes.delete(textNode);
        }
        wrapper.parentNode.replaceChild(textNode, wrapper);
      }
    });

    const elWalker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
    while (elWalker.nextNode()) {
      const el = elWalker.currentNode;
      const attrMap = translatedAttrs.get(el);
      if (attrMap) {
        for (const [attr, original] of attrMap) {
          if (original == null) el.removeAttribute(attr);
          else el.setAttribute(attr, original);
        }
        translatedAttrs.delete(el);
      }
      if (el.shadowRoot) restoreInRoot(el.shadowRoot);
      if (el.tagName === 'IFRAME') {
        try {
          if (el.contentDocument?.body) restoreInRoot(el.contentDocument.body);
        } catch {
          // 跨域 iframe
        }
      }
    }
  }

  function restoreOriginal() {
    stopWatchMode();
    hideSelectionBubble();
    markAutoTranslateSkippedForPage();
    sessionId = null;
    resetSessionUsage();
    isApplyingTranslation = true;
    try {
      if (document.body) restoreInRoot(document.body);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const original = translatedNodes.get(node);
        if (original !== undefined) {
          node.textContent = original;
          translatedNodes.delete(node);
        }
      }
    } finally {
      isApplyingTranslation = false;
    }
  }

  function cancelTranslation() {
    cancelRequested = true;
    hideSelectionBubble();
    const sid = sessionId;
    stopWatchMode();
    if (sid) {
      chrome.runtime.sendMessage({ action: 'cancelSession', sessionId: sid });
    }
    sessionId = null;
    showCancelledAndHide();
  }

  function collectTextNodesFromRoot(root) {
    const nodes = [];
    if (!root) return nodes;

    if (root.nodeType === Node.TEXT_NODE) {
      const text = root.textContent.trim();
      if (text.length >= 2 && !shouldSkipNode(root)) nodes.push(root);
      return nodes;
    }

    if (root.nodeType !== Node.ELEMENT_NODE || isOurOverlayElement(root)) return nodes;

    collectTextNodesFromRootTree(root, nodes);
    return nodes;
  }

  function extractTextNodesFromMutations(records) {
    const nodes = new Set();
    for (const record of records) {
      if (record.type === 'characterData' && record.target?.nodeType === Node.TEXT_NODE) {
        collectTextNodesFromRoot(record.target).forEach((n) => nodes.add(n));
      }
      for (const node of record.addedNodes || []) {
        collectTextNodesFromRoot(node).forEach((n) => nodes.add(n));
      }
    }
    return [...nodes];
  }

  function scheduleIncrementalFlush() {
    if (!watchModeActive || mutationDebounceTimer) return;
    mutationDebounceTimer = setTimeout(() => {
      mutationDebounceTimer = null;
      flushIncrementalQueue();
    }, MUTATION_DEBOUNCE_MS);
  }

  function queueIncrementalNodes(nodes) {
    if (!watchModeActive || !nodes.length) return;
    for (const node of nodes) pendingIncrementalNodes.add(node);
    scheduleIncrementalFlush();
  }

  async function translateAttrList(attrItems, settings, { incremental = false } = {}) {
    if (!attrItems.length || cancelRequested) return { count: 0, failed: 0 };

    const { uniqueTexts, textToItems, totalItems } = buildUniqueAttrPlan(attrItems);
    if (!uniqueTexts.length) return { count: 0, failed: 0 };

    const batches = settings.isMt
      ? chunkUniqueTexts(uniqueTexts)
      : chunkUniqueByCount(uniqueTexts, settings.batchSize);

    let completed = 0;
    const failedBatches = [];

    async function processAttrBatch(batch) {
      try {
        const translations = settings.isMt
          ? await translateBatchStreaming(batch.texts)
          : await translateBatchWithRetry(batch.texts);
        batch.globalIndices.forEach((uniqueIdx, i) => {
          const translated = translations[i];
          if (!isValidTranslation(translated)) return;
          const items = textToItems.get(uniqueTexts[uniqueIdx]) || [];
          items.forEach((item) => {
            applyAttrTranslation(item, translated);
            completed += 1;
          });
        });
      } catch (error) {
        if (!error.cancelled && !cancelRequested) failedBatches.push(batch);
      }
    }

    if (settings.concurrency <= 1) {
      for (const batch of batches) {
        if (cancelRequested) break;
        await processAttrBatch(batch);
      }
    } else {
      let index = 0;
      async function worker() {
        while (index < batches.length) {
          if (cancelRequested) return;
          const current = index++;
          await processAttrBatch(batches[current]);
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(settings.concurrency, batches.length) }, () => worker())
      );
    }

    return { count: completed, failed: Math.max(0, totalItems - completed) };
  }

  async function translateNodeList(textNodes, settings, { incremental = false } = {}) {
    if (!textNodes.length || cancelRequested) return { count: 0, failed: 0 };

    const { uniqueTexts, textToNodes, totalNodes } = buildUniqueTextPlan(textNodes);
    if (!uniqueTexts.length) return { count: 0, failed: 0 };

    const ctx = { textToNodes, uniqueTexts, totalNodes, isMt: settings.isMt };
    const batches = settings.isMt
      ? chunkUniqueTexts(uniqueTexts)
      : chunkUniqueByCount(uniqueTexts, settings.batchSize);

    if (incremental) {
      showOverlay(`Arya 发现 ${totalNodes} 段新内容…`, 30);
    }

    const { completed, failedBatches } = await runConcurrent(
      batches,
      settings.concurrency,
      (done, totalBatches, batchIndex, failCount = 0) => {
        if (cancelRequested) return;
        if (incremental) {
          showOverlay(
            `正在翻译新内容… ${done}/${totalNodes}`,
            Math.min(95, Math.round((done / totalNodes) * 100))
          );
        } else {
          showOverlay(
            failCount
              ? `正在重试 ${failCount} 批… ${done}/${totalNodes}`
              : getAryaPhrase(),
            Math.round((done / totalNodes) * 100)
          );
        }
      },
      ctx
    );

    if (cancelRequested) return { count: completed, failed: 0, cancelled: true };

    let finalFailed = failedBatches;
    if (failedBatches.length > 0 && !incremental) {
      showOverlay('Arya 正在重试… 💪', Math.round((completed / totalNodes) * 100));
    }
    if (failedBatches.length > 0) {
      const retryResult = await retryFailedBatches(
        failedBatches,
        incremental
          ? () => {}
          : (recovered, total, idx, stillCount, nodeTotal) => {
              showOverlay(
                `重试 ${idx}/${total}（${completed + recovered}/${nodeTotal}）`,
                Math.round(((completed + recovered) / totalNodes) * 100)
              );
            },
        ctx
      );
      finalFailed = retryResult.stillFailed;
    }

    const failedNodeCount = finalFailed.reduce((n, b) => {
      return n + b.globalIndices.reduce(
        (sum, idx) => sum + (textToNodes.get(uniqueTexts[idx])?.length || 0),
        0
      );
    }, 0);

    return { count: totalNodes - failedNodeCount, failed: failedNodeCount };
  }

  async function flushIncrementalQueue() {
    if (!watchModeActive || isProcessingIncremental || isTranslating || cancelRequested) return;
    if (!pendingIncrementalNodes.size || !activeSettings) return;

    const nodes = [...pendingIncrementalNodes];
    pendingIncrementalNodes.clear();
    isProcessingIncremental = true;

    try {
      const result = await translateNodeList(nodes, activeSettings, { incremental: true });
      if (result.count > 0 && watchModeActive) {
        showOverlay(`+${result.count} 段新内容已翻译 ✓`, 100);
        setTimeout(() => {
          if (watchModeActive) hideOverlay();
        }, 1200);
      } else if (watchModeActive) {
        hideOverlay();
      }
    } catch {
      if (watchModeActive) hideOverlay();
    } finally {
      isProcessingIncremental = false;
      if (pendingIncrementalNodes.size > 0) scheduleIncrementalFlush();
    }
  }

  function onDomMutation(records) {
    if (!watchModeActive || isApplyingTranslation || cancelRequested) return;
    const nodes = extractTextNodesFromMutations(records);
    if (nodes.length) queueIncrementalNodes(nodes);
  }

  function bindIframeWatchers() {
    const onIframeLoad = (event) => {
      if (!watchModeActive) return;
      const iframe = event.target;
      if (iframe?.tagName !== 'IFRAME') return;
      try {
        const nodes = [];
        collectTextNodesFromRootTree(iframe.contentDocument?.body, nodes);
        const missed = nodes.filter((n) => !translatedNodes.has(n));
        if (missed.length) queueIncrementalNodes(missed);
      } catch {
        // 跨域 iframe
      }
    };

    document.querySelectorAll('iframe').forEach((iframe) => {
      iframe.addEventListener('load', onIframeLoad);
    });

    const iframeObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes || []) {
          if (node.tagName === 'IFRAME') node.addEventListener('load', onIframeLoad);
          node.querySelectorAll?.('iframe').forEach((iframe) => {
            iframe.addEventListener('load', onIframeLoad);
          });
        }
      }
    });
    iframeObserver.observe(document.documentElement, { childList: true, subtree: true });

    return () => {
      document.querySelectorAll('iframe').forEach((iframe) => {
        iframe.removeEventListener('load', onIframeLoad);
      });
      iframeObserver.disconnect();
    };
  }

  function startWatchMode(settings) {
    stopWatchMode();
    watchModeActive = true;
    activeSettings = settings;
    if (!sessionId) sessionId = String(Date.now());

    domObserver = new MutationObserver(onDomMutation);
    domObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    const onSpaNav = () => {
      if (!watchModeActive) return;
      collectTextNodesAsync(() => {}, settings.targetLang).then((nodes) => {
        if (nodes.length) queueIncrementalNodes(nodes);
      });
    };

    window.addEventListener('popstate', onSpaNav);
    window.addEventListener('hashchange', onSpaNav);

    domObserver._spaCleanup = () => {
      window.removeEventListener('popstate', onSpaNav);
      window.removeEventListener('hashchange', onSpaNav);
    };
    domObserver._iframeCleanup = bindIframeWatchers();

    collectTextNodesAsync(() => {}, settings.targetLang).then((nodes) => {
      const missed = nodes.filter((n) => !translatedNodes.has(n));
      if (missed.length) queueIncrementalNodes(missed);
    });
  }

  async function runConcurrent(batches, concurrency, onProgress, ctx) {
    const { textToNodes, uniqueTexts, totalNodes, isMt } = ctx;
    let completedNodes = 0;
    const failedBatches = [];
    const appliedUnique = new Set();

    function markApplied(uniqueIdx, translated) {
      if (!isValidTranslation(translated)) return 0;
      if (appliedUnique.has(uniqueIdx)) return 0;
      appliedUnique.add(uniqueIdx);
      const nodes = textToNodes.get(uniqueTexts[uniqueIdx]);
      if (!nodes) return 0;
      nodes.forEach((node) => applyTranslation(node, translated));
      return nodes.length;
    }

    function applyPartial(batch, segments) {
      let added = 0;
      for (const seg of segments) {
        const uniqueIdx = batch.globalIndices[seg.index];
        if (uniqueIdx === undefined) continue;
        added += markApplied(uniqueIdx, seg.text);
      }
      if (added) onProgress(completedNodes + added, batches.length, 0, failedBatches.length);
      completedNodes += added;
    }

    function applyBatchResult(batch, translations) {
      let added = 0;
      batch.globalIndices.forEach((uniqueIdx, i) => {
        added += markApplied(uniqueIdx, translations[i]);
      });
      completedNodes += added;
      return added;
    }

    async function processBatch(batch, batchIndex) {
      let heartbeatId = null;
      try {
        heartbeatId = startBatchHeartbeat(batchIndex, batches.length, () => {
          if (cancelRequested) return;
          showOverlay(
            getAryaPhrase(),
            Math.round((completedNodes / Math.max(totalNodes, 1)) * 100),
            currentLangHint
          );
        });

        let translations;
        if (isMt) {
          translations = await translateBatchStreaming(batch.texts, (segments) => {
            if (cancelRequested) return;
            applyPartial(batch, segments);
          });
        } else {
          translations = await translateBatchWithRetry(batch.texts);
        }

        if (heartbeatId) clearInterval(heartbeatId);
        if (cancelRequested) return;
        applyBatchResult(batch, translations);
        onProgress(completedNodes, batches.length, batchIndex, failedBatches.length);
      } catch (error) {
        if (heartbeatId) clearInterval(heartbeatId);
        if (error.cancelled || cancelRequested) return;
        failedBatches.push(batch);
        onProgress(completedNodes, batches.length, batchIndex, failedBatches.length);
      }
    }

    if (concurrency <= 1) {
      for (let i = 0; i < batches.length; i++) {
        if (cancelRequested) break;
        await processBatch(batches[i], i + 1);
      }
    } else {
      let index = 0;
      async function worker() {
        while (index < batches.length) {
          if (cancelRequested) return;
          const current = index++;
          await processBatch(batches[current], current + 1);
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(concurrency, batches.length) }, () => worker())
      );
    }

    return { completed: completedNodes, failedBatches };
  }

  async function retryFailedBatches(failedBatches, onProgress, ctx) {
    const { textToNodes, uniqueTexts, totalNodes, isMt } = ctx;
    let recoveredNodes = 0;
    const stillFailed = [];
    const appliedUnique = new Set();

    function markApplied(uniqueIdx, translated) {
      if (!isValidTranslation(translated)) return 0;
      if (appliedUnique.has(uniqueIdx)) return 0;
      appliedUnique.add(uniqueIdx);
      const nodes = textToNodes.get(uniqueTexts[uniqueIdx]);
      if (!nodes) return 0;
      nodes.forEach((node) => applyTranslation(node, translated));
      return nodes.length;
    }

    for (let i = 0; i < failedBatches.length; i++) {
      if (cancelRequested) break;
      const batch = failedBatches[i];
      try {
        await new Promise((r) => setTimeout(r, 3000));
        const translations = isMt
          ? await translateBatchStreaming(batch.texts, (segments) => {
              for (const seg of segments) {
                const uniqueIdx = batch.globalIndices[seg.index];
                if (uniqueIdx !== undefined) markApplied(uniqueIdx, seg.text);
              }
            })
          : await translateBatchWithRetry(batch.texts, 5);
        batch.globalIndices.forEach((uniqueIdx, idx) => {
          recoveredNodes += markApplied(uniqueIdx, translations[idx]);
        });
        onProgress(recoveredNodes, failedBatches.length, i + 1, stillFailed.length, totalNodes);
      } catch {
        stillFailed.push(batch);
      }
    }

    return { recovered: recoveredNodes, stillFailed };
  }

  async function translateSelection(message = {}) {
    if (isTranslating) return { success: false, error: '正在翻译中，请稍候' };

    hideSelectionBubble();

    const resolved = resolveSelectionRange(message);
    if (!resolved) {
      return { success: false, error: '未检测到选中文本，请先在页面上拖选文字' };
    }

    const { text: selectedText, range } = resolved;
    let segments;
    try {
      segments = extractRangeTextSegments(range);
    } catch {
      cachedSelection = null;
      return { success: false, error: '选中内容已变化，请重新选择后再试' };
    }

    if (!segments.length) {
      return { success: false, error: '选中区域没有可翻译的文本' };
    }

    isTranslating = true;
    cancelRequested = false;
    sessionId = String(Date.now());
    batchCounter = 0;
    resetSessionUsage();

    try {
      const settings = await getSettings();
      showOverlay(`Arya 正在翻译「${selectedText.slice(0, 24)}${selectedText.length > 24 ? '…' : ''}」`, 15);
      const result = await translateSelectionSegments(segments, settings);

      if (cancelRequested) {
        return { success: false, cancelled: true, error: '翻译已取消' };
      }

      const usage = formatUsageSuffix();
      showOverlay(`完成！已翻译选中内容${usage}`, 100);
      setTimeout(hideOverlay, 1800);
      cachedSelection = null;
      return {
        success: true,
        count: result.count,
        estimatedTokens: sessionUsage.estimatedTokens,
        inputChars: sessionUsage.inputChars
      };
    } catch (error) {
      hideOverlay();
      return { success: false, error: error.message };
    } finally {
      isTranslating = false;
      cancelRequested = false;
    }
  }

  async function translatePage() {
    if (isTranslating) return { success: false, error: '正在翻译中，请稍候' };

    hideSelectionBubble();

    stopWatchMode();
    isTranslating = true;
    cancelRequested = false;
    sessionId = String(Date.now());
    batchCounter = 0;
    resetSessionUsage();
    currentLangHint = '';

    try {
      const settings = await getSettings();
      const scannedNodes = await collectTextNodesAsync((msg) => {
        showOverlay(msg, 0);
      }, null);

      if (isTopFrame) {
        currentLangHint = buildLangHint(detectPageLanguage(scannedNodes), settings.targetLang);
      }

      const textNodes = scannedNodes.filter((node) => {
        const text = node.textContent.trim();
        return !likelyAlreadyTargetLanguage(text, settings.targetLang);
      });
      const attrItems = await collectAttrItemsAsync(settings.targetLang);
      if (textNodes.length === 0 && attrItems.length === 0) {
        return { success: false, error: '未找到需要翻译的文本（可能已是目标语言）' };
      }

      showOverlay(getAryaPhrase(), 0, currentLangHint);

      const result = await translateNodeList(textNodes, settings, { incremental: false });
      const attrResult = attrItems.length
        ? await translateAttrList(attrItems, settings)
        : { count: 0, failed: 0 };

      if (cancelRequested) {
        sessionId = null;
        return { success: false, cancelled: true, error: '翻译已取消' };
      }

      await sweepMissedNodes(settings);

      const missedAfterSweep = await collectMissedTextNodes();
      const successCount = result.count + attrResult.count;
      const failedNodeCount = result.failed + attrResult.failed;
      const stillMissed = missedAfterSweep.length;
      const usage = formatUsageSuffix();

      if (failedNodeCount > 0 || stillMissed > 0) {
        const totalAttempted = successCount + failedNodeCount + stillMissed;
        showOverlay(`完成！${successCount}/${totalAttempted} 段已翻译${usage}`, 100);
        setTimeout(hideOverlay, 1800);
        startWatchMode(settings);
        const parts = [];
        if (failedNodeCount > 0) parts.push(`${failedNodeCount} 段 API 限流`);
        if (stillMissed > 0) parts.push(`${stillMissed} 段将自动补译`);
        return {
          success: true,
          count: successCount,
          failed: failedNodeCount + stillMissed,
          estimatedTokens: sessionUsage.estimatedTokens,
          inputChars: sessionUsage.inputChars,
          warning: parts.length ? `${parts.join('，')}，稍后自动重试` : undefined
        };
      }

      showOverlay(`完成！Arya 已翻译 ${successCount} 段${usage}`, 100);
      setTimeout(hideOverlay, 1500);
      startWatchMode(settings);
      return {
        success: true,
        count: successCount,
        estimatedTokens: sessionUsage.estimatedTokens,
        inputChars: sessionUsage.inputChars
      };
    } catch (error) {
      stopWatchMode();
      sessionId = null;
      if (!cancelRequested) hideOverlay();
      return { success: false, error: error.message };
    } finally {
      isTranslating = false;
      cancelRequested = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'translate') {
      if (!shouldHandlePageTranslate()) {
        sendResponse({ success: true, skipped: true, count: 0 });
        return true;
      }
      translatePage().then(sendResponse);
      return true;
    }
    if (message.action === 'translateSelection') {
      translateSelection(message).then(sendResponse);
      return true;
    }
    if (message.action === 'cancel') {
      cancelTranslation();
      sendResponse({ success: true, cancelled: true });
      return true;
    }
    if (message.action === 'restore') {
      restoreOriginal();
      sendResponse({ success: true });
      return true;
    }
    if (message.action === 'getTranslating') {
      sendResponse({ isTranslating: isTranslating || isProcessingIncremental });
      return true;
    }
    if (message.action === 'getWatchMode') {
      sendResponse({ watchModeActive });
      return true;
    }
    return false;
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleAutoTranslate, { once: true });
  } else {
    scheduleAutoTranslate();
  }

  window.addEventListener('popstate', scheduleAutoTranslate);
  window.addEventListener('hashchange', scheduleAutoTranslate);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.autoTranslate?.newValue) return;
    scheduleAutoTranslate();
  });
})();
