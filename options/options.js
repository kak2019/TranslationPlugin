const DONATION_QR_URL = 'https://flyntpan.oss-cn-beijing.aliyuncs.com/pic/wechatpay.jpg';
const DONATION_QR_VERSION = 1;

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
    autoTranslate: false
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
}

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

  await chrome.storage.sync.set({
    apiKey,
    apiKey2,
    baseUrl,
    deepseekApiKey,
    xiaomiApiKey,
    model,
    batchSize,
    concurrency,
    autoTranslate
  });

  saveStatus.textContent = '已保存';
  saveStatus.style.color = '#059669';
  setTimeout(() => { saveStatus.textContent = ''; }, 2000);
});

afdianBtn.addEventListener('click', openAfdianPage);

loadSettings();
loadDonationQr();
initAfdianLinks();
