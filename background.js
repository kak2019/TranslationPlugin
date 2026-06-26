// ExtensionPay 已停用，改用爱发电（shared/afdian.js）
// importScripts('ExtPay.js', 'shared/billing.js');
importScripts('shared/afdian.js', 'shared/hosted-key.js', 'shared/models.js', 'shared/providers.js');

async function getEffectiveBailianApiKeys(config) {
  const userKeys = getBailianApiKeys(config);
  if (userKeys.length) return userKeys;

  if (isMtModel(config.model)) {
    const hosted = getHostedBailianKey();
    return hosted ? [hosted] : [];
  }
  return [];
}

async function hasTranslationAccess(config) {
  const provider = getModelProvider(config.model);
  if (provider === 'bailian') {
    return (await getEffectiveBailianApiKeys(config)).length > 0;
  }
  return hasApiKeyForModel(config);
}

function isUsingHostedBailianKey(config) {
  return isMtModel(config.model) && getBailianApiKeys(config).length === 0;
}

async function pickBailianApiKey(config) {
  const keys = await getEffectiveBailianApiKeys(config);
  if (!keys.length) return '';
  return keys[bailianKeyIndex % keys.length];
}

const DEFAULT_CONFIG = {
  apiKey: '',
  apiKey2: '',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  deepseekApiKey: '',
  deepseekBaseUrl: 'https://api.deepseek.com',
  xiaomiApiKey: '',
  xiaomiBaseUrl: 'https://api.xiaomimimo.com/v1',
  model: 'qwen-mt-flash',
  targetLang: '简体中文',
  batchSize: 40,
  concurrency: 4
};

const MT_MAX_CONCURRENT = 4;
const MT_INTERVAL_MIN = 350;
const MT_INTERVAL_MAX = 1200;
const MT_INTERVAL_STEP = 50;
const MT_RETRY_MAX = 3;
const MT_RETRY_BASE_MS = 1000;
const MT_MAX_INPUT_CHARS = 6000;
const MT_FETCH_TIMEOUT_MS = 45000;
const MT_MESSAGE_TIMEOUT_MS = 90000;
const CACHE_MAX_ENTRIES = 800;

const mtSlotQueue = { running: 0, waiters: [] };
let lastMtRequestAt = 0;
let mtCurrentInterval = 500;
let mtRateLimitChain = Promise.resolve();
let bailianKeyIndex = 0;
const abortControllers = new Map();
const memTranslationCache = new Map();

const MT_TARGET_LANG_MAP = {
  简体中文: 'Chinese',
  繁体中文: 'Traditional Chinese',
  English: 'English',
  日本語: 'Japanese',
  한국어: 'Korean',
  Français: 'French',
  Deutsch: 'German',
  Español: 'Spanish'
};

async function getConfig() {
  const stored = await chrome.storage.sync.get(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...stored };
}

function isMtModel(model) {
  return typeof model === 'string' && model.trim().toLowerCase().startsWith('qwen-mt');
}

function toMtTargetLang(targetLang) {
  return MT_TARGET_LANG_MAP[targetLang] || targetLang;
}

function cacheStorageKey(text, targetLang, model) {
  return `tx:${model}:${targetLang}:${text}`;
}

async function getCachedTranslation(text, targetLang, model) {
  const key = cacheStorageKey(text, targetLang, model);
  if (memTranslationCache.has(key)) return memTranslationCache.get(key);
  try {
    const stored = await chrome.storage.local.get(key);
    if (stored[key]) {
      memTranslationCache.set(key, stored[key]);
      return stored[key];
    }
  } catch {
    // ignore
  }
  return null;
}

async function setCachedTranslation(text, targetLang, model, translation) {
  const key = cacheStorageKey(text, targetLang, model);
  memTranslationCache.set(key, translation);
  try {
    await chrome.storage.local.set({ [key]: translation });
    if (memTranslationCache.size > CACHE_MAX_ENTRIES) {
      const firstKey = memTranslationCache.keys().next().value;
      memTranslationCache.delete(firstKey);
    }
  } catch {
    // ignore quota errors
  }
}

function rotateBailianApiKey() {
  bailianKeyIndex += 1;
}

function noteMtRequestSuccess() {
  mtCurrentInterval = Math.max(MT_INTERVAL_MIN, mtCurrentInterval - MT_INTERVAL_STEP);
  rotateBailianApiKey();
}

function noteMtRateLimited() {
  mtCurrentInterval = Math.min(MT_INTERVAL_MAX, mtCurrentInterval + MT_INTERVAL_STEP * 3);
  rotateBailianApiKey();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(message, status) {
  if (status === 429) return true;
  const msg = (message || '').toLowerCase();
  return (
    msg.includes('rate limit') ||
    msg.includes('request limit') ||
    msg.includes('exceeded your current') ||
    msg.includes('throttl') ||
    msg.includes('限流') ||
    msg.includes('频率')
  );
}

function formatApiError(message, status) {
  if (isRateLimitError(message, status)) {
    return 'API 请求过于频繁（已自动重试）。请在设置中降低并行数，或稍后再试';
  }
  return message;
}

function acquireMtSlot(maxConcurrent) {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (mtSlotQueue.running < maxConcurrent) {
        mtSlotQueue.running++;
        resolve(() => {
          mtSlotQueue.running--;
          if (mtSlotQueue.waiters.length) mtSlotQueue.waiters.shift()();
        });
        return;
      }
      mtSlotQueue.waiters.push(tryAcquire);
    };
    tryAcquire();
  });
}

async function withMtSlot(config, fn) {
  const maxConcurrent = MT_MAX_CONCURRENT;
  const release = await acquireMtSlot(maxConcurrent);
  try {
    await waitForMtRateLimit();
    return await fn();
  } finally {
    release();
  }
}

async function waitForMtRateLimit() {
  const previous = mtRateLimitChain;
  let release;
  mtRateLimitChain = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  const now = Date.now();
  const waitMs = lastMtRequestAt + mtCurrentInterval - now;
  if (waitMs > 0) await sleep(waitMs);
  lastMtRequestAt = Date.now();
  release();
}

function sanitizeMtSegment(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function joinMtSegments(texts) {
  return texts.map((t, i) => `<<${i}>>${sanitizeMtSegment(t)}`).join('\n');
}

function splitMtTranslation(translated, expectedCount) {
  const parts = new Array(expectedCount);
  let matched = 0;

  for (let i = 0; i < expectedCount; i++) {
    const re = new RegExp(`<<${i}>>([\\s\\S]*?)(?=<<\\d+>>|$)`);
    const m = translated.match(re);
    if (m && m[1].trim()) {
      parts[i] = m[1].trim();
      matched++;
    }
  }
  if (matched === expectedCount) return parts;

  const byNewline = translated.split('\n').map((s) => s.trim()).filter(Boolean);
  if (byNewline.length === expectedCount) return byNewline;

  if (matched > 0) return parts;

  return null;
}

async function fillMissingMtParts(parts, texts, config, api, requestId, depth) {
  const filled = [...parts];
  for (let i = 0; i < filled.length; i++) {
    if (filled[i]?.trim()) continue;
    const [one] = await callMtTranslateBatch([texts[i]], config, api, `${requestId}-f${i}`, depth + 1, null);
    filled[i] = one;
  }
  return filled;
}

async function callMtTranslateBatch(texts, config, api, requestId, depth = 0, streamCallback = null) {
  if (texts.length === 1) {
    const wrapStream = streamCallback
      ? (updates) => streamCallback(updates.map((u) => ({ index: 0, text: u.text })))
      : null;
    return [await callMtTranslateAPI(texts[0], config, api, requestId, wrapStream, 1)];
  }

  const joined = joinMtSegments(texts);
  const wrapStream = streamCallback
    ? (updates) => streamCallback(updates)
    : null;
  const translated = await callMtTranslateAPI(joined, config, api, requestId, wrapStream, texts.length);
  const parts = splitMtTranslation(translated, texts.length);

  if (parts) {
    const hasMissing = parts.some((p) => !p?.trim());
    if (!hasMissing) return parts;
    return fillMissingMtParts(parts, texts, config, api, requestId, depth);
  }

  if (texts.length <= 3 || depth >= 1) {
    const results = [];
    for (let i = 0; i < texts.length; i++) {
      const [one] = await callMtTranslateBatch([texts[i]], config, api, `${requestId}-s${i}`, depth + 1, null);
      results.push(one);
    }
    return results;
  }

  const mid = Math.ceil(texts.length / 2);
  const left = await callMtTranslateBatch(texts.slice(0, mid), config, api, `${requestId}-L`, depth + 1, null);
  const right = await callMtTranslateBatch(texts.slice(mid), config, api, `${requestId}-R`, depth + 1, null);
  return [...left, ...right];
}

async function withRetry(fn, shouldRetry) {
  let lastError;
  for (let attempt = 0; attempt <= MT_RETRY_MAX; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      lastError = error;
      if (!shouldRetry(error) || attempt === MT_RETRY_MAX) throw error;
      const delay = isRateLimitError(error.message)
        ? MT_RETRY_BASE_MS * 2 ** attempt
        : MT_RETRY_BASE_MS;
      await sleep(Math.min(delay, 30000));
    }
  }
  throw lastError;
}

function splitLongText(text, maxChars = MT_MAX_INPUT_CHARS) {
  if (text.length <= maxChars) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf(' ', maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

function buildTranslationPrompt(text, targetLang) {
  return `将以下文本翻译成${targetLang}，只返回译文，不要解释：\n${text}`;
}

function extractJsonArray(content) {
  let text = content.trim();
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) text = codeBlockMatch[1].trim();

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    const start = text.indexOf('[');
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '[') depth++;
      else if (text[i] === ']') {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1));
            return Array.isArray(parsed) ? parsed : null;
          } catch {
            break;
          }
        }
      }
    }
    return null;
  }
}

function parseBatchTranslations(content, expectedLength) {
  const raw = extractJsonArray(content);
  if (!raw) throw new Error('无法解析模型返回的 JSON 数组');

  if (raw.length > 0 && raw.every((item) => typeof item === 'string')) {
    if (raw.length === expectedLength) return raw.map(String);
    throw new Error(`翻译数量不匹配：期望 ${expectedLength}，实际 ${raw.length}`);
  }

  const results = new Array(expectedLength);
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const idx = item.i ?? item.index ?? item.id ?? item.n;
    const text = item.t ?? item.text ?? item.s ?? item.translation ?? item.content;
    if (Number.isInteger(idx) && idx >= 0 && idx < expectedLength && text != null) {
      results[idx] = String(text);
    }
  }

  const missing = [];
  for (let i = 0; i < expectedLength; i++) {
    if (results[i] == null) missing.push(i);
  }
  if (missing.length === 0) return results;

  const err = new Error(`翻译数量不匹配：期望 ${expectedLength}，实际 ${expectedLength - missing.length}`);
  err.partialResults = results;
  err.missingIndices = missing;
  throw err;
}

function buildBatchMessages(texts, targetLang) {
  const items = texts.map((t, i) => ({ i, t }));
  return [
    {
      role: 'user',
      content:
        '你是翻译助手。只输出 JSON 数组，不要任何解释。' +
        '每项格式为 {"i":序号,"t":译文}，序号必须与输入一致，不得遗漏、合并或跳过。\n' +
        `将下列 JSON 中每项的 t 字段翻译成${targetLang}。` +
        `必须返回恰好 ${texts.length} 项，格式 [{"i":0,"t":"..."},...]：\n${JSON.stringify(items)}`
    }
  ];
}

function extractNewlyCompletedSegments(buffer, expectedCount, appliedSet) {
  const updates = [];
  for (let i = 0; i < expectedCount; i++) {
    if (appliedSet.has(i)) continue;
    const re = new RegExp(`<<${i}>>([\\s\\S]*?)(?=<<\\d+>>|$)`);
    const m = buffer.match(re);
    if (!m || !m[1].trim()) continue;
    if (i < expectedCount - 1) {
      if (buffer.includes(`<<${i + 1}>>`)) {
        updates.push({ index: i, text: m[1].trim() });
        appliedSet.add(i);
      }
    }
  }
  return updates;
}

async function readMtStream(response, onContent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let fullContent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content || '';
        if (delta) {
          fullContent += delta;
          onContent(fullContent);
        }
      } catch {
        // ignore malformed chunks
      }
    }
  }
  return fullContent.trim();
}

async function callMtTranslateAPI(text, config, api, requestId, streamCallback = null, segmentCount = 1) {
  const parts = splitLongText(text);
  const translatedParts = [];
  const appliedSegments = new Set();

  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    const partId = parts.length > 1 ? `${requestId}-p${p}` : requestId;
    const useStream = Boolean(streamCallback) && p === parts.length - 1;

    const translated = await withMtSlot(config, () =>
      withRetry(async () => {
        const controller = new AbortController();
        if (partId) abortControllers.set(partId, controller);

        const apiKey = await pickBailianApiKey(config);
        if (!apiKey) {
          throw new Error(`请先在设置中配置${api.providerName} API Key`);
        }

        try {
          const url = `${api.baseUrl.replace(/\/$/, '')}/chat/completions`;
          const timeoutId = setTimeout(() => controller.abort(), MT_FETCH_TIMEOUT_MS);
          const body = {
            model: api.model.trim(),
            messages: [{ role: 'user', content: part }],
            stream: useStream,
            translation_options: {
              source_lang: 'auto',
              target_lang: toMtTargetLang(config.targetLang)
            }
          };

          try {
            const response = await fetch(url, {
              method: 'POST',
              signal: controller.signal,
              headers: api.buildHeaders(apiKey),
              body: JSON.stringify(body)
            });

            if (!response.ok) {
              const data = await response.json().catch(() => ({}));
              const msg = data?.error?.message || data?.message || `HTTP ${response.status}`;
              if (isRateLimitError(msg, response.status)) noteMtRateLimited();
              throw new Error(formatApiError(msg, response.status));
            }

            if (useStream) {
              const content = await readMtStream(response, (full) => {
                if (segmentCount === 1) {
                  streamCallback([{ index: 0, text: full }]);
                  return;
                }
                const updates = extractNewlyCompletedSegments(full, segmentCount, appliedSegments);
                if (updates.length) streamCallback(updates);
              });
              noteMtRequestSuccess();
              if (segmentCount > 1) {
                const finalParts = splitMtTranslation(content, segmentCount);
                if (finalParts) {
                  for (let i = 0; i < finalParts.length; i++) {
                    const t = finalParts[i];
                    if (t?.trim() && !appliedSegments.has(i)) {
                      streamCallback([{ index: i, text: t }]);
                      appliedSegments.add(i);
                    }
                  }
                }
              }
              return content;
            }

            const data = await response.json();
            const content = data?.choices?.[0]?.message?.content;
            if (!content) throw new Error('模型未返回有效内容');
            noteMtRequestSuccess();
            return content.trim();
          } finally {
            clearTimeout(timeoutId);
          }
        } finally {
          if (partId) abortControllers.delete(partId);
        }
      }, (error) => isRateLimitError(error.message))
    );
    translatedParts.push(translated);
  }

  return translatedParts.join(parts.length > 1 ? '\n' : '');
}

async function callTranslateAPI(texts, config, requestId, streamCallback = null) {
  let api = resolveApiConfig(config);
  const modelId = (api.model || config.model || '').trim();

  if (isMtModel(modelId)) {
    return callMtTranslateBatch(texts, config, api, requestId, 0, streamCallback);
  }

  if (api.provider === 'bailian' && !getBailianApiKeys(config).length) {
    const hostedKey = await pickBailianApiKey(config);
    if (hostedKey) api = { ...api, apiKey: hostedKey };
  }

  const controller = new AbortController();
  if (requestId) abortControllers.set(requestId, controller);

  if (!api.apiKey) {
    throw new Error(`请先在设置中配置${api.providerName} API Key`);
  }

  try {
    const url = `${api.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const isSingle = texts.length === 1;

    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: api.buildHeaders(api.apiKey),
      body: JSON.stringify({
        model: modelId,
        messages: isSingle
          ? [{ role: 'user', content: buildTranslationPrompt(texts[0], config.targetLang) }]
          : buildBatchMessages(texts, config.targetLang),
        temperature: 0.1,
        ...api.extra
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error?.message || data?.message || `HTTP ${response.status}`);
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('模型未返回有效内容');

    if (isSingle) return [content.trim()];
    return parseBatchTranslations(content, texts.length);
  } finally {
    if (requestId) abortControllers.delete(requestId);
  }
}

function isRecoverableBatchError(error) {
  if (error.name === 'AbortError') return false;
  const msg = error.message || '';
  return (
    msg.includes('翻译数量不匹配') ||
    msg.includes('无法解析') ||
    msg.includes('JSON') ||
    Boolean(error.missingIndices?.length)
  );
}

async function fillMissingTranslations(texts, results, missingIndices, config, requestId) {
  const filled = [...results];
  for (const idx of missingIndices) {
    const partId = `${requestId}-m${idx}`;
    const [translated] = await callTranslateAPI([texts[idx]], config, partId);
    filled[idx] = translated;
  }
  return filled;
}

async function translateOneByOne(texts, config, requestId) {
  const results = [];
  for (let i = 0; i < texts.length; i++) {
    const [translated] = await callTranslateAPI([texts[i]], config, `${requestId}-s${i}`);
    results.push(translated);
  }
  return results;
}

async function translateMtTexts(texts, config, requestId) {
  return callMtTranslateBatch(texts, config, resolveApiConfig(config), requestId);
}

async function translateTextsReliable(texts, config, requestId, streamCallback = null) {
  if (!texts.length) return [];

  const modelId = (config.model || '').trim();
  const results = new Array(texts.length);
  const needIndices = [];
  const needTexts = [];

  for (let i = 0; i < texts.length; i++) {
    const cached = await getCachedTranslation(texts[i], config.targetLang, modelId);
    if (cached != null) {
      results[i] = cached;
      if (streamCallback) streamCallback([{ index: i, text: cached, cached: true }]);
    } else {
      needIndices.push(i);
      needTexts.push(texts[i]);
    }
  }

  if (!needTexts.length) return results;

  const mapStream = streamCallback
    ? (updates) => {
        streamCallback(
          updates.map((u) => ({
            index: needIndices[u.index],
            text: u.text,
            cached: false
          }))
        );
      }
    : null;

  let apiResults;
  if (isMtModel(modelId)) {
    try {
      apiResults = await callTranslateAPI(needTexts, config, requestId, mapStream);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (error.missingIndices?.length) {
        apiResults = await fillMissingTranslations(
          needTexts,
          error.partialResults,
          error.missingIndices,
          config,
          requestId
        );
      } else {
        throw error;
      }
    }
  } else {
    try {
      apiResults = await callTranslateAPI(needTexts, config, requestId, null);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (error.missingIndices?.length) {
        apiResults = await fillMissingTranslations(
          needTexts,
          error.partialResults,
          error.missingIndices,
          config,
          requestId
        );
      } else if (!isRecoverableBatchError(error)) {
        throw error;
      } else if (needTexts.length === 1) {
        throw error;
      } else if (needTexts.length <= 5) {
        apiResults = await translateOneByOne(needTexts, config, requestId);
      } else {
        const mid = Math.ceil(needTexts.length / 2);
        const left = await translateTextsReliable(needTexts.slice(0, mid), config, `${requestId}-L`, null);
        const right = await translateTextsReliable(needTexts.slice(mid), config, `${requestId}-R`, null);
        apiResults = [...left, ...right];
      }
    }
  }

  for (let j = 0; j < needTexts.length; j++) {
    results[needIndices[j]] = apiResults[j];
    if (isMtModel(modelId)) {
      await setCachedTranslation(needTexts[j], config.targetLang, modelId, apiResults[j]);
    }
  }
  return results;
}

async function translateBatch(texts, requestId, streamCallback = null) {
  const config = await getConfig();
  return translateTextsReliable(texts, config, requestId, streamCallback);
}

function cancelSession(sessionId) {
  for (const [id, controller] of abortControllers.entries()) {
    if (id.startsWith(`${sessionId}-`)) controller.abort();
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'arya-translate-page',
    title: 'Arya: Translate this page',
    contexts: ['page']
  });
  chrome.contextMenus.create({
    id: 'arya-translate-selection',
    title: 'Arya: Translate selection',
    contexts: ['selection']
  });
});

async function injectContentScripts(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/content.js']
  });
}

async function sendToTab(tabId, action, extra = {}) {
  try {
    return await chrome.tabs.sendMessage(tabId, { action, ...extra });
  } catch {
    await injectContentScripts(tabId);
    return chrome.tabs.sendMessage(tabId, { action, ...extra });
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://')) return;

  const actionMap = {
    'translate-page': 'translate',
    'translate-selection': 'translateSelection',
    'restore-page': 'restore'
  };
  const action = actionMap[command];
  if (action) await sendToTab(tab.id, action);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === 'arya-translate-page') {
    await sendToTab(tab.id, 'translate');
    return;
  }

  if (info.menuItemId === 'arya-translate-selection') {
    await sendToTab(tab.id, 'translateSelection', { selectionText: info.selectionText || '' });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'ping') {
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'translateBatch') {
    translateBatch(message.texts, message.requestId)
      .then((translations) => sendResponse({ success: true, translations }))
      .catch((error) => {
        const cancelled = error.name === 'AbortError';
        sendResponse({
          success: false,
          cancelled,
          error: cancelled ? '请求已取消' : error.message
        });
      });
    return true;
  }

  if (message.action === 'cancelSession') {
    cancelSession(message.sessionId);
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'getConfig') {
    getConfig().then(async (config) => {
      const api = resolveApiConfig(config);
      const canTranslate = await hasTranslationAccess(config);
      sendResponse({
        success: true,
        config: {
          targetLang: config.targetLang,
          model: config.model,
          provider: api.provider,
          providerName: api.providerName,
          modelName: getModelName(config.model),
          batchSize: config.batchSize,
          concurrency: config.concurrency,
          hasApiKey: canTranslate,
          usingHostedKey: canTranslate && isUsingHostedBailianKey(config),
          afdianPageUrl: getAfdianPageUrl()
        }
      });
    });
    return true;
  }

  if (message.action === 'openAfdianPage') {
    chrome.tabs.create({ url: getAfdianPageUrl(), active: true });
    sendResponse({ success: true });
    return true;
  }

  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'translate') return;

  port.onMessage.addListener((message) => {
    if (message.action !== 'translateBatch') return;

    translateBatch(message.texts, message.requestId, (segments) => {
      port.postMessage({ type: 'partial', segments });
    })
      .then((translations) => port.postMessage({ type: 'done', translations }))
      .catch((error) => {
        port.postMessage({
          type: 'error',
          cancelled: error.name === 'AbortError',
          error: error.name === 'AbortError' ? '请求已取消' : error.message
        });
      });
  });
});
