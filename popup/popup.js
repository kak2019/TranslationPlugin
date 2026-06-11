const modelSelect = document.getElementById('modelSelect');
const targetLangSelect = document.getElementById('targetLang');
const translateBtn = document.getElementById('translateBtn');
const cancelBtn = document.getElementById('cancelBtn');
const restoreBtn = document.getElementById('restoreBtn');
const statusEl = document.getElementById('status');
const settingsLink = document.getElementById('settingsLink');
const modelSubtitle = document.getElementById('modelSubtitle');
const paymentBanner = document.getElementById('paymentBanner');
const paymentBannerText = document.getElementById('paymentBannerText');
const upgradeBtn = document.getElementById('upgradeBtn');

function showStatus(message, type = 'info') {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

function setTranslating(active) {
  translateBtn.disabled = active;
  cancelBtn.classList.toggle('hidden', !active);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToContentScript(tabId, action, extra = {}) {
  try {
    return await chrome.tabs.sendMessage(tabId, { action, ...extra });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js']
    });
    return chrome.tabs.sendMessage(tabId, { action, ...extra });
  }
}

function updateModelHint(modelId) {
  const provider = getModelProvider(modelId);
  const providerMap = { bailian: 'Qwen / Bailian', deepseek: 'DeepSeek', xiaomi: 'MiMo' };
  const providerName = providerMap[provider] || PROVIDERS[provider]?.name || 'Bailian';
  modelSubtitle.textContent = `${getModelName(modelId)} · ${providerName}`;
}

function updateAccessHint(config, modelId) {
  if (!config) return;

  const isBailianMt = getModelProvider(modelId) === 'bailian'
    && modelId?.trim().toLowerCase().startsWith('qwen-mt');

  if (config.usingHostedKey && isBailianMt) {
    paymentBanner.classList.remove('hidden');
    paymentBannerText.textContent = 'Arya is free! Support the author 💙';
    upgradeBtn.textContent = 'Donate';
    modelSubtitle.textContent = `${config.modelName || ''} · Free`;
    return;
  }

  paymentBanner.classList.add('hidden');
}

async function init() {
  const stored = await chrome.storage.sync.get({
    targetLang: '简体中文',
    model: 'qwen-mt-flash'
  });

  populateModelSelect(modelSelect, stored.model);
  targetLangSelect.value = stored.targetLang;
  updateModelHint(stored.model);

  chrome.runtime.sendMessage({ action: 'getConfig' }, (response) => {
    const config = response?.config;
    if (!config?.hasApiKey) {
      const provider = getModelProvider(stored.model);
      const isBailianMt = provider === 'bailian' && stored.model?.trim().toLowerCase().startsWith('qwen-mt');
      if (!isBailianMt) {
        const name = PROVIDERS[provider]?.name || '对应厂商';
        showStatus(`Please set up your ${name} API Key in Settings`, 'error');
      }
    }
    updateAccessHint(config, stored.model);
  });

  const tab = await getActiveTab();
  if (tab?.id) {
    try {
      const state = await sendToContentScript(tab.id, 'getTranslating');
      if (state?.isTranslating) {
        setTranslating(true);
        showStatus('Arya is translating...', 'info');
      }
    } catch {
      // ignore
    }
  }
}

modelSelect.addEventListener('change', () => {
  chrome.storage.sync.set({ model: modelSelect.value });
  updateModelHint(modelSelect.value);
});

targetLangSelect.addEventListener('change', () => {
  chrome.storage.sync.set({ targetLang: targetLangSelect.value });
});

translateBtn.addEventListener('click', async () => {
  setTranslating(true);
  showStatus('Let Arya be your eyes... ✨', 'info');

  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error('Cannot access current tab');

    if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://')) {
      throw new Error('Cannot translate built-in browser pages');
    }

    await chrome.storage.sync.set({
      targetLang: targetLangSelect.value,
      model: modelSelect.value
    });

    const result = await sendToContentScript(tab.id, 'translate');

    if (result?.cancelled) {
      showStatus('Arya stopped. See you next time 👋', 'info');
    } else if (result?.success) {
      if (result.warning) {
        showStatus(result.warning, 'info');
      } else {
        showStatus(`Done! Arya translated ${result.count} segments ✓`, 'success');
      }
    } else {
      showStatus(result?.error || 'Translation failed', 'error');
    }
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    setTranslating(false);
  }
});

cancelBtn.addEventListener('click', async () => {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    await sendToContentScript(tab.id, 'cancel');
    showStatus('Arya stopped. See you next time 👋', 'info');
    setTranslating(false);
  } catch (error) {
    showStatus(error.message, 'error');
  }
});

restoreBtn.addEventListener('click', async () => {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    await sendToContentScript(tab.id, 'restore');
    showStatus('Original text restored ✓', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  }
});

settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

upgradeBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'openAfdianPage' }); // open donation page
});

init();
