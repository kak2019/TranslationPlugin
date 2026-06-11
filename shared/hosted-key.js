// 仅 background 引用。客户端混淆无法真正防提取，生产环境建议改用服务端代理。
(function () {
  const MASK = 0x5a;
  const DATA = [
    41, 49, 119, 98, 107, 108, 108, 109, 57, 63, 108, 60, 99, 56, 99, 110,
    56, 98, 56, 99, 105, 57, 59, 106, 98, 108, 98, 62, 110, 111, 99, 104,
    60, 57, 98
  ];

  function getHostedBailianKey() {
    return DATA.map((c) => String.fromCharCode(c ^ MASK)).join('');
  }

  globalThis.getHostedBailianKey = getHostedBailianKey;
})();
