# Arya Translate — AI 网页翻译

一键翻译当前网页，支持多厂商模型：通义千问 / Kimi / GLM 走阿里云百炼，DeepSeek 走官方 API，小米 MiMo 走官方 API。Qwen-MT 开箱即用，无需 API Key。

## 功能

- **整页翻译**：翻译当前页面可见文本
- **划词翻译**：选中文字后翻译（弹窗按钮 / 右键菜单 / `Alt+Shift+T`）
- **HTML 属性翻译**：`title`、`placeholder`、`alt`、`aria-label`
- **同源 iframe**：自动翻译同域 iframe 内正文
- **多模型 / 多厂商**：Qwen-MT、通义千问、DeepSeek、小米 MiMo、Kimi、GLM 等
- **并行翻译**：多批请求同时发送，显著提速
- **流式渐进显示**：Qwen-MT 边译边显示
- **取消翻译**：翻译过程中可随时取消
- **动态补译**：翻译完成后自动监听新内容（Watch 模式）
- **Token 估算**：完成后显示本次约消耗 tokens
- 支持多种目标语言
- 一键恢复原文
- 右键菜单「Arya：翻译此页面 / 翻译选中文本」
- 快捷键：`Alt+T` 整页翻译，`Alt+Shift+T` 划词翻译

## 安装步骤

### Chrome / Edge

1. 打开浏览器扩展管理页：
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本项目文件夹

## 配置 API Key

不同厂商使用各自的官方 API Key，在设置页分别填写：

| 厂商 | 用途 | 获取地址 |
|------|------|----------|
| **阿里云百炼** | Qwen-MT（免费托管）、通义千问、Kimi、GLM | [百炼控制台](https://help.aliyun.com/zh/model-studio/get-api-key) |
| **DeepSeek 官方** | DeepSeek V4 Flash / Pro / Reasoner | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |
| **小米 MiMo 官方** | mimo-v2.5-pro | [platform.xiaomimimo.com](https://platform.xiaomimimo.com/) |

Qwen-MT 无需填写 Key 即可使用。选择其他模型翻译时，插件会自动调用对应厂商的 API。

### 百炼地域说明

| 地域 | Base URL |
|------|----------|
| 中国内地 | `dashscope.aliyuncs.com` |
| 国际（新加坡） | `dashscope-intl.aliyuncs.com` |
| 中国香港 | `cn-hongkong.dashscope.aliyuncs.com` |

百炼 API Key 需与所选地域匹配。DeepSeek / 小米使用固定官方地址，无需选地域。

## 提速建议

| 原因 | 说明 | 建议 |
|------|------|------|
| 模型 | 推理型模型（Reasoner）响应慢 | 选 `qwen-mt-flash`、`deepseek-v4-flash` |
| 厂商 | DeepSeek / MiMo 走各自官方 API | 不受百炼限流影响 |
| 并行 | 多批同时请求 | 设置页将并行数调至 4~6 |
| 批大小 | 通用 LLM 批翻译 | 批大小建议 40 |

## 支持的模型

- **机器翻译（百炼 Qwen-MT）**：qwen-mt-flash、qwen-mt-plus、qwen-mt-turbo、qwen-mt-lite
- **通义千问（百炼）**：qwen3.7-plus、qwen-plus、qwen3.5-plus、qwen-flash、qwen3.5-flash
- **DeepSeek（官方）**：deepseek-v4-flash、deepseek-v4-pro、deepseek-reasoner
- **小米 MiMo（官方）**：mimo-v2.5-pro
- **其他（百炼）**：kimi-k2.5、glm-4-plus

## 项目结构

```
TranslationPlugin/
├── shared/
│   ├── models.js       # 模型列表
│   ├── providers.js    # 多厂商 API 路由
│   ├── afdian.js       # 爱发电打赏
│   └── hosted-key.js   # Qwen-MT 托管 Key（仅 background 引用）
├── background.js       # 后台服务，调用各厂商 API
├── content/
│   └── content.js      # 页面文本提取、属性、划词翻译
├── popup/              # 插件弹窗
├── options/            # API Key 设置页
└── icons/
```

## 注意事项

- 翻译会消耗对应厂商 API 额度；Token 数为估算值（字符数 ÷ 3.5），仅供参考
- API Key 保存在 `chrome.storage.sync`，请勿在公共设备上使用
- 插件会跳过 `<script>`、`<style>`、`<code>` 等区域
- 跨域 iframe 因浏览器安全限制无法翻译
- 动态加载的内容在首次整页翻译后会自动补译（Watch 模式）
- 点击「恢复原文」可还原页面
