const MODEL_PRESETS = [
  {
    group: '机器翻译（百炼 Qwen-MT）',
    models: [
      { id: 'qwen-mt-flash', name: 'Qwen-MT-Flash（推荐，速度快）', provider: 'bailian' },
      { id: 'qwen-mt-plus', name: 'Qwen-MT-Plus（质量最高）', provider: 'bailian' },
      { id: 'qwen-mt-turbo', name: 'Qwen-MT-Turbo', provider: 'bailian' },
      { id: 'qwen-mt-lite', name: 'Qwen-MT-Lite（轻量）', provider: 'bailian' }
    ]
  },
  {
    group: '通义千问（百炼）',
    models: [
      { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus（质量最高）', provider: 'bailian' },
      { id: 'qwen-plus', name: 'Qwen Plus（均衡）', provider: 'bailian' },
      { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', provider: 'bailian' },
      { id: 'qwen-flash', name: 'Qwen Flash（速度快）', provider: 'bailian' },
      { id: 'qwen3.5-flash', name: 'Qwen3.5 Flash（速度最快）', provider: 'bailian' }
    ]
  },
  {
    group: 'DeepSeek（官方 API）',
    models: [
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash（推荐）',
        provider: 'deepseek',
        extra: { thinking: { type: 'disabled' } }
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro（高质量）',
        provider: 'deepseek',
        extra: { thinking: { type: 'disabled' } }
      },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner（推理，较慢）', provider: 'deepseek' }
    ]
  },
  {
    group: '小米 MiMo（官方 API）',
    models: [
      {
        id: 'mimo-v2.5-pro',
        name: 'MiMo V2.5 Pro',
        provider: 'xiaomi',
        extra: { thinking: { type: 'disabled' } }
      }
    ]
  },
  {
    group: '其他（百炼）',
    models: [
      { id: 'kimi-k2.5', name: 'Kimi K2.5', provider: 'bailian' },
      { id: 'glm-4-plus', name: 'GLM-4 Plus', provider: 'bailian' }
    ]
  }
];

function getAllModels() {
  return MODEL_PRESETS.flatMap((group) => group.models);
}

function getModelExtra(modelId) {
  const model = getAllModels().find((item) => item.id === modelId);
  return model?.extra || {};
}

function getModelName(modelId) {
  const model = getAllModels().find((item) => item.id === modelId);
  return model?.name || modelId;
}

function getModelProvider(modelId) {
  const model = getAllModels().find((item) => item.id === modelId);
  return model?.provider || 'bailian';
}

function populateModelSelect(selectEl, selectedModel) {
  selectEl.innerHTML = '';
  MODEL_PRESETS.forEach((group) => {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.group;
    group.models.forEach((model) => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name;
      optgroup.appendChild(option);
    });
    selectEl.appendChild(optgroup);
  });
  if (selectedModel && getAllModels().some((item) => item.id === selectedModel)) {
    selectEl.value = selectedModel;
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
    MODEL_PRESETS,
    getAllModels,
    getModelExtra,
    getModelName,
    getModelProvider,
    populateModelSelect
  };
}
