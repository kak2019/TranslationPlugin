# 百炼页面翻译 - 浏览器插件

一键翻译当前网页内容，支持多厂商模型：通义千问 / Kimi / GLM 走阿里云百炼，DeepSeek 走官方 API，小米 MiMo 走官方 API。

## 功能

- 翻译当前页面的可见文本
- **多模型 / 多厂商**：Qwen、DeepSeek、小米 MiMo、Kimi、GLM 等
- **并行翻译**：多批请求同时发送，显著提速
- **取消翻译**：翻译过程中可随时取消
- **实时字幕**：百炼 LiveTranslate 模型，听译悬浮字幕
- 支持多种目标语言
- 一键恢复原文
- 右键菜单「百炼翻译此页面」

## 安装步骤

### Chrome / Edge

1. 打开浏览器，访问扩展管理页：
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本项目文件夹 `plugintranslation`

## 配置 API Key

不同厂商使用各自的官方 API Key，在设置页分别填写：

| 厂商 | 用途 | 获取地址 |
|------|------|----------|
| **阿里云百炼** | 通义千问、Kimi、GLM、实时字幕 | [百炼控制台](https://help.aliyun.com/zh/model-studio/get-api-key) |
| **DeepSeek 官方** | DeepSeek V4 Flash / Pro / Reasoner | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |
| **小米 MiMo 官方** | mimo-v2.5-pro | [platform.xiaomimimo.com](https://platform.xiaomimimo.com/) |

至少填写一个 Key 即可保存。选择某模型翻译时，插件会自动调用对应厂商的 API。

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
| 模型 | 推理型模型（Reasoner）响应慢 | 选 `qwen3.5-flash`、`deepseek-v4-flash` |
| 厂商 | DeepSeek / MiMo 走各自官方 API | 不受百炼限流影响 |
| 并行 | 原先逐批串行请求 | 设置页将并行数调至 4~6 |

## 支持的模型

- **通义千问（百炼）**：qwen3.7-plus、qwen-plus、qwen-flash、qwen3.5-flash
- **DeepSeek（官方）**：deepseek-v4-flash、deepseek-v4-pro、deepseek-reasoner
- **小米 MiMo（官方）**：mimo-v2.5-pro
- **其他（百炼）**：kimi-k2.5、glm-4-plus

## 项目结构

```
plugintranslation/
├── shared/
│   ├── models.js       # 模型列表
│   ├── providers.js    # 多厂商 API 路由
│   └── realtime.js     # 实时字幕配置
├── background.js       # 后台服务，调用各厂商 API
├── content/            # 页面文本提取与替换
├── offscreen/          # 实时字幕 WebSocket + 音频
├── popup/              # 插件弹窗
├── options/            # API Key 设置页
└── icons/
```

## 注意事项

- 翻译会消耗对应厂商 API 额度
- API Key 保存在 `chrome.storage.sync`，请勿在公共设备上使用
- 插件会跳过 `<script>`、`<style>`、`<code>` 等区域
- 动态加载的内容需刷新后重新翻译
