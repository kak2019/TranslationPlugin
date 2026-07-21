(function () {
  // 防止 background 重复 executeScript 导致多个监听器、多个粉点
  if (window.__ARYA_TRANSLATE_CS__) return;
  window.__ARYA_TRANSLATE_CS__ = true;

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
  const NOISE_WINDOW_MS = 3000;
  const NOISE_HIT_THRESHOLD = 3;
  const NOISE_MUTE_MS = 8000;
  const SKIP_ANCESTOR_CLASSES = new Set(['sr-only', 'visually-hidden', 'notranslate']);
  const isTopFrame = window === window.top;
  const noisyParents = new WeakMap();

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
  let selectionBubbleTimer = null;
  let selectionPanelEl = null;
  let selectionPanelHideTimer = null;
  let selectionPreviewToken = 0;
  const selectionPreviewCache = new Map();
  let originalTooltipEl = null;
  let originalTooltipRaf = null;
  let lastTooltipNode = null;
  let floatBallEl = null;
  let floatBallExpanded = false;
  let inputFabEl = null;
  let inputFabTarget = null;
  let inputFabHideTimer = null;
  let uiFeatureFlags = {
    showFloatBall: true,
    showSelectionDot: true,
    showInputTranslate: true,
    bilingualMode: false,
    selectionDelayMs: 280,
    selectionMinLength: 4,
    translationTheme: 'underline'
  };
  const TRANSLATION_THEMES = new Set(['none', 'underline', 'weakening', 'blockquote']);
  let activeSkipSelectors = [];
  const bilingualElements = new WeakMap();
  let pageTranslationActive = false;

  const SITE_RULES_MAX = 50;

  function normalizeSiteRules(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
      const host = String(item?.host || '')
        .trim()
        .toLowerCase()
        .replace(/^\*\./, '')
        .replace(/^https?:\/\//, '')
        .split('/')[0];
      if (!host || seen.has(host)) continue;
      seen.add(host);
      const tri = (v) => (v === true || v === false ? v : null);
      out.push({
        host,
        bilingualMode: tri(item?.bilingualMode),
        watchMode: tri(item?.watchMode),
        autoTranslate: tri(item?.autoTranslate),
        skipSelectors: String(item?.skipSelectors || '').trim()
      });
      if (out.length >= SITE_RULES_MAX) break;
    }
    return out;
  }

  function matchSiteRule(hostname, rules) {
    if (!hostname || !rules?.length) return null;
    const host = String(hostname).toLowerCase();
    let best = null;
    let bestLen = -1;
    for (const rule of rules) {
      const h = rule.host;
      if (!h) continue;
      if (host === h || host.endsWith(`.${h}`)) {
        if (h.length > bestLen) {
          best = rule;
          bestLen = h.length;
        }
      }
    }
    return best;
  }

  function parseSkipSelectors(str) {
    if (!str || typeof str !== 'string') return [];
    return str.split(',').map((s) => s.trim()).filter(Boolean);
  }

  // 营销站常见「演示区 / 导航」跳过；与用户 siteRules.skipSelectors 合并
  const BUILTIN_SKIP_BY_HOST = {
    'cursor.com':
      'nav, header, footer, [role="navigation"], [role="banner"], [role="menubar"], [aria-hidden="true"]'
  };

  function getBuiltinSkipSelectors(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (!host) return [];
    for (const [key, selectors] of Object.entries(BUILTIN_SKIP_BY_HOST)) {
      if (host === key || host.endsWith(`.${key}`)) {
        return parseSkipSelectors(selectors);
      }
    }
    return [];
  }

  function applySiteRuleToSettings(settings, rule) {
    if (!rule) {
      return {
        ...settings,
        watchMode: null,
        skipSelectors: '',
        siteRule: null
      };
    }
    const next = { ...settings, siteRule: rule, skipSelectors: rule.skipSelectors || '' };
    if (rule.bilingualMode === true || rule.bilingualMode === false) {
      next.bilingualMode = rule.bilingualMode;
    }
    if (rule.autoTranslate === true || rule.autoTranslate === false) {
      next.autoTranslate = rule.autoTranslate;
    }
    next.watchMode = rule.watchMode === true || rule.watchMode === false ? rule.watchMode : null;
    return next;
  }

  function setPageTranslationActive(active) {
    pageTranslationActive = Boolean(active);
  }

  function isPageTranslationActive() {
    if (pageTranslationActive || watchModeActive) return true;
    try {
      return Boolean(document.querySelector(
        '.arya-bilingual, [data-arya-bilingual="1"], [data-arya-replaced="1"]'
      ));
    } catch {
      return pageTranslationActive;
    }
  }

  const TARGET_LANG_OPTIONS = [
    '简体中文', '繁体中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español'
  ];

  const SPEECH_LANG_MAP = {
    '简体中文': 'zh-CN',
    '繁体中文': 'zh-TW',
    English: 'en-US',
    日本語: 'ja-JP',
    한국어: 'ko-KR',
    Français: 'fr-FR',
    Deutsch: 'de-DE',
    Español: 'es-ES'
  };

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

  function textSkeleton(text) {
    return String(text).replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  }

  function isDigitSkeletonChange(oldText, newText) {
    if (oldText == null || newText == null) return false;
    const a = String(oldText).trim();
    const b = String(newText).trim();
    if (!a || !b) return false;
    if (!/\d/.test(a) && !/\d/.test(b)) return false;
    return textSkeleton(a) === textSkeleton(b);
  }

  function isLikelyNonTranslatable(text) {
    const t = text.trim();
    if (t.length < 2) return true;
    if (/^https?:\/\/\S+$/i.test(t)) return true;
    if (/^[\d\s.,:+\-/()%#]+$/.test(t)) return true;
    // 验证码倒计时短文案（避免误伤普通「验证码」说明）
    if (/^\d+\s*[秒sS]([后內内])?$/.test(t)) return true;
    if (t.length <= 30 && /^\d+\s*[秒sS]后/.test(t)) return true;
    if (t.length <= 24 && /^(重新(获取|发送)|再次发送|重发)/.test(t) && /\d/.test(t)) return true;
    if (t.length <= 28 && /^(resend|retry|send again)/i.test(t) && /\d/.test(t)) return true;
    if (t.length <= 20 && /^\d+\s*s\b/i.test(t)) return true;
    if (t.length <= 24 && /(重新(获取|发送)|重发)\s*[（(]\d+[）)]/.test(t)) return true;
    return false;
  }

  function isNoisyParent(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const info = noisyParents.get(el);
    return Boolean(info && Date.now() < info.mutedUntil);
  }

  function noteNoisyParent(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    const now = Date.now();
    let info = noisyParents.get(el);
    if (!info || now - info.windowStart > NOISE_WINDOW_MS) {
      info = { windowStart: now, hits: 0, mutedUntil: 0 };
    }
    info.hits += 1;
    if (info.hits >= NOISE_HIT_THRESHOLD) {
      info.mutedUntil = now + NOISE_MUTE_MS;
    }
    noisyParents.set(el, info);
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
    const minLen = Math.max(1, Number(uiFeatureFlags.selectionMinLength) || 4);
    if (!text || text.length < minLen) {
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
    return Boolean(
      el?.closest?.(
        '#arya-selection-bubble, #arya-selection-panel, #arya-float-ball, #arya-input-fab'
      )
    );
  }

  function hideSelectionPanel() {
    if (selectionPanelHideTimer) {
      clearTimeout(selectionPanelHideTimer);
      selectionPanelHideTimer = null;
    }
    if (selectionPanelEl) {
      selectionPanelEl.remove();
      selectionPanelEl = null;
    }
  }

  function hideSelectionBubble() {
    if (selectionBubbleTimer) {
      clearTimeout(selectionBubbleTimer);
      selectionBubbleTimer = null;
    }
    if (selectionBubbleRaf) {
      cancelAnimationFrame(selectionBubbleRaf);
      selectionBubbleRaf = null;
    }
    hideSelectionPanel();
    if (selectionBubbleEl) {
      selectionBubbleEl.remove();
      selectionBubbleEl = null;
    }
    // 清掉历史重复注入残留的粉点
    document.querySelectorAll('#arya-selection-bubble, .arya-selection-bubble').forEach((el) => {
      el.remove();
    });
  }

  function selectionBelongsToThisFrame(range) {
    try {
      const root = range?.commonAncestorContainer;
      if (!root) return false;
      const node = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
      return Boolean(node && document.documentElement.contains(node));
    } catch {
      return false;
    }
  }

  function guessSpeechLang(text, fallbackLang) {
    const { cjk, kana, hangul, latin, cyrillic, total } = scriptCounts(text);
    if (!total) return SPEECH_LANG_MAP[fallbackLang] || 'en-US';
    if (kana / total > 0.08) return 'ja-JP';
    if (hangul / total > 0.2) return 'ko-KR';
    if (cjk / total > 0.35) return 'zh-CN';
    if (cyrillic / total > 0.35) return 'ru-RU';
    if (latin / total > 0.4) return 'en-US';
    return SPEECH_LANG_MAP[fallbackLang] || 'en-US';
  }

  function speakText(text, langCode) {
    if (!text || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = langCode || 'en-US';
      utter.rate = 1;
      window.speechSynthesis.speak(utter);
    } catch {
      // 部分环境禁用语音合成
    }
  }

  function translatePreviewTexts(texts, targetLang) {
    const requestId = `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'translateBatch', texts, requestId, targetLang },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response?.success) {
            reject(new Error(response?.error || '翻译失败'));
            return;
          }
          resolve(response.translations || []);
        }
      );
    });
  }

  function resolveMutualTargetLang(text, preferredTarget) {
    const preferred = preferredTarget || '简体中文';
    if (likelyAlreadyTargetLanguage(text, preferred)) {
      if (preferred.includes('中文') || preferred.includes('chinese')) return 'English';
      if (preferred === 'English') return '简体中文';
      return '简体中文';
    }
    return preferred;
  }

  function hideOriginalTooltip() {
    lastTooltipNode = null;
    if (originalTooltipRaf) {
      cancelAnimationFrame(originalTooltipRaf);
      originalTooltipRaf = null;
    }
    if (originalTooltipEl) {
      originalTooltipEl.style.display = 'none';
    }
  }

  function ensureOriginalTooltip() {
    ensureOverlayStyles();
    if (originalTooltipEl) return originalTooltipEl;
    const tip = document.createElement('div');
    tip.id = 'arya-original-tooltip';
    tip.setAttribute('translate', 'no');
    document.documentElement.appendChild(tip);
    originalTooltipEl = tip;
    return tip;
  }

  function positionOriginalTooltip(tip, x, y) {
    const pad = 12;
    tip.style.display = 'block';
    const rect = tip.getBoundingClientRect();
    let left = x + 14;
    let top = y + 16;
    if (left + rect.width > window.innerWidth - pad) left = x - rect.width - 10;
    if (top + rect.height > window.innerHeight - pad) top = y - rect.height - 10;
    tip.style.left = `${Math.max(pad, left)}px`;
    tip.style.top = `${Math.max(pad, top)}px`;
  }

  function resolveTextNodeAtPoint(x, y) {
    try {
      if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(x, y);
        const node = range?.startContainer;
        return node?.nodeType === Node.TEXT_NODE ? node : null;
      }
      if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        const node = pos?.offsetNode;
        return node?.nodeType === Node.TEXT_NODE ? node : null;
      }
    } catch {
      // ignore
    }
    return null;
  }

  function getBilingualOriginalFromEl(el) {
    if (!el) return '';
    const wrap = el.closest?.('.arya-bilingual, [data-arya-bilingual="1"]') || (
      el.classList?.contains('arya-bilingual') ? el : null
    );
    if (!wrap) return '';
    return (wrap.getAttribute('data-arya-original') || '').trim();
  }

  /** 悬停原文提示：优先整段原文（双语 / 替换模式块），避免链接拆句后只显示末尾碎片 */
  function resolveOriginalForHover(clientX, clientY, target) {
    try {
      const hit = document.elementFromPoint(clientX, clientY) || target;
      const fromBi = getBilingualOriginalFromEl(hit);
      if (fromBi) return { original: fromBi, key: `bi:${fromBi.slice(0, 48)}` };
      const replaced = hit?.closest?.('[data-arya-original][data-arya-replaced="1"]');
      const replacedOriginal = (replaced?.getAttribute('data-arya-original') || '').trim();
      if (replacedOriginal) {
        return { original: replacedOriginal, key: `rep:${replacedOriginal.slice(0, 48)}` };
      }
    } catch {
      // ignore
    }

    const node = resolveTextNodeAtPoint(clientX, clientY);
    if (!node) return null;

    const host = findInteractiveHost(node);
    if (host) {
      const hostBi = bilingualElements.get(host);
      const hostOriginal = getBilingualOriginalFromEl(hostBi)
        || (hostBi?.getAttribute?.('data-arya-original') || '').trim()
        || (host.getAttribute?.('data-arya-original') || '').trim();
      if (hostOriginal) return { original: hostOriginal, key: `host:${hostOriginal.slice(0, 48)}` };
    }

    const block = findTranslationBlock(node);
    if (block) {
      const blockBi = bilingualElements.get(block);
      const blockOriginal = (blockBi?.getAttribute?.('data-arya-original') || '').trim()
        || (block.getAttribute?.('data-arya-original') || '').trim();
      if (blockOriginal) return { original: blockOriginal, key: `block:${blockOriginal.slice(0, 48)}` };
    }

    const sibBi = findBilingualElement(node);
    const sibOriginal = (sibBi?.getAttribute?.('data-arya-original') || '').trim();
    if (sibOriginal) return { original: sibOriginal, key: `sib:${sibOriginal.slice(0, 48)}` };

    if (!translatedNodes.has(node)) return null;
    const original = translatedNodes.get(node);
    if (original == null || !String(original).trim() || original === node.textContent) return null;
    return { original: String(original), key: node };
  }

  function onOriginalTooltipMove(e) {
    if (originalTooltipRaf) return;
    const { clientX, clientY, target } = e;
    originalTooltipRaf = requestAnimationFrame(() => {
      originalTooltipRaf = null;
      // 双语译文本身要能提示原文；其它插件 UI 仍忽略
      const onBilingual = Boolean(target?.closest?.('.arya-bilingual, [data-arya-bilingual="1"]'));
      if (!onBilingual && isOurOverlayElement(target)) {
        hideOriginalTooltip();
        return;
      }
      const resolved = resolveOriginalForHover(clientX, clientY, target);
      if (!resolved?.original) {
        if (lastTooltipNode) hideOriginalTooltip();
        return;
      }
      const tip = ensureOriginalTooltip();
      if (lastTooltipNode !== resolved.key) {
        tip.textContent = resolved.original;
        lastTooltipNode = resolved.key;
      }
      positionOriginalTooltip(tip, clientX, clientY);
    });
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

  function getActiveSelectionSnapshot() {
    const sel = window.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return null;
    const text = sel.toString().trim();
    const minLen = Math.max(1, Number(uiFeatureFlags.selectionMinLength) || 4);
    if (!text || text.length < minLen || isLikelyNonTranslatable(text)) return null;
    try {
      const range = sel.getRangeAt(0);
      if (!selectionBelongsToThisFrame(range)) return null;
      return {
        text,
        range: range.cloneRange(),
        allowApply: !isSelectionInEditableContext(range)
      };
    } catch {
      return null;
    }
  }

  function pickSelectionAnchorRect(range) {
    const clientRects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
    if (!clientRects.length) {
      const fallback = range.getBoundingClientRect();
      return fallback?.width || fallback?.height ? fallback : null;
    }
    // 多行选区：粉点用末尾，避免飞到选区大框右上角；超长时略往中间靠，减少盖住下一条标题
    if (clientRects.length >= 6) {
      return clientRects[Math.floor(clientRects.length * 0.7)];
    }
    return clientRects[clientRects.length - 1];
  }

  function scheduleSelectionBubble() {
    if (selectionBubbleRaf) {
      cancelAnimationFrame(selectionBubbleRaf);
      selectionBubbleRaf = null;
    }
    if (selectionBubbleTimer) {
      clearTimeout(selectionBubbleTimer);
      selectionBubbleTimer = null;
    }
    // 已有粉点时（如滚动跟随 / 选区变化）立即重定位；新选区则短延迟再出点
    const delay = selectionBubbleEl
      ? 0
      : Math.max(0, Number(uiFeatureFlags.selectionDelayMs) || 280);
    selectionBubbleTimer = setTimeout(() => {
      selectionBubbleTimer = null;
      selectionBubbleRaf = requestAnimationFrame(() => {
        selectionBubbleRaf = null;
        showSelectionBubble();
      });
    }, delay);
  }

  function onSelectionScroll() {
    const snap = getActiveSelectionSnapshot();
    if (!snap) {
      hideSelectionBubble();
      return;
    }
    cachedSelection = { text: snap.text, range: snap.range };
    scheduleSelectionBubble();
  }

  function positionSelectionPanel(panel, anchorRect) {
    const pad = 8;
    const panelW = Math.min(320, window.innerWidth - 24);
    let left = anchorRect.right + 10;
    let top = anchorRect.top - 4;
    if (left + panelW > window.innerWidth - pad) {
      left = Math.max(pad, anchorRect.left - panelW - 10);
    }
    panel.style.width = `${panelW}px`;
    panel.style.left = `${left}px`;
    panel.style.top = `${Math.min(Math.max(top, pad), window.innerHeight - 120)}px`;
  }

  function ensureSelectionPanel() {
    if (selectionPanelEl) return selectionPanelEl;
    ensureOverlayStyles();
    const panel = document.createElement('div');
    panel.id = 'arya-selection-panel';
    panel.innerHTML = `
      <div class="arya-sel-status">翻译中…</div>
      <div class="arya-sel-text"></div>
      <div class="arya-sel-actions">
        <button type="button" class="arya-sel-btn" data-action="speak-src" title="朗读原文">🔊 原文</button>
        <button type="button" class="arya-sel-btn" data-action="speak-dst" title="朗读译文">🔊 译文</button>
        <button type="button" class="arya-sel-btn primary" data-action="apply" title="替换页面中的选中文本">译入页面</button>
      </div>
    `;
    panel.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    panel.addEventListener('mouseenter', () => {
      if (selectionPanelHideTimer) {
        clearTimeout(selectionPanelHideTimer);
        selectionPanelHideTimer = null;
      }
    });
    panel.addEventListener('mouseleave', () => {
      scheduleHideSelectionPanel();
    });
    document.documentElement.appendChild(panel);
    selectionPanelEl = panel;
    return panel;
  }

  function scheduleHideSelectionPanel() {
    if (selectionPanelHideTimer) clearTimeout(selectionPanelHideTimer);
    selectionPanelHideTimer = setTimeout(() => {
      hideSelectionPanel();
    }, 220);
  }

  async function showSelectionPreviewPanel(sourceText, anchorRect, allowApply) {
    const settings = await getSettings();
    const panel = ensureSelectionPanel();
    const statusEl = panel.querySelector('.arya-sel-status');
    const textEl = panel.querySelector('.arya-sel-text');
    const applyBtn = panel.querySelector('[data-action="apply"]');
    applyBtn.style.display = allowApply ? '' : 'none';
    positionSelectionPanel(panel, anchorRect);
    panel.style.display = 'block';

    const cacheKey = `${settings.targetLang}::${sourceText}`;
    const token = ++selectionPreviewToken;
    let translation = selectionPreviewCache.get(cacheKey) || '';

    statusEl.textContent = translation ? '译文' : '翻译中…';
    textEl.textContent = translation || '';

    const bindActions = (finalText) => {
      panel.querySelector('[data-action="speak-src"]').onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        speakText(sourceText, guessSpeechLang(sourceText, settings.targetLang));
      };
      panel.querySelector('[data-action="speak-dst"]').onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!finalText) return;
        speakText(finalText, SPEECH_LANG_MAP[settings.targetLang] || 'zh-CN');
      };
      applyBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 译入页面与预览用同一段原文，避免选区已变却仍显示旧译文
        try {
          const live = getActiveSelectionSnapshot();
          if (live) {
            cachedSelection = { text: live.text, range: live.range };
          } else if (sourceText) {
            cachedSelection = {
              text: sourceText,
              range: cachedSelection?.range || null
            };
          }
        } catch {
          // ignore
        }
        hideSelectionBubble();
        translateSelection({ selectionText: sourceText }).then((result) => {
          if (result?.success) {
            showOverlay(`完成！已翻译选中内容${formatUsageSuffix()}`, 100);
            setTimeout(hideOverlay, 1800);
          } else if (result?.error && !result?.cancelled) {
            showOverlay(result.error, 0);
            setTimeout(hideOverlay, 2200);
          }
        });
      };
    };

    bindActions(translation);

    if (translation) return;

    try {
      const [result] = await translatePreviewTexts([sourceText], settings.targetLang);
      if (token !== selectionPreviewToken || !selectionPanelEl) return;
      translation = (result || '').trim();
      if (!translation) throw new Error('未返回译文');
      selectionPreviewCache.set(cacheKey, translation);
      if (selectionPreviewCache.size > 80) {
        const first = selectionPreviewCache.keys().next().value;
        selectionPreviewCache.delete(first);
      }
      statusEl.textContent = '译文';
      textEl.textContent = translation;
      bindActions(translation);
    } catch (error) {
      if (token !== selectionPreviewToken || !selectionPanelEl) return;
      statusEl.textContent = '翻译失败';
      textEl.textContent = error.message || '请稍后重试';
    }
  }

  function showSelectionBubble(options = {}) {
    if (!uiFeatureFlags.showSelectionDot) {
      hideSelectionBubble();
      return;
    }

    const snap = getActiveSelectionSnapshot();
    if (!snap) {
      hideSelectionBubble();
      return;
    }

    const { text, range, allowApply } = snap;
    cachedSelection = { text, range: range.cloneRange() };

    ensureOverlayStyles();
    // 只卸 DOM，保留即将打开的预览意图；避免 hide 清掉一切后再丢 openPreview
    if (selectionBubbleTimer) {
      clearTimeout(selectionBubbleTimer);
      selectionBubbleTimer = null;
    }
    if (selectionBubbleRaf) {
      cancelAnimationFrame(selectionBubbleRaf);
      selectionBubbleRaf = null;
    }
    if (!options.keepPanel) hideSelectionPanel();
    if (selectionBubbleEl) {
      selectionBubbleEl.remove();
      selectionBubbleEl = null;
    }
    document.querySelectorAll('#arya-selection-bubble, .arya-selection-bubble').forEach((el) => {
      el.remove();
    });

    const rect = pickSelectionAnchorRect(range);
    if (!rect || (!rect.width && !rect.height)) {
      hideSelectionBubble();
      return;
    }

    const bubble = document.createElement('div');
    bubble.id = 'arya-selection-bubble';
    bubble.className = 'arya-selection-bubble';
    bubble.dataset.aryaSelText = text;
    bubble.innerHTML = '<button type="button" class="arya-sel-dot" title="悬停查看译文" aria-label="翻译预览"></button>';

    const left = Math.min(Math.max(rect.right + 4, 8), window.innerWidth - 22);
    const top = Math.min(Math.max(rect.top + Math.min(rect.height, 22) / 2 - 7, 8), window.innerHeight - 22);
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;

    const dot = bubble.querySelector('.arya-sel-dot');
    const openPanel = () => {
      if (selectionPanelHideTimer) {
        clearTimeout(selectionPanelHideTimer);
        selectionPanelHideTimer = null;
      }
      const live = getActiveSelectionSnapshot();
      if (!live) {
        hideSelectionBubble();
        return;
      }
      const bound = bubble.dataset.aryaSelText || '';
      // 高亮已变、粉点仍是旧文案：先按新选区重建再预览
      if (live.text !== bound) {
        cachedSelection = { text: live.text, range: live.range };
        showSelectionBubble({ openPreview: true });
        return;
      }
      cachedSelection = { text: live.text, range: live.range };
      const dotRect = dot.getBoundingClientRect();
      showSelectionPreviewPanel(live.text, dotRect, live.allowApply);
    };

    dot.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    dot.addEventListener('mouseenter', openPanel);
    dot.addEventListener('mouseleave', () => {
      scheduleHideSelectionPanel();
    });
    dot.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPanel();
    });

    document.documentElement.appendChild(bubble);
    selectionBubbleEl = bubble;

    if (options.openPreview) {
      requestAnimationFrame(() => {
        if (selectionBubbleEl === bubble) openPanel();
      });
    }
  }

  document.addEventListener('mouseup', updateCachedSelection, true);
  document.addEventListener('keyup', updateCachedSelection, true);
  document.addEventListener('scroll', onSelectionScroll, true);
  document.addEventListener('mousemove', onOriginalTooltipMove, true);
  document.addEventListener('scroll', hideOriginalTooltip, true);
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
      || el?.id === 'arya-original-tooltip'
      || el?.id === 'arya-float-ball'
      || el?.id === 'arya-input-fab'
      || el?.id === 'arya-selection-panel'
      || Boolean(el?.classList?.contains('arya-bilingual'))
      || Boolean(el?.closest?.('#bailian-translate-overlay'))
      || Boolean(el?.closest?.('#arya-original-tooltip'))
      || Boolean(el?.closest?.('#arya-float-ball'))
      || Boolean(el?.closest?.('#arya-input-fab'))
      || Boolean(el?.closest?.('#arya-selection-panel'))
      || Boolean(el?.closest?.('.arya-bilingual'))
      || isOurBubbleElement(el);
  }

  function isBilingualMode() {
    if (activeSettings && typeof activeSettings.bilingualMode === 'boolean') {
      return activeSettings.bilingualMode;
    }
    return Boolean(uiFeatureFlags.bilingualMode);
  }

  function getTranslationTheme() {
    const raw = activeSettings?.translationTheme || uiFeatureFlags.translationTheme || 'underline';
    return TRANSLATION_THEMES.has(raw) ? raw : 'underline';
  }

  function setAryaDualState(on) {
    if (on) document.documentElement.setAttribute('data-arya-state', 'dual');
    else document.documentElement.removeAttribute('data-arya-state');
  }

  function isBilingualBreak(el) {
    return Boolean(
      el?.nodeType === Node.ELEMENT_NODE
      && (el.classList?.contains('arya-bilingual-break') || el.getAttribute?.('data-arya-bilingual-break') === '1')
    );
  }

  function isBilingualSpacerText(node) {
    return node?.nodeType === Node.TEXT_NODE
      && Boolean(node.textContent)
      && !node.textContent.replace(/[\u00A0\s]/g, '');
  }

  function removeBilingualArtifactsBefore(el) {
    if (!el) return;
    let prev = el.previousSibling;
    while (prev) {
      if (isBilingualBreak(prev) || isBilingualSpacerText(prev)) {
        const toRemove = prev;
        prev = prev.previousSibling;
        toRemove.remove();
        continue;
      }
      break;
    }
  }

  function createBilingualElement(translated, placement, extras = {}) {
    ensureOverlayStyles();
    setAryaDualState(true);
    const theme = getTranslationTheme();
    const place = placement === 'inline' ? 'inline' : 'block';
    const wrapper = document.createElement('span');
    wrapper.className = [
      'notranslate',
      'arya-bilingual',
      'arya-bilingual-wrapper',
      `arya-bilingual-${place}`,
      `arya-bilingual-theme-${theme}`,
      `arya-bilingual-${place}-theme-${theme}`
    ].join(' ');
    wrapper.setAttribute('translate', 'no');
    wrapper.setAttribute('data-arya-bilingual', '1');
    if (extras.host) wrapper.setAttribute('data-arya-host', '1');
    if (extras.block) wrapper.setAttribute('data-arya-block', '1');
    const original = String(extras.original || '').trim();
    if (original) wrapper.setAttribute('data-arya-original', original);
    const targetLang = activeSettings?.targetLang || '';
    const lang = SPEECH_LANG_MAP[targetLang];
    if (lang) wrapper.setAttribute('lang', lang);

    const inner = document.createElement('span');
    inner.className = `notranslate arya-bilingual-inner arya-bilingual-theme-${theme}-inner`;
    inner.setAttribute('translate', 'no');
    inner.setAttribute('data-arya-bilingual-inner', '1');
    inner.textContent = translated;
    wrapper.appendChild(inner);
    return wrapper;
  }

  function isFragileInsertParent(parent) {
    if (!parent || parent.nodeType !== Node.ELEMENT_NODE) return false;
    if (/^(A|BUTTON|SUMMARY|LABEL|H1|H2|H3|H4|H5|H6)$/i.test(parent.tagName)) return true;
    try {
      const st = window.getComputedStyle(parent);
      const display = st.display || '';
      if (display.includes('flex') || display.includes('grid')) return true;
      if (st.position === 'absolute' || st.position === 'fixed') return true;
    } catch {
      // ignore
    }
    return false;
  }

  function findSafeBilingualMount(referenceNode) {
    let after = referenceNode?.nodeType === Node.ELEMENT_NODE
      ? referenceNode
      : referenceNode?.parentElement;
    if (!after) {
      return { parent: document.body, after: null };
    }
    for (let i = 0; i < 8 && after && after !== document.body; i++) {
      const parent = after.parentElement;
      if (!parent || parent === document.documentElement) break;
      if (!isFragileInsertParent(parent)) {
        return { parent, after };
      }
      after = parent;
    }
    const parent = after?.parentElement || document.body;
    return { parent, after: after || null };
  }

  function insertBilingualAfter(parent, referenceNode, el, placement) {
    if (!parent || !el) return;
    const frag = document.createDocumentFragment();
    const fragile = isFragileInsertParent(parent);
    if (placement === 'block') {
      if (!fragile) {
        const br = document.createElement('br');
        br.className = 'arya-bilingual-break';
        br.setAttribute('data-arya-bilingual-break', '1');
        frag.appendChild(br);
      } else {
        // flex/grid/按钮内禁止 <br>，改用整行块级，避免撑乱
        el.classList.add('arya-bilingual-block-soft');
      }
    } else {
      frag.appendChild(document.createTextNode('\u00A0\u00A0'));
    }
    frag.appendChild(el);
    if (referenceNode && referenceNode.parentNode === parent) {
      if (referenceNode.nextSibling) parent.insertBefore(frag, referenceNode.nextSibling);
      else parent.appendChild(frag);
    } else {
      parent.appendChild(frag);
    }
  }

  /** 块级译文：必要时上移到非 flex/grid 父级再插入 */
  function mountBilingualNear(referenceNode, el, placement) {
    let parent = referenceNode?.parentNode;
    let after = referenceNode;
    if (placement === 'block' && (!parent || isFragileInsertParent(parent))) {
      const safe = findSafeBilingualMount(referenceNode);
      parent = safe.parent;
      after = safe.after;
    }
    if (!parent) parent = document.body;
    insertBilingualAfter(parent, after, el, placement);
    return { parent, after };
  }

  function findBilingualElement(node) {
    const cached = bilingualElements.get(node);
    if (cached?.isConnected) return cached;
    let sib = node?.nextSibling;
    while (sib) {
      if (sib.nodeType === Node.ELEMENT_NODE) {
        if (isBilingualBreak(sib)) {
          sib = sib.nextSibling;
          continue;
        }
        if (sib.classList?.contains('arya-bilingual')) {
          bilingualElements.set(node, sib);
          return sib;
        }
        return null;
      }
      if (sib.nodeType === Node.TEXT_NODE) {
        if (isBilingualSpacerText(sib)) {
          sib = sib.nextSibling;
          continue;
        }
        if (sib.textContent.trim()) return null;
        sib = sib.nextSibling;
        continue;
      }
      sib = sib.nextSibling;
    }
    return null;
  }

  function removeBilingualElement(node) {
    const el = findBilingualElement(node);
    if (!el) return;
    isApplyingTranslation = true;
    try {
      removeBilingualArtifactsBefore(el);
      el.remove();
    } finally {
      isApplyingTranslation = false;
    }
    bilingualElements.delete(node);
  }

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (isOurOverlayElement(el)) return true;
    if (el.getAttribute('translate') === 'no') return true;
    for (const cls of el.classList || []) {
      if (SKIP_ANCESTOR_CLASSES.has(cls)) return true;
    }
    for (const sel of activeSkipSelectors) {
      try {
        if (el.matches(sel) || el.closest(sel)) return true;
      } catch {
        // invalid selector — ignore
      }
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
      const visibleText = getHostVisibleText(el).toLowerCase();
      for (const attr of attrsForElement(el)) {
        const val = el.getAttribute(attr);
        if (!val || val.trim().length < 2) continue;
        if (isAttrAlreadyTranslated(el, attr)) continue;
        const text = val.trim();
        // 与可见文案重复的 title/aria-label 不再单独翻译，避免同义双份
        if (
          (attr === 'title' || attr === 'aria-label')
          && visibleText
          && (visibleText === text.toLowerCase()
            || visibleText.includes(text.toLowerCase())
            || text.toLowerCase().includes(visibleText))
        ) {
          continue;
        }
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
    if (findBilingualElement(node)) return true;
    const host = findInteractiveHost(node);
    if (host && bilingualElements.get(host)?.isConnected) return true;
    const block = findTranslationBlock(node);
    if (block && bilingualElements.get(block)?.isConnected) return true;
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

  async function translateSelectionSegments(segments, settings, fullText = '') {
    const joined = String(fullText || segments.map((s) => s.text).join(' ')).replace(/\s+/g, ' ').trim();
    // 与粉点预览一致：多段（行内链接拆开）时整段一次翻译再写回
    if (segments.length > 1 && joined) {
      const translations = settings.isMt
        ? await translateBatchStreaming([joined])
        : await translateBatchWithRetry([joined]);
      const translated = translations?.[0];
      if (!isValidTranslation(translated)) return { count: 0 };
      applyReplaceFragmentTranslation(
        segments.map((s) => s.node),
        translated,
        joined
      );
      return { count: 1 };
    }

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
    const preferred = message.selectionText?.trim();
    const sel = window.getSelection();
    const liveText = sel?.toString()?.trim();

    // 划词预览「译入页面」传入的原文优先，避免选区已变却译了别的
    if (preferred && cachedSelection?.range) {
      try {
        const range = cachedSelection.range.cloneRange();
        return { text: preferred, range };
      } catch {
        cachedSelection = null;
      }
    }

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
        const text = preferred || cachedSelection.text || range.toString().trim();
        if (text) return { text, range };
      } catch {
        cachedSelection = null;
      }
    }

    return null;
  }

  function ensureOverlayStyles() {
    const STYLE_VERSION = '18';
    let style = document.getElementById('bailian-translate-styles');
    if (style?.dataset?.version === STYLE_VERSION) return;
    if (!style) {
      style = document.createElement('style');
    style.id = 'bailian-translate-styles';
      document.head.appendChild(style);
    }
    style.dataset.version = STYLE_VERSION;
    style.textContent = `
      #bailian-translate-overlay {
        position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif;
        pointer-events: none;
      }
      .bailian-overlay-card {
        pointer-events: auto;
        background: rgba(255,255,255,0.98); border-radius: 16px; padding: 12px 14px;
        min-width: 210px; max-width: 280px;
        box-shadow: 0 10px 30px rgba(15,23,42,0.10), 0 1px 3px rgba(244,114,182,0.12);
        border: 1px solid rgba(251, 207, 232, 0.7);
      }
      .bailian-overlay-header {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        margin-bottom: 6px;
      }
      .bailian-overlay-title {
        font-size: 13px; font-weight: 700; letter-spacing: 0.2px; color: #e11d48;
      }
      .bailian-overlay-close {
        border: none; background: #fff1f2; color: #fb7185; width: 22px; height: 22px;
        border-radius: 50%; font-size: 14px; line-height: 1; cursor: pointer;
      }
      .bailian-overlay-close:hover { background: #ffe4e6; color: #e11d48; }
      .bailian-overlay-message { font-size: 11px; color: #64748b; margin-bottom: 8px; line-height: 1.5; }
      .bailian-overlay-lang {
        font-size: 10px; color: #f43f5e; font-weight: 600; margin-bottom: 4px;
      }
      .bailian-overlay-status { font-size: 11px; color: #475569; line-height: 1.5; }
      .bailian-overlay-bar { height: 3px; background: #ffe4e6; border-radius: 99px; overflow: hidden; }
      .bailian-overlay-fill { height: 100%; background: linear-gradient(90deg, #fb7185, #f43f5e); width: 0%; transition: width 0.3s; }
      #arya-selection-bubble {
        position: fixed; z-index: 2147483646;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        pointer-events: auto;
      }
      #arya-selection-bubble .arya-sel-dot {
        border: none; cursor: pointer; padding: 0;
        width: 12px; height: 12px; border-radius: 50%;
        background: #f9a8b4;
        box-shadow: 0 0 0 2px #fff, 0 2px 8px rgba(249,168,180,0.55);
        transition: transform 0.12s, box-shadow 0.12s;
      }
      #arya-selection-bubble .arya-sel-dot:hover {
        transform: scale(1.2);
        background: #f4729b;
        box-shadow: 0 0 0 2px #fff, 0 3px 10px rgba(244,114,155,0.5);
      }
      #arya-selection-panel {
        position: fixed; z-index: 2147483647; display: none;
        background: #fff;
        border: 1px solid #fce7f3;
        border-radius: 14px; padding: 12px 14px;
        box-shadow: 0 12px 32px rgba(15,23,42,0.12);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        color: #1f2937;
      }
      #arya-selection-panel .arya-sel-status {
        font-size: 11px; color: #f43f5e; font-weight: 600; margin-bottom: 6px;
      }
      #arya-selection-panel .arya-sel-text {
        font-size: 13px; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
        max-height: 180px; overflow: auto; margin-bottom: 10px; min-height: 1.2em; color: #334155;
      }
      #arya-selection-panel .arya-sel-actions { display: flex; flex-wrap: wrap; gap: 6px; }
      #arya-selection-panel .arya-sel-btn {
        border: 1px solid #f1f5f9; background: #f8fafc; color: #475569;
        border-radius: 999px; padding: 5px 10px; font-size: 11px; cursor: pointer;
      }
      #arya-selection-panel .arya-sel-btn:hover { border-color: #fda4af; color: #e11d48; background: #fff1f2; }
      #arya-selection-panel .arya-sel-btn.primary {
        background: #f43f5e; border-color: transparent; color: #fff;
      }
      #arya-original-tooltip {
        position: fixed; z-index: 2147483647;
        max-width: min(360px, calc(100vw - 24px));
        padding: 8px 10px; border-radius: 10px;
        background: rgba(15, 23, 42, 0.92); color: #f8fafc;
        font-size: 12px; line-height: 1.45; font-weight: 500;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        box-shadow: 0 8px 24px rgba(0,0,0,0.2);
        pointer-events: none; display: none;
        white-space: pre-wrap; word-break: break-word;
      }
      #arya-float-ball {
        position: fixed; right: 0; top: 50%; transform: translateY(-50%);
        z-index: 2147483645;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif;
        display: flex; flex-direction: row-reverse; align-items: center; gap: 10px;
      }
      #arya-float-ball .arya-fb-main {
        display: flex; align-items: center; justify-content: center;
        width: 46px; height: 44px; margin: 0; padding: 0 4px 0 8px;
        border: 1px solid rgba(15,23,42,0.06); border-right: none;
        border-radius: 22px 0 0 22px; cursor: pointer;
        background: #fff;
        box-shadow: -4px 2px 16px rgba(15,23,42,0.08);
        transition: background 0.15s, box-shadow 0.15s;
      }
      #arya-float-ball .arya-fb-main:hover {
        background: #fffafb;
        box-shadow: -4px 2px 16px rgba(244,114,182,0.16);
      }
      #arya-float-ball .arya-fb-icon {
        position: relative;
        width: 30px; height: 30px; border-radius: 50%;
        display: inline-flex; align-items: center; justify-content: center;
        background: linear-gradient(145deg, #fda4af 0%, #f4729b 55%, #fb7185 100%);
        color: #fff; font-size: 13px; font-weight: 800; letter-spacing: -0.3px;
        box-shadow: 0 2px 8px rgba(244,114,155,0.35);
      }
      #arya-float-ball .arya-fb-icon::before,
      #arya-float-ball .arya-fb-icon::after {
        position: absolute; color: #fff; line-height: 1; pointer-events: none;
      }
      #arya-float-ball .arya-fb-icon::before {
        content: '✦'; top: 2px; left: 3px; font-size: 7px; opacity: 0.95;
      }
      #arya-float-ball .arya-fb-icon::after {
        content: '✧'; bottom: 3px; right: 3px; font-size: 6px; opacity: 0.85;
      }
      #arya-float-ball .arya-fb-panel {
        display: none; width: 216px; padding: 14px;
        background: #fff; border-radius: 18px;
        border: 1px solid #fce7f3;
        box-shadow: 0 16px 40px rgba(15,23,42,0.12);
      }
      #arya-float-ball.expanded .arya-fb-panel { display: block; }
      #arya-float-ball .arya-fb-title {
        display: flex; align-items: center; gap: 8px;
        font-size: 14px; font-weight: 700; color: #e11d48; margin-bottom: 12px;
      }
      #arya-float-ball .arya-fb-title-dot {
        width: 18px; height: 18px; border-radius: 50%;
        background: linear-gradient(145deg, #fda4af, #f4729b);
        box-shadow: 0 1px 4px rgba(244,114,155,0.35);
        flex-shrink: 0;
      }
      #arya-float-ball .arya-fb-label {
        display: block; font-size: 11px; color: #94a3b8; margin-bottom: 6px; font-weight: 500;
      }
      #arya-float-ball select {
        width: 100%; margin-bottom: 10px; padding: 9px 10px; border-radius: 12px;
        border: 1px solid #f1f5f9; font-size: 13px; background: #f8fafc; color: #0f172a;
        outline: none;
      }
      #arya-float-ball select:focus {
        border-color: #fda4af; background: #fff; box-shadow: 0 0 0 3px rgba(253,164,175,0.25);
      }
      #arya-float-ball .arya-fb-actions { display: grid; gap: 8px; }
      #arya-float-ball .arya-fb-btn {
        border: none; border-radius: 12px; padding: 10px 12px; font-size: 13px;
        font-weight: 650; cursor: pointer; transition: transform 0.1s, opacity 0.15s;
      }
      #arya-float-ball .arya-fb-btn:active { transform: scale(0.98); }
      #arya-float-ball .arya-fb-btn.translate {
        background: #f43f5e; color: #fff;
        box-shadow: 0 6px 14px rgba(244,63,94,0.28);
      }
      #arya-float-ball .arya-fb-btn.translate:hover { background: #e11d48; }
      #arya-float-ball .arya-fb-btn.restore {
        background: #fff1f2; color: #be123c; border: 1px solid #fecdd3;
      }
      #arya-float-ball .arya-fb-btn.cancel { background: #fff; color: #dc2626; border: 1px solid #fecaca; display: none; }
      #arya-float-ball.translating .arya-fb-btn.cancel { display: block; }
      #arya-float-ball.translating .arya-fb-btn.translate { display: none; }
      #arya-float-ball .arya-fb-toggle {
        display: flex; align-items: center; gap: 8px;
        margin: 0 0 12px; padding: 10px 12px; border-radius: 12px;
        background: #fff1f2; border: 1px solid #ffe4e6;
        cursor: pointer; user-select: none;
      }
      #arya-float-ball .arya-fb-toggle input {
        width: 15px; height: 15px; accent-color: #f43f5e; cursor: pointer;
      }
      #arya-float-ball .arya-fb-toggle span {
        font-size: 12px; font-weight: 600; color: #be123c;
      }
      #arya-float-ball .arya-fb-links {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        margin-top: 10px;
      }
      #arya-float-ball .arya-fb-donate {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        margin-top: 12px; padding: 9px 10px; border-radius: 12px;
        background: #fff7ed; border: 1px solid #ffedd5;
      }
      #arya-float-ball .arya-fb-donate-text {
        flex: 1; min-width: 0; font-size: 11px; font-weight: 600; color: #9a3412; line-height: 1.35;
      }
      #arya-float-ball .arya-fb-link {
        appearance: none; background: none; border: none; padding: 0; margin: 0;
        font-size: 12px; font-weight: 600; color: #e11d48; cursor: pointer;
        text-decoration: none; font-family: inherit;
      }
      #arya-float-ball .arya-fb-link:hover { color: #be123c; text-decoration: underline; }
      #arya-float-ball .arya-fb-link.settings { padding-left: 10px; }
      #arya-float-ball .arya-fb-link.donate { color: #ea580c; flex-shrink: 0; }
      #arya-float-ball .arya-fb-link.donate:hover { color: #c2410c; }
      :root {
        --arya-theme-underline: #fb7185;
        --arya-theme-blockquote: #f43f5e;
      }
      .arya-bilingual-break {
        display: block !important;
        content: "" !important;
      }
      .arya-bilingual-wrapper {
        font-feature-settings: normal !important;
        max-width: 100% !important;
        min-width: 0 !important;
        box-sizing: border-box !important;
        overflow-wrap: anywhere !important;
        word-break: break-word !important;
      }
      .arya-bilingual-inner {
        color: inherit !important;
        font: inherit !important;
        font-size: inherit !important;
        font-weight: inherit !important;
        line-height: inherit !important;
        word-break: break-word !important;
        overflow-wrap: anywhere !important;
        max-width: 100% !important;
      }
      [data-arya-state="dual"] .arya-bilingual-inline {
        display: inline !important;
        margin: 0 !important;
        padding: 0 !important;
        border: none !important;
        vertical-align: baseline !important;
        white-space: normal !important;
        max-width: 100% !important;
      }
      [data-arya-state="dual"] .arya-bilingual-block {
        display: block !important;
        margin: 8px 0 !important;
        padding: 0 !important;
        border: none !important;
        width: auto !important;
        max-width: 100% !important;
        min-width: 0 !important;
        box-sizing: border-box !important;
        white-space: normal !important;
        overflow-wrap: anywhere !important;
        word-break: break-word !important;
      }
      [data-arya-state="dual"] .arya-bilingual-block.arya-bilingual-block-soft {
        display: block !important;
        margin: 6px 0 0 !important;
        width: auto !important;
        max-width: 100% !important;
      }
      [data-arya-state="dual"] .arya-bilingual-theme-underline-inner {
        border-bottom: 1px solid var(--arya-theme-underline) !important;
      }
      [data-arya-state="dual"] .arya-bilingual-theme-weakening,
      [data-arya-state="dual"] .arya-bilingual-theme-weakening-inner {
        opacity: 0.618 !important;
      }
      [data-arya-state="dual"] .arya-bilingual-block-theme-blockquote {
        border-left: 4px solid var(--arya-theme-blockquote) !important;
        padding-left: 12px !important;
        display: block !important;
        max-width: 100% !important;
        box-sizing: border-box !important;
      }
      [data-arya-expand="1"] {
        height: auto !important;
        max-height: none !important;
        min-height: 0 !important;
        min-width: 0 !important;
        max-width: 100% !important;
        overflow-x: clip !important;
        overflow-y: visible !important;
        -webkit-line-clamp: unset !important;
        line-clamp: unset !important;
        text-overflow: clip !important;
        white-space: normal !important;
      }
      [data-arya-expand-scroll="1"] {
        height: auto !important;
        max-height: none !important;
        min-width: 0 !important;
        -webkit-line-clamp: unset !important;
        line-clamp: unset !important;
      }
      /* 双栏文档站：避免译文把整页撑出横向滚动条 */
      [data-arya-state="dual"] body {
        overflow-x: clip !important;
      }
      #arya-input-fab {
        position: fixed; z-index: 2147483644; display: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      }
      #arya-input-fab button {
        border: 1px solid #fecdd3; cursor: pointer; border-radius: 999px;
        padding: 6px 12px; font-size: 11px; font-weight: 700;
        color: #be123c; background: #fff;
        box-shadow: 0 4px 12px rgba(244,114,182,0.18);
        white-space: nowrap;
      }
      #arya-input-fab button:disabled { opacity: 0.65; cursor: wait; }
      #arya-input-fab button:hover:not(:disabled) { background: #fff1f2; }
    `;
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
          autoTranslate: false,
          showFloatBall: true,
          showSelectionDot: true,
          showInputTranslate: true,
          bilingualMode: false,
          siteRules: [],
          selectionDelayMs: 280,
          selectionMinLength: 4,
          translationTheme: 'underline'
        },
        (stored) => {
          const isMt = stored.model?.trim().toLowerCase().startsWith('qwen-mt');
          const theme = TRANSLATION_THEMES.has(stored.translationTheme)
            ? stored.translationTheme
            : 'underline';
          uiFeatureFlags = {
            showFloatBall: stored.showFloatBall !== false,
            showSelectionDot: stored.showSelectionDot !== false,
            showInputTranslate: stored.showInputTranslate !== false,
            bilingualMode: Boolean(stored.bilingualMode),
            selectionDelayMs: Math.max(0, Number(stored.selectionDelayMs) || 280),
            selectionMinLength: Math.max(1, Number(stored.selectionMinLength) || 4),
            translationTheme: theme
          };
          let settings = {
            batchSize: Number(stored.batchSize) || 40,
            concurrency: Number(stored.concurrency) || 4,
            targetLang: stored.targetLang || '简体中文',
            autoTranslate: Boolean(stored.autoTranslate),
            showFloatBall: uiFeatureFlags.showFloatBall,
            showSelectionDot: uiFeatureFlags.showSelectionDot,
            showInputTranslate: uiFeatureFlags.showInputTranslate,
            bilingualMode: uiFeatureFlags.bilingualMode,
            selectionDelayMs: uiFeatureFlags.selectionDelayMs,
            selectionMinLength: uiFeatureFlags.selectionMinLength,
            translationTheme: theme,
            watchMode: null,
            skipSelectors: '',
            siteRule: null,
            isMt
          };
          const rule = matchSiteRule(location.hostname, normalizeSiteRules(stored.siteRules));
          settings = applySiteRuleToSettings(settings, rule);
          const builtinSkip = getBuiltinSkipSelectors(location.hostname);
          const userSkip = parseSkipSelectors(settings.skipSelectors);
          activeSkipSelectors = [...new Set([...builtinSkip, ...userSkip])];
          if (settings.bilingualMode !== uiFeatureFlags.bilingualMode) {
            uiFeatureFlags.bilingualMode = settings.bilingualMode;
          }
          resolve(settings);
        }
      );
    });
  }

  function runtimeSend(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function setFloatBallTranslating(active) {
    if (!floatBallEl) return;
    floatBallEl.classList.toggle('translating', Boolean(active));
  }

  function syncFloatBallLangSelect(targetLang) {
    const select = floatBallEl?.querySelector('.arya-fb-lang');
    if (!select || !targetLang) return;
    if ([...select.options].some((o) => o.value === targetLang)) {
      select.value = targetLang;
    }
  }

  function syncFloatBallBilingualToggle(enabled) {
    const toggle = floatBallEl?.querySelector('.arya-fb-bilingual');
    if (toggle) toggle.checked = Boolean(enabled);
  }

  async function ensureFloatBall() {
    if (!isTopFrame) return;
    await getSettings();
    if (!uiFeatureFlags.showFloatBall) {
      if (floatBallEl) {
        floatBallEl.remove();
        floatBallEl = null;
      }
      return;
    }
    ensureOverlayStyles();
    if (floatBallEl) {
      const latest = await getSettings();
      syncFloatBallLangSelect(latest.targetLang);
      syncFloatBallBilingualToggle(latest.bilingualMode);
      return;
    }

    const settings = await getSettings();
    const ball = document.createElement('div');
    ball.id = 'arya-float-ball';
    ball.innerHTML = `
      <button type="button" class="arya-fb-main" title="Arya Translate" aria-label="打开 Arya Translate">
        <span class="arya-fb-icon">A</span>
      </button>
      <div class="arya-fb-panel">
        <div class="arya-fb-title"><span class="arya-fb-title-dot"></span>Arya Translate</div>
        <label class="arya-fb-label" for="arya-fb-lang">目标语言</label>
        <select class="arya-fb-lang" id="arya-fb-lang">
          ${TARGET_LANG_OPTIONS.map((lang) => (
            `<option value="${escapeHtml(lang)}"${lang === settings.targetLang ? ' selected' : ''}>${escapeHtml(lang)}</option>`
          )).join('')}
        </select>
        <label class="arya-fb-toggle">
          <input type="checkbox" class="arya-fb-bilingual"${settings.bilingualMode ? ' checked' : ''}>
          <span>双语对照（译文在下）</span>
        </label>
        <div class="arya-fb-actions">
          <button type="button" class="arya-fb-btn translate" data-action="translate">翻译此页</button>
          <button type="button" class="arya-fb-btn cancel" data-action="cancel">取消翻译</button>
          <button type="button" class="arya-fb-btn restore" data-action="restore">恢复原文</button>
        </div>
        <div class="arya-fb-donate">
          <span class="arya-fb-donate-text">Arya 翻译完全免费</span>
          <button type="button" class="arya-fb-link donate" data-action="donate">打赏</button>
        </div>
        <div class="arya-fb-links">
          <button type="button" class="arya-fb-link settings" data-action="settings">设置与 API</button>
        </div>
      </div>
    `;

    const mainBtn = ball.querySelector('.arya-fb-main');
    const langSelect = ball.querySelector('.arya-fb-lang');
    const bilingualToggle = ball.querySelector('.arya-fb-bilingual');

    mainBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      floatBallExpanded = !floatBallExpanded;
      ball.classList.toggle('expanded', floatBallExpanded);
    });

    langSelect.addEventListener('change', async () => {
      await chrome.storage.sync.set({ targetLang: langSelect.value });
    });

    bilingualToggle.addEventListener('change', async () => {
      const bilingualMode = bilingualToggle.checked;
      uiFeatureFlags.bilingualMode = bilingualMode;
      if (activeSettings) activeSettings.bilingualMode = bilingualMode;
      await chrome.storage.sync.set({ bilingualMode });
    });

    ball.querySelector('[data-action="translate"]').addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      setFloatBallTranslating(true);
      try {
        await chrome.storage.sync.set({
          targetLang: langSelect.value,
          bilingualMode: bilingualToggle.checked
        });
        const result = await runtimeSend({ action: 'selfPageTranslate' });
        if (result?.success) {
          showOverlay(`完成！Arya 已翻译 ${result.count || 0} 段${result.estimatedTokens ? ` · 约 ${result.estimatedTokens.toLocaleString()} tokens` : ''}`, 100);
          setTimeout(hideOverlay, 1500);
        } else if (result?.error && !result?.cancelled) {
          showOverlay(result.error, 0);
          setTimeout(hideOverlay, 2200);
        }
      } catch (error) {
        showOverlay(error.message || '翻译失败', 0);
        setTimeout(hideOverlay, 2200);
      } finally {
        setFloatBallTranslating(isTranslating || isProcessingIncremental);
      }
    });

    ball.querySelector('[data-action="cancel"]').addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await runtimeSend({ action: 'selfBroadcast', contentAction: 'cancel' });
      } catch {
        cancelTranslation();
      }
      setFloatBallTranslating(false);
    });

    ball.querySelector('[data-action="restore"]').addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await runtimeSend({ action: 'selfBroadcast', contentAction: 'restore' });
        showOverlay('已恢复原文', 100);
        setTimeout(hideOverlay, 1200);
      } catch (error) {
        restoreOriginal();
        showOverlay(error.message || '已恢复原文', 100);
        setTimeout(hideOverlay, 1200);
      }
      setFloatBallTranslating(false);
    });

    ball.querySelector('[data-action="settings"]').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        chrome.runtime.openOptionsPage();
      } catch {
        runtimeSend({ action: 'openOptionsPage' }).catch(() => {});
      }
    });

    ball.querySelector('[data-action="donate"]').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      runtimeSend({ action: 'openAfdianPage' }).catch(() => {});
    });

    document.addEventListener('mousedown', (e) => {
      if (!floatBallEl || !floatBallExpanded) return;
      if (e.target?.closest?.('#arya-float-ball')) return;
      floatBallExpanded = false;
      floatBallEl.classList.remove('expanded');
    }, true);

    document.documentElement.appendChild(ball);
    floatBallEl = ball;
  }

  function getEditableValue(el) {
    if (!el) return '';
    if (el.isContentEditable) return (el.innerText || el.textContent || '').trim();
    return String(el.value || '').trim();
  }

  function setEditableValue(el, value) {
    if (!el) return;
    if (el.isContentEditable) {
      el.focus();
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return;
    }
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) descriptor.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function isSupportedEditable(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE || isOurOverlayElement(el)) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (el.tagName !== 'INPUT') return false;
    const type = (el.type || 'text').toLowerCase();
    if (['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden', 'image', 'range', 'color'].includes(type)) {
      return false;
    }
    return !el.disabled && !el.readOnly;
  }

  function hideInputFab() {
    if (inputFabHideTimer) {
      clearTimeout(inputFabHideTimer);
      inputFabHideTimer = null;
    }
    inputFabTarget = null;
    if (inputFabEl) inputFabEl.style.display = 'none';
  }

  function positionInputFab(el) {
    if (!inputFabEl || !el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 18) {
      inputFabEl.style.display = 'none';
      return;
    }
    const top = Math.min(Math.max(rect.top + 4, 8), window.innerHeight - 36);
    const left = Math.min(Math.max(rect.right - 78, 8), window.innerWidth - 86);
    inputFabEl.style.top = `${top}px`;
    inputFabEl.style.left = `${left}px`;
    inputFabEl.style.display = 'block';
  }

  async function ensureInputFab() {
    await getSettings();
    if (!uiFeatureFlags.showInputTranslate) {
      hideInputFab();
      if (inputFabEl) {
        inputFabEl.remove();
        inputFabEl = null;
      }
      return;
    }
    ensureOverlayStyles();
    if (inputFabEl) return;

    const fab = document.createElement('div');
    fab.id = 'arya-input-fab';
    fab.innerHTML = '<button type="button" title="翻译当前输入框">译</button>';
    const btn = fab.querySelector('button');

    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = inputFabTarget;
      if (!target || !isSupportedEditable(target)) return;
      const source = getEditableValue(target);
      if (!source || source.length < 1) {
        showOverlay('输入框里还没有可翻译的文字', 0);
        setTimeout(hideOverlay, 1400);
        return;
      }

      btn.disabled = true;
      btn.textContent = '…';
      try {
        const settings = await getSettings();
        const targetLang = resolveMutualTargetLang(source, settings.targetLang);
        const [translated] = await translatePreviewTexts([source], targetLang);
        const next = (translated || '').trim();
        if (!next) throw new Error('未返回译文');
        setEditableValue(target, next);
        showOverlay(`输入框已译为 ${targetLang}`, 100);
        setTimeout(hideOverlay, 1400);
      } catch (error) {
        showOverlay(error.message || '输入框翻译失败', 0);
        setTimeout(hideOverlay, 2000);
      } finally {
        btn.disabled = false;
        btn.textContent = '译';
        if (inputFabTarget) positionInputFab(inputFabTarget);
      }
    });

    document.documentElement.appendChild(fab);
    inputFabEl = fab;
  }

  function showInputFabFor(el) {
    if (!uiFeatureFlags.showInputTranslate || !isSupportedEditable(el)) {
      hideInputFab();
      return;
    }
    ensureInputFab().then(() => {
      inputFabTarget = el;
      positionInputFab(el);
    });
  }

  function bindInputTranslateListeners() {
    document.addEventListener('focusin', (e) => {
      const el = e.target;
      if (!isSupportedEditable(el)) return;
      showInputFabFor(el);
    }, true);

    document.addEventListener('focusout', (e) => {
      if (!inputFabEl) return;
      const next = e.relatedTarget;
      if (next && (next === inputFabEl || inputFabEl.contains(next))) return;
      inputFabHideTimer = setTimeout(() => {
        if (document.activeElement && isSupportedEditable(document.activeElement)) {
          showInputFabFor(document.activeElement);
          return;
        }
        hideInputFab();
      }, 180);
    }, true);

    document.addEventListener('scroll', () => {
      if (inputFabTarget) positionInputFab(inputFabTarget);
    }, true);

    window.addEventListener('resize', () => {
      if (inputFabTarget) positionInputFab(inputFabTarget);
    });
  }

  async function refreshUiWidgets() {
    await getSettings();
    await ensureFloatBall();
    await ensureInputFab();
    if (!uiFeatureFlags.showSelectionDot) hideSelectionBubble();
    if (!uiFeatureFlags.showInputTranslate) hideInputFab();
    setFloatBallTranslating(isTranslating || isProcessingIncremental);
  }

  const PARA_BLOCK_TAGS = new Set([
    'P', 'LI', 'DD', 'DT', 'BLOCKQUOTE', 'FIGCAPTION',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'TD', 'TH', 'ARTICLE'
  ]);

  function hasBlockLevelChild(el) {
    if (!el?.children) return false;
    for (const child of el.children) {
      const tag = child.tagName;
      if (PARA_BLOCK_TAGS.has(tag)) return true;
      if (tag === 'DIV' || tag === 'SECTION' || tag === 'UL' || tag === 'OL'
        || tag === 'TABLE' || tag === 'FORM' || tag === 'DL') {
        return true;
      }
    }
    return false;
  }

  function isCompactTranslationContext(el) {
    if (!el) return false;
    return Boolean(
      el.closest(
        [
          'nav',
          'aside',
          'header',
          'footer',
          '[role="navigation"]',
          '[role="menubar"]',
          '[role="menu"]',
          '[role="tablist"]',
          '[role="toolbar"]',
          '[role="banner"]',
          '[role="complementary"]',
          '[role="directory"]',
          '.table-of-contents',
          '.toc',
          '#toc',
          '[class*="table-of-contents" i]',
          '[class*="TableOfContents"]',
          '[class*="on-this-page" i]',
          '[class*="OnThisPage"]',
          '[class*="SideNav"]',
          '[class*="DocsSidebar"]',
          '[data-testid*="toc" i]'
        ].join(', ')
      )
    );
  }

  function findInteractiveHost(node) {
    if (!node?.parentElement) return null;
    return node.parentElement.closest(
      'a, button, summary, [role="link"], [role="button"], [role="menuitem"], [role="tab"]'
    );
  }

  function isEffectivelyVisible(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity || '1') === 0) return false;
      // 响应式隐藏（如 lg:hidden / hidden）在真实布局里通常没有盒模型
      if (el.getClientRects().length === 0) return false;
    } catch {
      return true;
    }
    return true;
  }

  function dedupeNestedPhrases(parts) {
    const cleaned = parts.map((p) => String(p || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    // 「Contact」被「Contact sales」包含时只保留更长的，避免译成「联系联系销售」
    return cleaned.filter((part, index) => {
      const lower = part.toLowerCase();
      return !cleaned.some((other, otherIndex) => {
        if (index === otherIndex) return false;
        const otherLower = other.toLowerCase();
        return otherLower !== lower && otherLower.includes(lower);
      });
    });
  }

  function getHostVisibleText(host) {
    if (!host) return '';
    const parts = [];
    try {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const raw = node.textContent || '';
          if (!raw.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest('.arya-bilingual, [data-arya-bilingual], script, style, noscript, .sr-only, .visually-hidden, [aria-hidden="true"]')) {
            return NodeFilter.FILTER_REJECT;
          }
          let el = parent;
          while (el && el !== host.parentElement) {
            if (el !== host && !isEffectivelyVisible(el)) return NodeFilter.FILTER_REJECT;
            if (el === host) break;
            el = el.parentElement;
          }
          if (!isEffectivelyVisible(host) && host.getClientRects().length === 0) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      while (walker.nextNode()) {
        parts.push(walker.currentNode.textContent.trim());
      }
    } catch {
      // fallback below
    }

    let text = dedupeNestedPhrases(parts).join(' ').replace(/\s+/g, ' ').trim();
    if (text) return text;

    // 回退：对整段文案做包含去重
    try {
      const raw = (host.innerText || host.textContent || '').replace(/\s+/g, ' ').trim();
      if (!raw) return '';
      // 若像「Contact Contact sales」这种拼接，压成最长短语
      const tokens = raw.split(' ').filter(Boolean);
      if (tokens.length >= 2) {
        const collapsed = dedupeNestedPhrases([raw, ...tokens]);
        if (collapsed.length === 1) return collapsed[0];
        // 取最长片段
        return collapsed.sort((a, b) => b.length - a.length)[0] || raw;
      }
      return raw;
    } catch {
      return (host.textContent || '').replace(/\s+/g, ' ').trim();
    }
  }

  function findTranslationBlock(node) {
    let el = node?.parentElement;
    let divFallback = null;
    while (el && el !== document.body && el !== document.documentElement) {
      if (shouldSkipElement(el)) return null;
      if (isCompactTranslationContext(el)) return null;
      if (PARA_BLOCK_TAGS.has(el.tagName)) return el;
      if ((el.tagName === 'DIV' || el.tagName === 'SECTION') && !hasBlockLevelChild(el)) {
        if (!divFallback) divFallback = el;
      }
      el = el.parentElement;
    }
    return divFallback;
  }

  /**
   * 仅把「整颗控件」当 host 单独译。
   * 段落/列表里的行内链接必须并入父级 block，否则句子被掏空，易译成错乱拼接。
   */
  function shouldTranslateHostSeparately(host) {
    if (!host) return false;
    if (isCompactTranslationContext(host)) return true;
    if (host.matches?.('button, summary, [role="button"], [role="menuitem"], [role="tab"]')) {
      return true;
    }

    const blockParent = host.closest(
      'p, li, dd, dt, h1, h2, h3, h4, h5, h6, td, th, blockquote, figcaption'
    );
    if (!blockParent || blockParent === host) return true;

    try {
      const full = (blockParent.innerText || blockParent.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      const hostText = getHostVisibleText(host) || (host.textContent || '').replace(/\s+/g, ' ').trim();
      if (!full) return true;
      if (!hostText) return false;
      // 链接几乎就是整段（如单独的 CTA）→ 仍按 host
      if (full.length <= hostText.length + 12) return true;
      // 段内还有大量其它文案 → 行内链接，并入 block
      return false;
    } catch {
      return false;
    }
  }

  function compareDocumentOrder(a, b) {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function joinBlockTextInOrder(nodes) {
    return [...nodes]
      .sort(compareDocumentOrder)
      .map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function groupTextNodesIntoUnits(textNodes) {
    const hostBuckets = new Map();
    const blockBuckets = new Map();
    const singles = [];

    for (const node of textNodes) {
      if (!node?.isConnected) continue;
      const text = node.textContent?.trim() || '';
      if (!text || isLikelyNonTranslatable(text)) continue;

      const host = findInteractiveHost(node);
      if (host && shouldTranslateHostSeparately(host)) {
        let bucket = hostBuckets.get(host);
        if (!bucket) {
          bucket = { host, nodes: [] };
          hostBuckets.set(host, bucket);
        }
        bucket.nodes.push(node);
        continue;
      }

      const block = findTranslationBlock(node);
      if (!block) {
        singles.push({
          __aryaUnit: true,
          kind: 'node',
          node,
          nodes: [node],
          text
        });
        continue;
      }

      let bucket = blockBuckets.get(block);
      if (!bucket) {
        bucket = { block, nodes: [] };
        blockBuckets.set(block, bucket);
      }
      bucket.nodes.push(node);
    }

    const units = [];

    for (const { host, nodes } of hostBuckets.values()) {
      const ordered = [...new Set(nodes)].sort(compareDocumentOrder);
      const visibleNodes = ordered.filter((node) => {
        let el = node.parentElement;
        while (el && el !== host.parentElement) {
          if (el !== host && !isEffectivelyVisible(el)) return false;
          if (el === host) break;
          el = el.parentElement;
        }
        return true;
      });
      const nodesForUnit = visibleNodes.length ? visibleNodes : ordered;
      const unitText = getHostVisibleText(host)
        || joinBlockTextInOrder(nodesForUnit);
      if (!unitText || isLikelyNonTranslatable(unitText)) continue;
      units.push({
        __aryaUnit: true,
        kind: 'host',
        host,
        nodes: nodesForUnit,
        text: unitText
      });
    }

    for (const { block, nodes } of blockBuckets.values()) {
      const ordered = [...new Set(nodes)].sort(compareDocumentOrder);
      const unitText = joinBlockTextInOrder(ordered);
      if (!unitText || isLikelyNonTranslatable(unitText)) continue;

      if (ordered.length === 1 && unitText.length < 42) {
        units.push({
          __aryaUnit: true,
          kind: 'node',
          node: ordered[0],
          nodes: ordered,
          text: unitText
        });
        continue;
      }

      if (ordered.length > 48 || unitText.length > 4500) {
        for (const node of ordered) {
          const t = (node.textContent || '').trim();
          if (!t || isLikelyNonTranslatable(t)) continue;
          units.push({
            __aryaUnit: true,
            kind: 'node',
            node,
            nodes: [node],
            text: t
          });
        }
        continue;
      }

      units.push({
        __aryaUnit: true,
        kind: 'block',
        block,
        nodes: ordered,
        text: unitText
      });
    }

    return units.concat(singles);
  }

  function expandNodesForBilingualBlocks(nodes) {
    if (!isBilingualMode()) return nodes;
    const seenBlocks = new Set();
    const seenNodes = new Set();
    const out = [];

    for (const node of nodes) {
      if (!node?.isConnected || seenNodes.has(node)) continue;
      const block = findTranslationBlock(node);
      if (!block || isCompactTranslationContext(block)) {
        seenNodes.add(node);
        out.push(node);
        continue;
      }
      if (seenBlocks.has(block)) continue;
      seenBlocks.add(block);
      const collected = [];
      collectTextNodesFromRootTree(block, collected, null);
      for (const n of collected) {
        if (seenNodes.has(n)) continue;
        seenNodes.add(n);
        out.push(n);
      }
    }
    return out;
  }

  function buildUniqueTextPlan(textNodes) {
    const textToNodes = new Map();
    const uniqueTexts = [];

    // 替换模式也要按段落/列表聚合，否则行内链接会拆句导致译文错乱、悬停只剩末尾碎片
    const targets = groupTextNodesIntoUnits(textNodes);

    for (const target of targets) {
      const text = target?.__aryaUnit
        ? target.text
        : (target?.textContent || '').trim();
      if (!text || isLikelyNonTranslatable(text)) continue;
      if (!textToNodes.has(text)) {
        textToNodes.set(text, []);
        uniqueTexts.push(text);
      }
      textToNodes.get(text).push(
        target?.__aryaUnit
          ? target
          : { __aryaUnit: true, kind: 'node', node: target, nodes: [target], text }
      );
    }

    return {
      uniqueTexts,
      textToNodes,
      totalNodes: [...textToNodes.values()].reduce((n, arr) => n + arr.length, 0)
    };
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

  let measureCanvas = null;

  function measureTextWidth(text, refEl) {
    const sample = String(text || '');
    if (!sample) return 0;
    try {
      const style = window.getComputedStyle(refEl || document.body);
      const fontSize = parseFloat(style.fontSize) || 14;
      const font = `${style.fontStyle || 'normal'} ${style.fontWeight || '400'} ${fontSize * 0.9}px ${style.fontFamily || 'sans-serif'}`;
      if (!measureCanvas) measureCanvas = document.createElement('canvas');
      const ctx = measureCanvas.getContext('2d');
      if (ctx) {
        ctx.font = font;
        return ctx.measureText(sample).width;
      }
    } catch {
      // fallback below
    }
    const fontSize = 14;
    let w = 0;
    for (const ch of sample) {
      w += /[\u4e00-\u9fff]/.test(ch) ? fontSize * 0.95 : fontSize * 0.55;
    }
    return w;
  }

  function getContentRightEdge(anchor) {
    try {
      if (anchor?.nodeType === Node.TEXT_NODE) {
        const range = document.createRange();
        range.selectNodeContents(anchor);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
        if (rects.length) return rects[rects.length - 1].right;
      }
      const el = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
      if (!el) return 0;
      return el.getBoundingClientRect().right;
    } catch {
      return 0;
    }
  }

  function findInlineLayoutContainer(el) {
    let cur = el;
    for (let i = 0; i < 8 && cur && cur !== document.body; i++) {
      try {
        const st = window.getComputedStyle(cur);
        if (
          st.display.includes('flex')
          || st.display.includes('grid')
          || st.display === 'block'
          || st.display === 'inline-block'
          || cur.tagName === 'TD'
          || cur.tagName === 'TH'
          || cur.tagName === 'LI'
          || cur.tagName === 'P'
        ) {
          const w = cur.getBoundingClientRect().width;
          if (w >= 40) return cur;
        }
      } catch {
        // ignore
      }
      cur = cur.parentElement;
    }
    return el;
  }

  function canFitInlineTranslation(anchor, translatedText) {
    const ref = anchor?.nodeType === Node.ELEMENT_NODE
      ? anchor
      : (anchor?.parentElement || document.body);
    if (!ref || !translatedText) return false;

    const need = measureTextWidth(translatedText, ref) + 14;
    // 太长的译文横着几乎总会挤爆
    if (need > Math.min(window.innerWidth * 0.55, 420)) return false;

    const contentRight = getContentRightEdge(anchor);
    if (!contentRight) return String(translatedText).length <= 18;

    const container = findInlineLayoutContainer(ref);
    const containerRight = container.getBoundingClientRect().right;
    const viewportRight = window.innerWidth - 12;
    const available = Math.min(containerRight, viewportRight) - contentRight;
    return available >= need;
  }

  function expandBilingualAncestors(startEl) {
    let el = startEl?.nodeType === Node.ELEMENT_NODE ? startEl : startEl?.parentElement;
    if (!el) return;

    for (let i = 0; i < 5 && el && el !== document.documentElement; i++) {
      if (el === document.body) break;
      // 导航 / sticky 头不撑开
      if (isCompactTranslationContext(el)) break;
      try {
        const st = window.getComputedStyle(el);
        if (st.position === 'sticky' || st.position === 'fixed') break;
        if (st.position === 'absolute') {
          el = el.parentElement;
          continue;
        }

        const overflowY = st.overflowY || st.overflow;
        const overflowX = st.overflowX || st.overflow;
        // 演示卡片 / 裁切容器：不要强行 overflow:visible
        if (overflowY === 'hidden' || overflowX === 'hidden') {
          const hasFixedBox = st.height !== 'auto' || (st.maxHeight && st.maxHeight !== 'none');
          if (hasFixedBox || st.borderRadius !== '0px') {
            el = el.parentElement;
            continue;
          }
        }

        const isScrollPort = (overflowY === 'auto' || overflowY === 'scroll')
          && el.scrollHeight > el.clientHeight + 24
          && el.clientHeight > 160;
        if (isScrollPort && i >= 2) {
          el.setAttribute('data-arya-expand-scroll', '1');
          break;
        }
        el.setAttribute('data-arya-expand', '1');
      } catch {
        // ignore expand on this node
      }
      el = el.parentElement;
    }
  }

  function shouldSkipBilingualUi(el, text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return true;
    // 侧栏 / TOC / 导航：双语会撑宽窄栏导致横向滚动，整区跳过
    if (isCompactTranslationContext(el)) return true;
    if (el?.closest?.('[role="menuitem"], [role="tab"], [role="toolbar"]') && t.length <= 28) {
      return true;
    }
    // 过窄容器（如右侧目录残留节点）也不挂双语
    try {
      const box = el?.nodeType === Node.ELEMENT_NODE ? el : el?.parentElement;
      if (box) {
        const w = box.getBoundingClientRect().width;
        if (w > 0 && w < 220 && t.length > 12) return true;
      }
    } catch {
      // ignore
    }
    return false;
  }

  function resolveBilingualPlacement(nodeOrHost, originalText, translatedText, { forceInline = false } = {}) {
    if (forceInline) return 'inline';

    const anchor = nodeOrHost;
    const el = anchor?.nodeType === Node.ELEMENT_NODE
      ? anchor
      : anchor?.parentElement;
    const src = String(originalText || '').replace(/\s+/g, ' ').trim();
    const dst = String(translatedText || '').replace(/\s+/g, ' ').trim();
    if (!dst) return 'block';

    // 明确多行 / 很长的段落：直接下方
    if (/[\n\r]/.test(String(originalText || '')) || /[\n\r]/.test(String(translatedText || ''))) {
      return 'block';
    }
    if (src.length > 90 || dst.length > 90) return 'block';
    if (src.length > 48 && (src.match(/[.!?。！？]/g) || []).length >= 1) return 'block';

    // 交互控件 / flex 行内：横排极易挤按钮，强制下方
    const host = el && (el.matches?.('a, button, summary, [role="link"], [role="button"]')
      ? el
      : findInteractiveHost(el));
    if (host || (el && isFragileInsertParent(el))) {
      return 'block';
    }

    // 优先横着：测一下右侧空间够不够
    if (canFitInlineTranslation(anchor || el, dst)) return 'inline';
    return 'block';
  }

  function clearBilingualHosts(scope) {
    if (!scope?.querySelectorAll) return;
    scope.querySelectorAll('[data-arya-bilingual-host]').forEach((el) => {
      el.removeAttribute('data-arya-bilingual-host');
    });
    scope.querySelectorAll('[data-arya-expand], [data-arya-expand-scroll]').forEach((el) => {
      el.removeAttribute('data-arya-expand');
      el.removeAttribute('data-arya-expand-scroll');
    });
  }

  function removeBlockBilingual(blockEl) {
    if (!blockEl) return;
    const cached = bilingualElements.get(blockEl);
    isApplyingTranslation = true;
    try {
      if (cached?.isConnected) {
        removeBilingualArtifactsBefore(cached);
        cached.remove();
      }
      blockEl.querySelectorAll(':scope > .arya-bilingual[data-arya-block="1"]').forEach((el) => {
        removeBilingualArtifactsBefore(el);
        el.remove();
      });
      blockEl.querySelectorAll(':scope > .arya-bilingual-break, :scope > [data-arya-bilingual-break="1"]').forEach((el) => {
        el.remove();
      });
    } finally {
      isApplyingTranslation = false;
    }
    bilingualElements.delete(blockEl);
  }

  function applyBilingualHostTranslation(host, nodes, translated) {
    if (!host?.isConnected || !isValidTranslation(translated)) return;

    for (const node of nodes) {
      if (!translatedNodes.has(node)) translatedNodes.set(node, node.textContent);
      removeBilingualElement(node);
    }

    const source = getHostVisibleText(host)
      || (nodes || []).map((n) => n.textContent || '').join(' ');

    // 导航短文案：跳过双语，避免 CTA/菜单被撑开
    if (shouldSkipBilingualUi(host, source)) return;

    // 永远挂在 host 外侧 sibling，不塞进 a/button 内部
    let placement = resolveBilingualPlacement(host, source, translated);
    if (placement === 'inline') placement = 'block';

    isApplyingTranslation = true;
    try {
      host.querySelectorAll('.arya-bilingual').forEach((el) => {
        removeBilingualArtifactsBefore(el);
        el.remove();
      });
      host.querySelectorAll('.arya-bilingual-break, [data-arya-bilingual-break="1"]').forEach((el) => {
        el.remove();
      });
      const cached = bilingualElements.get(host);
      if (cached?.isConnected) {
        removeBilingualArtifactsBefore(cached);
        cached.remove();
      }
      // 清掉此前挂在 host 后面的译文
      let sib = host.nextSibling;
      while (sib) {
        const next = sib.nextSibling;
        if (isBilingualBreak(sib) || isBilingualSpacerText(sib)) {
          sib.remove();
          sib = next;
          continue;
        }
        if (sib.nodeType === Node.ELEMENT_NODE && sib.classList?.contains('arya-bilingual')) {
          sib.remove();
          break;
        }
        break;
      }

      const el = createBilingualElement(translated, placement, { host: true, original: source });
      const mounted = mountBilingualNear(host, el, placement);
      bilingualElements.set(host, el);
      host.setAttribute('data-arya-bilingual-host', '1');
      if (placement === 'block') expandBilingualAncestors(mounted.parent);
    } finally {
      isApplyingTranslation = false;
    }
  }

  function applyBilingualBlockTranslation(blockEl, nodes, translated) {
    if (!blockEl?.isConnected || !isValidTranslation(translated)) return;

    for (const node of nodes) {
      if (!translatedNodes.has(node)) translatedNodes.set(node, node.textContent);
      removeBilingualElement(node);
    }
    removeBlockBilingual(blockEl);

    const joinedOriginal = nodes
      .map((n) => translatedNodes.get(n) ?? n.textContent)
      .join(' ');
    if (shouldSkipBilingualUi(blockEl, joinedOriginal)) return;

    // 用最后一个文本节点测右侧剩余空间更准
    const measureAnchor = nodes[nodes.length - 1] || blockEl;
    const placement = resolveBilingualPlacement(measureAnchor, joinedOriginal, translated);

    isApplyingTranslation = true;
    try {
      const el = createBilingualElement(translated, placement, { block: true, original: joinedOriginal });
      let mounted;
      if (placement === 'inline' && measureAnchor?.parentNode && !isFragileInsertParent(measureAnchor.parentNode)) {
        insertBilingualAfter(measureAnchor.parentNode, measureAnchor, el, placement);
        mounted = { parent: measureAnchor.parentNode };
      } else {
        mounted = mountBilingualNear(blockEl.lastChild || blockEl, el, placement === 'inline' ? 'block' : placement);
      }
      bilingualElements.set(blockEl, el);
      if (el.classList.contains('arya-bilingual-block')) {
        expandBilingualAncestors(mounted?.parent || blockEl);
      }
    } finally {
      isApplyingTranslation = false;
    }
  }

  function applyBilingualTranslation(node, translated) {
    if (!node?.parentNode || !isValidTranslation(translated)) return;

    // 若已在「独立」链接/按钮宿主上挂过译文，不再给内部 text node 重复挂
    const host = findInteractiveHost(node);
    if (host && shouldTranslateHostSeparately(host)) {
      if (bilingualElements.get(host)?.isConnected) {
        if (!translatedNodes.has(node)) translatedNodes.set(node, node.textContent);
        return;
      }
      applyBilingualHostTranslation(host, [node], translated);
      return;
    }

    const stored = translatedNodes.get(node);
    if (stored == null) {
      translatedNodes.set(node, node.textContent);
    } else if (node.textContent !== stored) {
      isApplyingTranslation = true;
      try {
        node.textContent = stored;
      } finally {
        isApplyingTranslation = false;
      }
    }

    const originalText = translatedNodes.get(node) ?? node.textContent;
    if (shouldSkipBilingualUi(node.parentElement || node, originalText)) return;

    let placement = resolveBilingualPlacement(node, originalText, translated);
    if (placement === 'inline' && isFragileInsertParent(node.parentNode)) {
      placement = 'block';
    }

    isApplyingTranslation = true;
    try {
      const existing = findBilingualElement(node);
      if (existing) {
        removeBilingualArtifactsBefore(existing);
        existing.remove();
        bilingualElements.delete(node);
      }
      const el = createBilingualElement(translated, placement, { original: originalText });
      let mountParent = node.parentNode;
      if (placement === 'block') {
        const mounted = mountBilingualNear(node, el, placement);
        mountParent = mounted.parent;
      } else {
        insertBilingualAfter(node.parentNode, node, el, placement);
      }
      bilingualElements.set(node, el);
      if (placement === 'block') {
        expandBilingualAncestors(mountParent || node.parentElement || node);
      }
    } finally {
      isApplyingTranslation = false;
    }
  }

  function markReplacedOriginal(el, original) {
    if (!el || !original) return;
    try {
      el.setAttribute('data-arya-replaced', '1');
      el.setAttribute('data-arya-original', original);
    } catch {
      // ignore
    }
  }

  /** 替换模式：多文本节点（常因行内链接拆开）整段一次写入，悬停可还原整句 */
  function applyReplaceFragmentTranslation(nodes, translated, original) {
    if (!isValidTranslation(translated)) return;
    const ordered = [...new Set(nodes || [])]
      .filter((n) => n?.isConnected)
      .sort(compareDocumentOrder);
    if (!ordered.length) return;

    // 每个节点只存自己的原文碎片；整句留给 data-arya-original 做悬停。
    // 若把整句写进 first 的 translatedNodes，恢复时其它碎片再还原 → 原文重复。
    for (const node of ordered) {
      if (!translatedNodes.has(node)) {
        translatedNodes.set(node, node.textContent);
      }
    }

    const fullOriginal = String(
      original
      || ordered
        .map((n) => String(translatedNodes.get(n) ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' ')
    ).replace(/\s+/g, ' ').trim();

    isApplyingTranslation = true;
    try {
      const first = ordered[0];
      first.textContent = translated;

      const anchorEl = first.parentElement || findTranslationBlock(first);
      if (anchorEl) markReplacedOriginal(anchorEl, fullOriginal);

      for (let i = 1; i < ordered.length; i++) {
        ordered[i].textContent = '';
      }
    } finally {
      isApplyingTranslation = false;
    }
  }

  function applyReplaceHostTranslation(host, nodes, translated, original) {
    if (!host?.isConnected || !isValidTranslation(translated)) return;
    const source = String(original || getHostVisibleText(host) || '').trim();
    const targets = (nodes || []).filter((n) => n?.isConnected);
    if (targets.length) {
      applyReplaceFragmentTranslation(targets, translated, source);
    } else {
      isApplyingTranslation = true;
      try {
        const textNode = [...host.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
        if (textNode) {
          if (!translatedNodes.has(textNode)) translatedNodes.set(textNode, textNode.textContent);
          textNode.textContent = translated;
        } else {
          host.textContent = translated;
        }
        markReplacedOriginal(host, source);
      } finally {
        isApplyingTranslation = false;
      }
    }
    markReplacedOriginal(host, source);
  }

  function applyReplaceBlockTranslation(blockEl, nodes, translated, original) {
    if (!blockEl?.isConnected || !isValidTranslation(translated)) return;
    const source = String(original || joinBlockTextInOrder(nodes) || '').trim();
    applyReplaceFragmentTranslation(nodes, translated, source);
    markReplacedOriginal(blockEl, source);
  }

  function applyTranslationUnit(unit, translated) {
    if (!unit || !isValidTranslation(translated)) return;
    if (unit.kind === 'host' && unit.host && isBilingualMode()) {
      applyBilingualHostTranslation(unit.host, unit.nodes || [], translated);
      return;
    }
    if (unit.kind === 'block' && unit.block && isBilingualMode()) {
      applyBilingualBlockTranslation(unit.block, unit.nodes || [], translated);
      return;
    }
    if (unit.kind === 'host' && unit.host && !isBilingualMode()) {
      applyReplaceHostTranslation(unit.host, unit.nodes || [], translated, unit.text);
      return;
    }
    if (unit.kind === 'block' && unit.block && !isBilingualMode()) {
      applyReplaceBlockTranslation(unit.block, unit.nodes || [], translated, unit.text);
      return;
    }
    const nodes = unit.nodes || (unit.node ? [unit.node] : []);
    if (!isBilingualMode() && nodes.length > 1) {
      applyReplaceFragmentTranslation(nodes, translated, unit.text);
      return;
    }
    for (const node of nodes) applyTranslation(node, translated);
  }

  function applyTranslation(node, translated) {
    if (!isValidTranslation(translated)) return;

    if (node?.__aryaUnit) {
      applyTranslationUnit(node, translated);
      return;
    }

    if (isBilingualMode()) {
      applyBilingualTranslation(node, translated);
      return;
    }

    removeBilingualElement(node);
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

    scope.querySelectorAll('.arya-bilingual-break, [data-arya-bilingual-break="1"]').forEach((el) => {
      el.remove();
    });
    scope.querySelectorAll('.arya-bilingual, [data-arya-bilingual="1"]').forEach((el) => {
      removeBilingualArtifactsBefore(el);
      el.remove();
    });
    clearBilingualHosts(scope);

    scope.querySelectorAll('[data-arya-replaced="1"]').forEach((el) => {
      el.removeAttribute('data-arya-replaced');
      el.removeAttribute('data-arya-original');
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
    hideOriginalTooltip();
    markAutoTranslateSkippedForPage();
    sessionId = null;
    resetSessionUsage();
    setPageTranslationActive(false);
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
      setAryaDualState(false);
    }
  }

  function cancelTranslation() {
    cancelRequested = true;
    hideSelectionBubble();
    hideOriginalTooltip();
    const sid = sessionId;
    stopWatchMode();
    if (sid) {
      chrome.runtime.sendMessage({ action: 'cancelSession', sessionId: sid });
    }
    sessionId = null;
    setFloatBallTranslating(false);
    showCancelledAndHide();
  }

  function collectTextNodesFromRoot(root) {
    const nodes = [];
    if (!root) return nodes;

    if (root.nodeType === Node.TEXT_NODE) {
      const text = root.textContent.trim();
      if (text.length >= 2
        && !shouldSkipNode(root)
        && !isLikelyNonTranslatable(text)
        && !isNoisyParent(root.parentElement)) {
        nodes.push(root);
      }
      return nodes;
    }

    if (root.nodeType !== Node.ELEMENT_NODE || isOurOverlayElement(root)) return nodes;
    if (isNoisyParent(root)) return nodes;

    collectTextNodesFromRootTree(root, nodes);
    return nodes.filter((n) => {
      const text = n.textContent?.trim() || '';
      return !isLikelyNonTranslatable(text) && !isNoisyParent(n.parentElement);
    });
  }

  function extractTextNodesFromMutations(records) {
    const nodes = new Set();
    for (const record of records) {
      if (record.type === 'characterData' && record.target?.nodeType === Node.TEXT_NODE) {
        const target = record.target;
        const newText = target.textContent || '';
        const oldText = record.oldValue || '';
        if (isDigitSkeletonChange(oldText, newText)) {
          noteNoisyParent(target.parentElement);
          continue;
        }
        if (isLikelyNonTranslatable(newText.trim())) {
          if (/\d/.test(newText) || /\d/.test(oldText)) {
            noteNoisyParent(target.parentElement);
          }
          continue;
        }
        if (isNoisyParent(target.parentElement)) continue;
        collectTextNodesFromRoot(target).forEach((n) => nodes.add(n));
      }
      for (const node of record.addedNodes || []) {
        const parent = node.parentElement
          || (node.nodeType === Node.ELEMENT_NODE ? node : null);
        if (parent && isNoisyParent(parent)) continue;
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent || '';
          if (isLikelyNonTranslatable(text.trim())) {
            if (/\d/.test(text)) noteNoisyParent(node.parentElement);
            continue;
          }
        } else if (node.nodeType === Node.ELEMENT_NODE && isNoisyParent(node)) {
          continue;
        }
        const collected = collectTextNodesFromRoot(node);
        if (!collected.length && node.nodeType === Node.ELEMENT_NODE) {
          const sample = (node.textContent || '').trim().slice(0, 40);
          if (sample && isLikelyNonTranslatable(sample) && /\d/.test(sample)) {
            noteNoisyParent(node.parentElement || node);
          }
        }
        collected.forEach((n) => nodes.add(n));
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

    const rawNodes = [...pendingIncrementalNodes].filter((n) => {
      if (!n?.isConnected) return false;
      if (isNoisyParent(n.parentElement)) return false;
      const text = n.textContent?.trim() || '';
      return text.length >= 2 && !isLikelyNonTranslatable(text);
    });
    pendingIncrementalNodes.clear();
    const nodes = expandNodesForBilingualBlocks(rawNodes).filter((n) => {
      if (!n?.isConnected) return false;
      if (shouldSkipNode(n)) return false;
      const text = n.textContent?.trim() || '';
      return text.length >= 2 && !isLikelyNonTranslatable(text);
    });
    if (!nodes.length) return;

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
      characterData: true,
      characterDataOldValue: true
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
      activeSettings = settings;
      showOverlay(`Arya 正在翻译「${selectedText.slice(0, 24)}${selectedText.length > 24 ? '…' : ''}」`, 15);
      const result = await translateSelectionSegments(segments, settings, selectedText);

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
      setFloatBallTranslating(false);
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
      activeSettings = settings;

      // 已翻译时再点「翻译此页」：先恢复，再按当前模式（含双语）重译
      const alreadyTranslated = isPageTranslationActive()
        || Boolean(document.querySelector('.arya-bilingual, [data-arya-bilingual="1"]'));
      if (alreadyTranslated) {
        showOverlay(
          settings.bilingualMode ? '正在切换为双语对照…' : '正在按当前模式重新翻译…',
          5
        );
        restoreOriginal();
        await yieldToMain();
      }

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

      if (successCount > 0) setPageTranslationActive(true);

      if (failedNodeCount > 0 || stillMissed > 0) {
        const totalAttempted = successCount + failedNodeCount + stillMissed;
        showOverlay(`完成！${successCount}/${totalAttempted} 段已翻译${usage}`, 100);
        setTimeout(hideOverlay, 1800);
        if (settings.watchMode !== false) startWatchMode(settings);
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
      if (settings.watchMode !== false) startWatchMode(settings);
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
      setFloatBallTranslating(false);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'translate') {
      if (!shouldHandlePageTranslate()) {
        sendResponse({ success: true, skipped: true, count: 0 });
        return true;
      }
      setFloatBallTranslating(true);
      translatePage().then(sendResponse);
      return true;
    }
    if (message.action === 'translateSelection') {
      setFloatBallTranslating(true);
      translateSelection(message).then(sendResponse);
      return true;
    }
    if (message.action === 'cancel') {
      cancelTranslation();
      setFloatBallTranslating(false);
      sendResponse({ success: true, cancelled: true });
      return true;
    }
    if (message.action === 'restore') {
      restoreOriginal();
      setFloatBallTranslating(false);
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
    if (message.action === 'getPageTranslateState') {
      sendResponse({
        translated: isPageTranslationActive(),
        watchModeActive,
        isTranslating: isTranslating || isProcessingIncremental
      });
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

  bindInputTranslateListeners();
  refreshUiWidgets();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.autoTranslate?.newValue || changes.siteRules) scheduleAutoTranslate();
    if (
      changes.targetLang
      || changes.showFloatBall
      || changes.showSelectionDot
      || changes.showInputTranslate
      || changes.bilingualMode
      || changes.siteRules
      || changes.selectionDelayMs
      || changes.selectionMinLength
      || changes.translationTheme
    ) {
      refreshUiWidgets();
      if (changes.targetLang?.newValue) syncFloatBallLangSelect(changes.targetLang.newValue);
      getSettings().then((settings) => {
        if (activeSettings) {
          activeSettings.bilingualMode = settings.bilingualMode;
          activeSettings.watchMode = settings.watchMode;
          activeSettings.skipSelectors = settings.skipSelectors;
          activeSettings.translationTheme = settings.translationTheme;
        }
        uiFeatureFlags.bilingualMode = settings.bilingualMode;
        uiFeatureFlags.selectionDelayMs = settings.selectionDelayMs;
        uiFeatureFlags.selectionMinLength = settings.selectionMinLength;
        uiFeatureFlags.translationTheme = settings.translationTheme;
        syncFloatBallBilingualToggle(settings.bilingualMode);
      });
    }
  });
})();
