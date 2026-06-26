const modelSelect = document.getElementById('modelSelect');
const targetLangSelect = document.getElementById('targetLang');
const translateBtn = document.getElementById('translateBtn');
const translateSelectionBtn = document.getElementById('translateSelectionBtn');
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
  translateSelectionBtn.disabled = active;
  cancelBtn.classList.toggle('hidden', !active);
}

function formatUsage(result) {
  if (!result?.estimatedTokens) return '';
  return ` · 约 ${result.estimatedTokens.toLocaleString()} tokens`;
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
  const providerMap = { bailian: '百炼 / 通义', deepseek: 'DeepSeek', xiaomi: '小米 MiMo' };
  const providerName = providerMap[provider] || PROVIDERS[provider]?.name || '百炼';
  modelSubtitle.textContent = `${getModelName(modelId)} · ${providerName}`;
}

function updateAccessHint(config, modelId) {
  if (!config) return;

  const isBailianMt = getModelProvider(modelId) === 'bailian'
    && modelId?.trim().toLowerCase().startsWith('qwen-mt');

  if (config.usingHostedKey && isBailianMt) {
    paymentBanner.classList.remove('hidden');
    paymentBannerText.textContent = 'Arya 完全免费，欢迎支持作者 💙';
    upgradeBtn.textContent = '打赏';
    modelSubtitle.textContent = `${config.modelName || ''} · 免费`;
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
        showStatus(`请先在设置中配置 ${name} API Key`, 'error');
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
        showStatus('Arya 正在翻译…', 'info');
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

async function runTranslation(action) {
  setTranslating(true);
  showStatus('Arya 正在为你翻译… ✨', 'info');

  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error('无法访问当前标签页');

    if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://')) {
      throw new Error('无法翻译浏览器内置页面');
    }

    await chrome.storage.sync.set({
      targetLang: targetLangSelect.value,
      model: modelSelect.value
    });

    const result = await sendToContentScript(tab.id, action, {
      useCached: action === 'translateSelection'
    });

    if (result?.cancelled) {
      showStatus('Arya 已停止，下次见 👋', 'info');
    } else if (result?.success) {
      const usage = formatUsage(result);
      if (result.warning) {
        showStatus(`${result.warning}${usage}`, 'info');
      } else {
        showStatus(`完成！已翻译 ${result.count} 段${usage} ✓`, 'success');
      }
    } else {
      showStatus(result?.error || '翻译失败', 'error');
    }
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    setTranslating(false);
  }
}

translateBtn.addEventListener('click', () => runTranslation('translate'));
translateSelectionBtn.addEventListener('click', () => runTranslation('translateSelection'));

cancelBtn.addEventListener('click', async () => {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    await sendToContentScript(tab.id, 'cancel');
    showStatus('Arya 已停止，下次见 👋', 'info');
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
    showStatus('已恢复原文 ✓', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  }
});

settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

upgradeBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'openAfdianPage' });
});

init();
