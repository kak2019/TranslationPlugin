(function () {
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'CODE', 'PRE',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION'
  ]);

  const ARYA_PHRASES = [
    'Arya is translating...',
    'Let Arya be your eyes ✨',
    'Breaking language barriers...',
    'Reading the world for you...',
    'Arya is working her magic ✨',
    'Bridging languages, with love 💙',
    "Almost there, hold tight...",
    'Arya never gives up 💪',
    'Every word, carefully handled...',
    'Arya sees the world clearly 🌍',
  ];

  function getAryaPhrase() {
    return ARYA_PHRASES[Math.floor(Math.random() * ARYA_PHRASES.length)];
  }

  const translatedNodes = new WeakMap();
  let isTranslating = false;
  let cancelRequested = false;
  let sessionId = null;
  let batchCounter = 0;
  let overlayEl = null;

  function isVisible(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return true;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function shouldSkipNode(node) {
    if (translatedNodes.has(node)) return true;
    let parent = node.parentElement;
    while (parent) {
      if (SKIP_TAGS.has(parent.tagName)) return true;
      if (!isVisible(parent)) return true;
      parent = parent.parentElement;
    }
    return false;
  }

  function ensureOverlayStyles() {
    if (document.getElementById('bailian-translate-styles')) return;
    const style = document.createElement('style');
    style.id = 'bailian-translate-styles';
    style.textContent = `
      #bailian-translate-overlay {
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        pointer-events: none;
      }
      .bailian-overlay-card {
        pointer-events: auto;
        background: rgba(255,255,255,0.97); border-radius: 12px; padding: 10px 14px;
        min-width: 200px; max-width: 260px;
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
      .bailian-overlay-bar { height: 3px; background: #eee; border-radius: 2px; overflow: hidden; }
      .bailian-overlay-fill { height: 100%; background: linear-gradient(90deg, #6366f1, #8b5cf6); width: 0%; transition: width 0.3s; }
    `;
    document.head.appendChild(style);
  }

  function showOverlay(message, progress) {
    ensureOverlayStyles();
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.id = 'bailian-translate-overlay';
      overlayEl.innerHTML = `
        <div class="bailian-overlay-card">
          <div class="bailian-overlay-header">
            <div class="bailian-overlay-title">Arya Translate</div>
            <button class="bailian-overlay-close" type="button" title="Cancel">×</button>
          </div>
          <div class="bailian-overlay-message"></div>
          <div class="bailian-overlay-bar"><div class="bailian-overlay-fill"></div></div>
        </div>
      `;
      document.documentElement.appendChild(overlayEl);
      overlayEl.querySelector('.bailian-overlay-close').addEventListener('click', cancelTranslation);
    }

    overlayEl.querySelector('.bailian-overlay-message').textContent = message;
    overlayEl.querySelector('.bailian-overlay-fill').style.width = `${progress}%`;
    overlayEl.style.display = 'block';
  }

  function hideOverlay() {
    if (overlayEl) overlayEl.style.display = 'none';
  }

  function showCancelledAndHide() {
    if (overlayEl) {
      overlayEl.querySelector('.bailian-overlay-message').textContent = 'Arya stopped. See you next time 👋';
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

  async function collectTextNodesAsync(onProgress) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.textContent.trim();
        if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
        if (shouldSkipNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const nodes = [];
    let scanned = 0;
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
      scanned++;
      if (scanned % 400 === 0) {
        onProgress(`Arya is scanning... ${scanned} segments found`);
        await yieldToMain();
      }
    }
    return nodes;
  }

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(
        { batchSize: 40, concurrency: 4, model: 'qwen-mt-flash' },
        (stored) => {
          const isMt = stored.model?.trim().toLowerCase().startsWith('qwen-mt');
          resolve({
            batchSize: Number(stored.batchSize) || 40,
            concurrency: Number(stored.concurrency) || 4,
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
    node.textContent = translated;
  }

  function restoreOriginal() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const original = translatedNodes.get(node);
      if (original !== undefined) {
        node.textContent = original;
        translatedNodes.delete(node);
      }
    }
  }

  function cancelTranslation() {
    cancelRequested = true;
    if (sessionId) {
      chrome.runtime.sendMessage({ action: 'cancelSession', sessionId });
    }
    showCancelledAndHide();
  }

  async function runConcurrent(batches, concurrency, onProgress, ctx) {
    const { textToNodes, uniqueTexts, totalNodes, isMt } = ctx;
    let completedNodes = 0;
    const failedBatches = [];
    const appliedUnique = new Set();

    function markApplied(uniqueIdx, translated) {
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
        heartbeatId = startBatchHeartbeat(batchIndex, batches.length, (idx, total, elapsed, phrase) => {
          if (cancelRequested) return;
          showOverlay(
            phrase || getAryaPhrase(),
            Math.round((completedNodes / Math.max(totalNodes, 1)) * 100)
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

  async function translatePage() {
    if (isTranslating) return { success: false, error: '正在翻译中，请稍候' };

    isTranslating = true;
    cancelRequested = false;
    sessionId = String(Date.now());
    batchCounter = 0;

    try {
      const settings = await getSettings();
      const textNodes = await collectTextNodesAsync(() => {});
      if (textNodes.length === 0) {
        return { success: false, error: '未找到可翻译的文本' };
      }

      const { uniqueTexts, textToNodes, totalNodes } = buildUniqueTextPlan(textNodes);
      const ctx = { textToNodes, uniqueTexts, totalNodes, isMt: settings.isMt };

      const batches = settings.isMt
        ? chunkUniqueTexts(uniqueTexts)
        : chunkUniqueByCount(uniqueTexts, settings.batchSize);
      const concurrency = settings.concurrency;

      const dedupHint = uniqueTexts.length < totalNodes
        ? `（去重 ${totalNodes}→${uniqueTexts.length}）`
        : '';
      showOverlay(getAryaPhrase(), 0);

      const { completed, failedBatches } = await runConcurrent(
        batches,
        concurrency,
        (done, totalBatches, batchIndex, failCount = 0) => {
          if (cancelRequested) return;
          showOverlay(
            failCount
              ? `Retrying ${failCount} batch(es)... ${done}/${totalNodes}`
              : getAryaPhrase(),
            Math.round((done / totalNodes) * 100)
          );
        },
        ctx
      );

      if (cancelRequested) {
        return { success: false, cancelled: true, error: '翻译已取消' };
      }

      let finalFailed = failedBatches;
      if (failedBatches.length > 0) {
        showOverlay(`Arya is trying again... 💪`, Math.round((completed / totalNodes) * 100));
        const retryResult = await retryFailedBatches(
          failedBatches,
          (recovered, total, idx, stillCount, nodeTotal) => {
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
        return n + b.globalIndices.reduce((sum, idx) => sum + (textToNodes.get(uniqueTexts[idx])?.length || 0), 0);
      }, 0);
      const successCount = totalNodes - failedNodeCount;

      if (finalFailed.length > 0) {
        showOverlay(`Done! ${successCount}/${totalNodes} translated ✓`, 100);
        setTimeout(hideOverlay, 1500);
        return {
          success: true,
          count: successCount,
          failed: failedNodeCount,
          warning: `${failedNodeCount} 段因 API 限流未能翻译，请稍后重试`
        };
      }

      showOverlay("Done! Arya got your back ✓", 100);
      setTimeout(hideOverlay, 1000);
      return { success: true, count: totalNodes };
    } catch (error) {
      if (!cancelRequested) hideOverlay();
      return { success: false, error: error.message };
    } finally {
      isTranslating = false;
      cancelRequested = false;
      sessionId = null;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'translate') {
      translatePage().then(sendResponse);
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
      sendResponse({ isTranslating });
      return true;
    }
    return false;
  });
})();
