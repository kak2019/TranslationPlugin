const wordbookSearchInput = document.getElementById('wordbookSearch');
const wordbookMetaEl = document.getElementById('wordbookMeta');
const wordbookListEl = document.getElementById('wordbookList');
const wordbookSyncBtn = document.getElementById('wordbookSyncBtn');
const wordbookSyncStatus = document.getElementById('wordbookSyncStatus');
const ossBucketInput = document.getElementById('ossBucket');
const ossRegionInput = document.getElementById('ossRegion');
const ossAccessKeyIdInput = document.getElementById('ossAccessKeyId');
const ossAccessKeySecretInput = document.getElementById('ossAccessKeySecret');
const ossObjectKeyInput = document.getElementById('ossObjectKey');
const ossSaveBtn = document.getElementById('ossSaveBtn');
const reviewStartBtn = document.getElementById('reviewStartBtn');
const reviewCard = document.getElementById('reviewCard');
const reviewEnEl = document.getElementById('reviewEn');
const reviewZhEl = document.getElementById('reviewZh');
const reviewRevealBtn = document.getElementById('reviewRevealBtn');
const reviewSpeakBtn = document.getElementById('reviewSpeakBtn');
const reviewNextBtn = document.getElementById('reviewNextBtn');
const reviewExitBtn = document.getElementById('reviewExitBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');

let wordbookEntries = [];
let reviewCurrent = null;
let reviewRevealed = false;

function speakWordbookText(text, lang) {
  if (!text || !window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang;
    window.speechSynthesis.speak(utter);
  } catch {
    // ignore
  }
}

function setWordbookSyncStatus(text, ok) {
  wordbookSyncStatus.textContent = text;
  wordbookSyncStatus.style.color = ok ? '#059669' : '#b45309';
}

function sourceHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function csvCell(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function renderWordbookList() {
  const query = (wordbookSearchInput.value || '').trim().toLowerCase();
  const filtered = wordbookEntries.filter((item) => {
    if (!query) return true;
    const host = sourceHost(item.sourceUrl);
    return `${item.en} ${item.zh} ${host}`.toLowerCase().includes(query);
  });
  wordbookMetaEl.textContent = query
    ? `显示 ${filtered.length} / ${wordbookEntries.length} 条`
    : `共 ${wordbookEntries.length} 条`;
  if (!filtered.length) {
    wordbookListEl.innerHTML = `<div class="wordbook-empty">${
      wordbookEntries.length ? '没有匹配的单词' : '还没有单词。在网页上划选英文单词，悬停粉点即可收录。'
    }</div>`;
    return;
  }
  wordbookListEl.innerHTML = '';
  filtered.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'wordbook-row';
    row.innerHTML = `
      <div>
        <div class="wordbook-en"></div>
        <a class="wordbook-source" target="_blank" rel="noopener" hidden></a>
      </div>
      <div class="wordbook-zh"></div>
      <div class="wordbook-actions">
        <button type="button" data-act="speak-en" title="朗读英文">英</button>
        <button type="button" data-act="speak-zh" title="朗读中文">中</button>
        <button type="button" data-act="delete" title="删除">删</button>
      </div>
    `;
    row.querySelector('.wordbook-en').textContent = item.en;
    row.querySelector('.wordbook-zh').textContent = item.zh || '（无译文）';
    const sourceEl = row.querySelector('.wordbook-source');
    const host = sourceHost(item.sourceUrl);
    if (host && item.sourceUrl) {
      sourceEl.hidden = false;
      sourceEl.href = item.sourceUrl;
      sourceEl.textContent = host;
      sourceEl.title = item.sourceUrl;
    }
    row.querySelector('[data-act="speak-en"]').addEventListener('click', () => {
      speakWordbookText(item.en, 'en-US');
    });
    row.querySelector('[data-act="speak-zh"]').addEventListener('click', () => {
      if (!item.zh) return;
      speakWordbookText(item.zh, 'zh-CN');
    });
    row.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      const response = await chrome.runtime.sendMessage({ action: 'wordbookDelete', id: item.id });
      if (response?.success) {
        wordbookEntries = wordbookEntries.filter((entry) => entry.id !== item.id);
        renderWordbookList();
      }
    });
    wordbookListEl.appendChild(row);
  });
}

function reviewableEntries() {
  return wordbookEntries.filter((item) => item.en && item.zh);
}

function pickReviewEntry() {
  const pool = reviewableEntries();
  if (!pool.length) return null;
  if (pool.length === 1) return pool[0];
  let next = pool[Math.floor(Math.random() * pool.length)];
  if (reviewCurrent && next.id === reviewCurrent.id) {
    next = pool[(pool.findIndex((item) => item.id === next.id) + 1) % pool.length];
  }
  return next;
}

function renderReviewCard() {
  if (!reviewCurrent) return;
  reviewEnEl.textContent = reviewCurrent.en;
  reviewZhEl.textContent = reviewRevealed ? reviewCurrent.zh : '　　　　　　';
  reviewZhEl.classList.toggle('masked', !reviewRevealed);
  reviewRevealBtn.textContent = reviewRevealed ? '已显示' : '显示中文';
}

function startReview() {
  const next = pickReviewEntry();
  if (!next) {
    setWordbookSyncStatus('单词本还没有带中文的词，先去划几个英文单词', false);
    return;
  }
  reviewCurrent = next;
  reviewRevealed = false;
  reviewCard.hidden = false;
  renderReviewCard();
  reviewCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function exportJson() {
  const payload = {
    version: 1,
    exportedAt: Date.now(),
    entries: wordbookEntries.map((item) => ({
      en: item.en,
      zh: item.zh,
      sourceUrl: item.sourceUrl || '',
      addedAt: item.addedAt,
      updatedAt: item.updatedAt
    }))
  };
  downloadFile(
    `arya-wordbook-${new Date().toISOString().slice(0, 10)}.json`,
    `${JSON.stringify(payload, null, 2)}\n`,
    'application/json;charset=utf-8'
  );
}

function exportCsv() {
  const header = ['en', 'zh', 'sourceUrl', 'addedAt'];
  const rows = wordbookEntries.map((item) => [
    csvCell(item.en),
    csvCell(item.zh),
    csvCell(item.sourceUrl || ''),
    csvCell(item.addedAt ? new Date(item.addedAt).toISOString() : '')
  ].join(','));
  downloadFile(
    `arya-wordbook-${new Date().toISOString().slice(0, 10)}.csv`,
    `\uFEFF${header.join(',')}\n${rows.join('\n')}\n`,
    'text/csv;charset=utf-8'
  );
}

async function loadWordbookList() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'wordbookList' });
    wordbookEntries = Array.isArray(response?.entries) ? response.entries : [];
    if (response?.ossError) setWordbookSyncStatus(response.ossError, false);
  } catch {
    wordbookEntries = [];
  }
  renderWordbookList();
}

async function fillMissingZh() {
  const missing = wordbookEntries.filter((item) => !/[\u4e00-\u9fff]/.test(item.zh || ''));
  if (!missing.length) return;
  setWordbookSyncStatus('正在补全中文译文…', true);
  try {
    const response = await chrome.runtime.sendMessage({ action: 'wordbookFillMissing' });
    if (response?.success) {
      wordbookEntries = Array.isArray(response.entries) ? response.entries : wordbookEntries;
      renderWordbookList();
      if (response.filled) setWordbookSyncStatus(`已补全 ${response.filled} 条中文译文`, true);
      else setWordbookSyncStatus('', true);
    } else {
      setWordbookSyncStatus(response?.error || '补全译文失败', false);
    }
  } catch (error) {
    setWordbookSyncStatus(error.message || '补全译文失败', false);
  }
}

async function loadOssSettings() {
  const stored = await chrome.storage.sync.get({
    ossBucket: '',
    ossRegion: '',
    ossAccessKeyId: '',
    ossAccessKeySecret: '',
    ossObjectKey: 'arya-translate/wordbook.json'
  });
  ossBucketInput.value = stored.ossBucket || '';
  ossRegionInput.value = stored.ossRegion || '';
  ossAccessKeyIdInput.value = stored.ossAccessKeyId || '';
  ossAccessKeySecretInput.value = stored.ossAccessKeySecret || '';
  ossObjectKeyInput.value = stored.ossObjectKey || 'arya-translate/wordbook.json';
}

async function saveOssSettings() {
  await chrome.storage.sync.set({
    ossBucket: ossBucketInput.value.trim(),
    ossRegion: ossRegionInput.value.trim(),
    ossAccessKeyId: ossAccessKeyIdInput.value.trim(),
    ossAccessKeySecret: ossAccessKeySecretInput.value.trim(),
    ossObjectKey: ossObjectKeyInput.value.trim() || 'arya-translate/wordbook.json'
  });
}

async function syncWordbookNow() {
  setWordbookSyncStatus('同步中…', true);
  try {
    const response = await chrome.runtime.sendMessage({ action: 'wordbookSync' });
    if (response?.success && response.skipped) {
      setWordbookSyncStatus('未配置 OSS，仅保存在本机', true);
    } else if (response?.success) {
      wordbookEntries = Array.isArray(response.entries) ? response.entries : wordbookEntries;
      renderWordbookList();
      setWordbookSyncStatus(`已同步，共 ${wordbookEntries.length} 条`, true);
    } else {
      setWordbookSyncStatus(response?.error || '同步失败', false);
    }
  } catch (error) {
    setWordbookSyncStatus(error.message || '同步失败', false);
  }
}

wordbookSearchInput.addEventListener('input', renderWordbookList);
reviewStartBtn.addEventListener('click', startReview);
reviewRevealBtn.addEventListener('click', () => {
  if (!reviewCurrent) return;
  reviewRevealed = true;
  renderReviewCard();
});
reviewZhEl.addEventListener('click', () => {
  if (!reviewCurrent || reviewRevealed) return;
  reviewRevealed = true;
  renderReviewCard();
});
reviewSpeakBtn.addEventListener('click', () => {
  if (!reviewCurrent) return;
  speakWordbookText(reviewCurrent.en, 'en-US');
});
reviewNextBtn.addEventListener('click', () => {
  const next = pickReviewEntry();
  if (!next) return;
  reviewCurrent = next;
  reviewRevealed = false;
  renderReviewCard();
});
reviewExitBtn.addEventListener('click', () => {
  reviewCard.hidden = true;
  reviewCurrent = null;
});
exportJsonBtn.addEventListener('click', exportJson);
exportCsvBtn.addEventListener('click', exportCsv);
ossSaveBtn.addEventListener('click', async () => {
  await saveOssSettings();
  setWordbookSyncStatus('同步设置已保存', true);
  if (
    ossBucketInput.value.trim()
    && ossRegionInput.value.trim()
    && ossAccessKeyIdInput.value.trim()
    && ossAccessKeySecretInput.value.trim()
  ) {
    await syncWordbookNow();
  }
});
wordbookSyncBtn.addEventListener('click', syncWordbookNow);

loadOssSettings();
loadWordbookList().then(fillMissingZh);
