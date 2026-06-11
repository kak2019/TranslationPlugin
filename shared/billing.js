// ExtensionPay 已停用，改用爱发电（见 shared/afdian.js）
// const EXTENSION_PAY_ID = 'bailiantranslation';
const EXTENSION_PAY_ID = '';

if (typeof globalThis !== 'undefined') {
  globalThis.EXTENSION_PAY_ID = EXTENSION_PAY_ID;
}

if (typeof module !== 'undefined') {
  module.exports = { EXTENSION_PAY_ID };
}
