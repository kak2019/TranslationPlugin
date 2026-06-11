// 爱发电开发者配置
// Webhook / API Token 仅适合部署在服务端（如阿里云函数计算），切勿写入扩展代码。
const AFDIAN_USER_ID = '36058450656f11f19caf52540025c377';
const AFDIAN_PAGE_URL = 'https://ifdian.net/a/flynt';

function getAfdianPageUrl() {
  return AFDIAN_PAGE_URL;
}

if (typeof globalThis !== 'undefined') {
  globalThis.AFDIAN_USER_ID = AFDIAN_USER_ID;
  globalThis.AFDIAN_PAGE_URL = AFDIAN_PAGE_URL;
  globalThis.getAfdianPageUrl = getAfdianPageUrl;
}

if (typeof module !== 'undefined') {
  module.exports = { AFDIAN_USER_ID, AFDIAN_PAGE_URL, getAfdianPageUrl };
}
