const PROVIDERS = {
  bailian: {
    id: 'bailian',
    name: '阿里云百炼',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/get-api-key'
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    defaultBaseUrl: 'https://api.deepseek.com',
    docsUrl: 'https://platform.deepseek.com/api_keys'
  },
  xiaomi: {
    id: 'xiaomi',
    name: '小米 MiMo 官方',
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
    docsUrl: 'https://platform.xiaomimimo.com/'
  }
};

function resolveApiConfig(config) {
  const provider = getModelProvider(config.model);
  const extra = getModelExtra(config.model);

  if (provider === 'deepseek') {
    return {
      provider,
      providerName: PROVIDERS.deepseek.name,
      baseUrl: config.deepseekBaseUrl || PROVIDERS.deepseek.defaultBaseUrl,
      apiKey: config.deepseekApiKey || '',
      model: config.model,
      extra,
      buildHeaders(apiKey) {
        return {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        };
      }
    };
  }

  if (provider === 'xiaomi') {
    return {
      provider,
      providerName: PROVIDERS.xiaomi.name,
      baseUrl: config.xiaomiBaseUrl || PROVIDERS.xiaomi.defaultBaseUrl,
      apiKey: config.xiaomiApiKey || '',
      model: config.model,
      extra,
      buildHeaders(apiKey) {
        return {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'api-key': apiKey
        };
      }
    };
  }

  return {
    provider: 'bailian',
    providerName: PROVIDERS.bailian.name,
    baseUrl: config.baseUrl || PROVIDERS.bailian.defaultBaseUrl,
    apiKey: config.apiKey || '',
    model: config.model,
    extra,
    buildHeaders(apiKey) {
      return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      };
    }
  };
}

function getBailianApiKeys(config) {
  return [config.apiKey, config.apiKey2].map((k) => (k || '').trim()).filter(Boolean);
}

function hasApiKeyForModel(config) {
  const provider = getModelProvider(config.model);
  if (provider === 'bailian') {
    return getBailianApiKeys(config).length > 0;
  }
  return Boolean(resolveApiConfig(config).apiKey);
}

if (typeof module !== 'undefined') {
  module.exports = { PROVIDERS, resolveApiConfig, getBailianApiKeys, hasApiKeyForModel };
}
