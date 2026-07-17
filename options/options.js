const DONATION_QR_URL = 'https://flyntpan.oss-cn-beijing.aliyuncs.com/pic/wechatpay.jpg';
const DONATION_QR_VERSION = 1;
const GLOSSARY_MAX = 80;
const SITE_RULES_MAX = 50;

const REGION_URLS = {
  cn: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  intl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  hk: 'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1'
};

const apiKeyInput = document.getElementById('apiKey');
const apiKey2Input = document.getElementById('apiKey2');
const deepseekApiKeyInput = document.getElementById('deepseekApiKey');
const xiaomiApiKeyInput = document.getElementById('xiaomiApiKey');
const regionSelect = document.getElementById('region');
const modelSelect = document.getElementById('modelSelect');
const batchSizeSelect = document.getElementById('batchSize');
const concurrencySelect = document.getElementById('concurrency');
const autoTranslateInput = document.getElementById('autoTranslate');
const bilingualModeInput = document.getElementById('bilingualMode');
const showFloatBallInput = document.getElementById('showFloatBall');
const showSelectionDotInput = document.getElementById('showSelectionDot');
const showInputTranslateInput = document.getElementById('showInputTranslate');
const selectionDelayMsInput = document.getElementById('selectionDelayMs');
const selectionMinLengthInput = document.getElementById('selectionMinLength');
const glossaryListEl = document.getElementById('glossaryList');
const siteRulesListEl = document.getElementById('siteRulesList');
const addGlossaryBtn = document.getElementById('addGlossaryBtn');
const addSiteRuleBtn = document.getElementById('addSiteRuleBtn');
const clearCacheBtn = document.getElementById('clearCacheBtn');
const clearCacheStatus = document.getElementById('clearCacheStatus');
const saveBtn = document.getElementById('saveBtn');
const saveStatus = document.getElementById('saveStatus');
const donateQrImg = document.getElementById('donateQr');
const donateQrError = document.getElementById('donateQrError');
const afdianBtn = document.getElementById('afdianBtn');
const afdianLink = document.getElementById('afdianLink');

function urlToRegion(url) {
  for (const [region, regionUrl] of Object.entries(REGION_URLS)) {
    if (url === regionUrl) return region;
  }
  return 'cn';
}

function openAfdianPage() {
  chrome.runtime.sendMessage({ action: 'openAfdianPage' });
}

function loadDonationQr() {
  if (!donateQrImg) return;

  const separator = DONATION_QR_URL.includes('?') ? '&' : '?';
  donateQrImg.src = `${DONATION_QR_URL}${separator}v=${DONATION_QR_VERSION}`;

  donateQrImg.onload = () => {
    donateQrError.style.display = 'none';
  };

  donateQrImg.onerror = () => {
    donateQrError.style.display = 'block';
    donateQrError.textContent = '微信收款码暂时无法加载，请稍后再试。';
  };
}

function initAfdianLinks() {
  const pageUrl = getAfdianPageUrl();
  if (afdianLink) {
    afdianLink.href = pageUrl;
    afdianLink.textContent = pageUrl.replace('https://', '');
  }
}

function triValue(v) {
  if (v === true || v === 'true') return 'true';
  if (v === false || v === 'false') return 'false';
  return 'inherit';
}

function parseTri(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function createGlossaryRow(item = { from: '', to: '' }) {
  const row = document.createElement('div');
  row.className = 'glossary-row table-row';
  row.innerHTML = `
    <input type="text" class="glossary-from" placeholder="Cursor" value="">
    <input type="text" class="glossary-to" placeholder="Cursor" value="">
    <button type="button" class="btn-icon glossary-remove" title="删除">×</button>
  `;
  row.querySelector('.glossary-from').value = item.from || '';
  row.querySelector('.glossary-to').value = item.to || '';
  row.querySelector('.glossary-remove').addEventListener('click', () => {
    row.remove();
  });
  glossaryListEl.appendChild(row);
}

function createSiteRuleCard(rule = {}) {
  const card = document.createElement('div');
  card.className = 'site-rule';
  card.innerHTML = `
    <div class="field" style="margin-bottom:10px">
      <label>域名</label>
      <input type="text" class="site-host" placeholder="docs.example.com" value="">
    </div>
    <div class="tri-row">
      <label>双语对照</label>
      <select class="site-bilingual">
        <option value="inherit">跟随全局</option>
        <option value="true">开</option>
        <option value="false">关</option>
      </select>
    </div>
    <div class="tri-row">
      <label>Watch 补译</label>
      <select class="site-watch">
        <option value="inherit">跟随全局</option>
        <option value="true">开</option>
        <option value="false">关</option>
      </select>
    </div>
    <div class="tri-row">
      <label>自动翻译</label>
      <select class="site-auto">
        <option value="inherit">跟随全局</option>
        <option value="true">开</option>
        <option value="false">关</option>
      </select>
    </div>
    <div class="field" style="margin-bottom:10px;margin-top:4px">
      <label>跳过选择器</label>
      <input type="text" class="site-skip" placeholder=".sidebar, [data-notranslate]" value="">
    </div>
    <button type="button" class="btn-secondary site-remove">删除此规则</button>
  `;
  card.querySelector('.site-host').value = rule.host || '';
  card.querySelector('.site-bilingual').value = triValue(rule.bilingualMode);
  card.querySelector('.site-watch').value = triValue(rule.watchMode);
  card.querySelector('.site-auto').value = triValue(rule.autoTranslate);
  card.querySelector('.site-skip').value = rule.skipSelectors || '';
  card.querySelector('.site-remove').addEventListener('click', () => card.remove());
  siteRulesListEl.appendChild(card);
}

function collectGlossary() {
  const rows = [...glossaryListEl.querySelectorAll('.glossary-row')];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const from = row.querySelector('.glossary-from')?.value.trim() || '';
    const to = row.querySelector('.glossary-to')?.value.trim() || '';
    if (!from || !to || seen.has(from)) continue;
    seen.add(from);
    out.push({ from, to });
    if (out.length >= GLOSSARY_MAX) break;
  }
  return out;
}

function collectSiteRules() {
  const cards = [...siteRulesListEl.querySelectorAll('.site-rule')];
  const out = [];
  const seen = new Set();
  for (const card of cards) {
    const host = (card.querySelector('.site-host')?.value || '')
      .trim()
      .toLowerCase()
      .replace(/^\*\./, '')
      .replace(/^https?:\/\//, '')
      .split('/')[0];
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push({
      host,
      bilingualMode: parseTri(card.querySelector('.site-bilingual')?.value),
      watchMode: parseTri(card.querySelector('.site-watch')?.value),
      autoTranslate: parseTri(card.querySelector('.site-auto')?.value),
      skipSelectors: card.querySelector('.site-skip')?.value.trim() || ''
    });
    if (out.length >= SITE_RULES_MAX) break;
  }
  return out;
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get({
    apiKey: '',
    apiKey2: '',
    baseUrl: REGION_URLS.cn,
    deepseekApiKey: '',
    xiaomiApiKey: '',
    model: 'qwen-mt-flash',
    batchSize: 40,
    concurrency: 4,
    autoTranslate: false,
    showFloatBall: true,
    showSelectionDot: true,
    showInputTranslate: true,
    bilingualMode: false,
    glossary: [],
    siteRules: [],
    selectionDelayMs: 280,
    selectionMinLength: 4
  });

  apiKeyInput.value = stored.apiKey;
  apiKey2Input.value = stored.apiKey2 || '';
  deepseekApiKeyInput.value = stored.deepseekApiKey || '';
  xiaomiApiKeyInput.value = stored.xiaomiApiKey || '';
  populateModelSelect(modelSelect, stored.model);
  regionSelect.value = urlToRegion(stored.baseUrl);
  batchSizeSelect.value = String(stored.batchSize);
  concurrencySelect.value = String(stored.concurrency);
  autoTranslateInput.checked = Boolean(stored.autoTranslate);
  bilingualModeInput.checked = Boolean(stored.bilingualMode);
  showFloatBallInput.checked = stored.showFloatBall !== false;
  showSelectionDotInput.checked = stored.showSelectionDot !== false;
  showInputTranslateInput.checked = stored.showInputTranslate !== false;
  selectionDelayMsInput.value = String(Math.max(0, Number(stored.selectionDelayMs) || 280));
  selectionMinLengthInput.value = String(Math.max(1, Number(stored.selectionMinLength) || 4));

  glossaryListEl.innerHTML = '';
  const glossary = Array.isArray(stored.glossary) ? stored.glossary : [];
  if (glossary.length) {
    glossary.slice(0, GLOSSARY_MAX).forEach((item) => createGlossaryRow(item));
  } else {
    createGlossaryRow();
  }

  siteRulesListEl.innerHTML = '';
  const siteRules = Array.isArray(stored.siteRules) ? stored.siteRules : [];
  if (siteRules.length) {
    siteRules.slice(0, SITE_RULES_MAX).forEach((rule) => createSiteRuleCard(rule));
  }
}

addGlossaryBtn.addEventListener('click', () => {
  if (glossaryListEl.querySelectorAll('.glossary-row').length >= GLOSSARY_MAX) {
    saveStatus.textContent = `术语最多 ${GLOSSARY_MAX} 条`;
    saveStatus.style.color = '#b45309';
    return;
  }
  createGlossaryRow();
});

addSiteRuleBtn.addEventListener('click', () => {
  if (siteRulesListEl.querySelectorAll('.site-rule').length >= SITE_RULES_MAX) {
    saveStatus.textContent = `站点规则最多 ${SITE_RULES_MAX} 条`;
    saveStatus.style.color = '#b45309';
    return;
  }
  createSiteRuleCard();
});

clearCacheBtn.addEventListener('click', async () => {
  clearCacheStatus.textContent = '清除中…';
  clearCacheStatus.style.color = '#64748b';
  try {
    const response = await chrome.runtime.sendMessage({ action: 'clearTranslationCache' });
    if (response?.success) {
      clearCacheStatus.textContent = `已清除 ${response.removed || 0} 条`;
      clearCacheStatus.style.color = '#059669';
    } else {
      clearCacheStatus.textContent = response?.error || '清除失败';
      clearCacheStatus.style.color = '#b45309';
    }
  } catch (error) {
    clearCacheStatus.textContent = error.message || '清除失败';
    clearCacheStatus.style.color = '#b45309';
  }
  setTimeout(() => { clearCacheStatus.textContent = ''; }, 2500);
});

saveBtn.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  const apiKey2 = apiKey2Input.value.trim();
  const deepseekApiKey = deepseekApiKeyInput.value.trim();
  const xiaomiApiKey = xiaomiApiKeyInput.value.trim();
  const model = modelSelect.value || 'qwen-mt-flash';
  const baseUrl = REGION_URLS[regionSelect.value];
  const batchSize = Number(batchSizeSelect.value);
  const concurrency = Number(concurrencySelect.value);
  const autoTranslate = autoTranslateInput.checked;
  const bilingualMode = bilingualModeInput.checked;
  const showFloatBall = showFloatBallInput.checked;
  const showSelectionDot = showSelectionDotInput.checked;
  const showInputTranslate = showInputTranslateInput.checked;
  const selectionDelayMs = Math.max(0, Math.min(2000, Number(selectionDelayMsInput.value) || 280));
  const selectionMinLength = Math.max(1, Math.min(50, Number(selectionMinLengthInput.value) || 4));
  const glossary = collectGlossary();
  const siteRules = collectSiteRules();

  await chrome.storage.sync.set({
    apiKey,
    apiKey2,
    baseUrl,
    deepseekApiKey,
    xiaomiApiKey,
    model,
    batchSize,
    concurrency,
    autoTranslate,
    bilingualMode,
    showFloatBall,
    showSelectionDot,
    showInputTranslate,
    selectionDelayMs,
    selectionMinLength,
    glossary,
    siteRules
  });

  saveStatus.textContent = '已保存';
  saveStatus.style.color = '#059669';
  setTimeout(() => { saveStatus.textContent = ''; }, 2000);
});

afdianBtn.addEventListener('click', openAfdianPage);

loadSettings();
loadDonationQr();
initAfdianLinks();
