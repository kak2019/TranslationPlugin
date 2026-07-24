# Arya Translate — AI 网页翻译

一键翻译当前网页，支持多厂商模型：通义千问 / Kimi / GLM 走阿里云百炼，DeepSeek 走官方 API，小米 MiMo 走官方 API。Qwen-MT 开箱即用，无需 API Key。

当前版本：**v2.4.3**

## 功能

- **整页翻译**：翻译当前页面可见文本
- **右侧悬浮球**：固定在页面右侧中间，可翻译此页 / 恢复原文 / 切换目标语言 / 双语对照；底部可打开设置与 API、打赏支持
- **双语对照**：开启后保留原文；译文以双层节点注入（沉浸式风格），支持主题：无装饰 / 下划线 / 弱化 / 引用条；营销页与文档站会避开导航、TOC、flex 按钮等易错位区域
- **译文缓存**：同一段落 + 模型 + 目标语言复用本地缓存，刷新页 / Watch 补译 / 反复译恢复更快更省额度；设置页可清除缓存
- **术语 / 专名表**：固定产品名、人名、UI 文案译法；整段精确匹配直接返回，长句约束模型或保护专名
- **站点规则**：按域名覆盖双语 / Watch / 自动翻译，并支持 CSS 跳过选择器；`cursor.com` 等内置合理默认
- **右键菜单**：固定「Arya：翻译页面/恢复页面」（点击按状态切换），以及「翻译选中文本」
- **选区粉色圆点**：选中文字后短延迟出现小圆点（可配置最短长度），悬停预览译文并支持朗读；滚动时跟随选区；「译入页面」与预览整段一致
- **输入框互译**：聚焦输入框时显示可拖动的「译」按钮，按目标语言智能互译；拖动位置本地记住，刷新后仍保留
- **划词翻译**：选中文字后翻译（粉点「译入页面」/ 弹窗按钮 / 右键菜单 / 快捷键）
- **HTML 属性翻译**：`title`、`placeholder`、`alt`、`aria-label`
- **iframe 支持**：同源 iframe 由顶层页面统一遍历翻译；跨域 iframe 由各自 frame 内的脚本独立翻译
- **跳过目标语言**：已是目标语言的段落自动跳过，减少无效请求
- **多模型 / 多厂商**：Qwen-MT、通义千问、DeepSeek、小米 MiMo、Kimi、GLM 等
- **并行翻译**：多批请求同时发送，显著提速
- **流式渐进显示**：Qwen-MT 边译边显示
- **取消翻译**：翻译过程中可随时取消（所有 frame 同步停止）
- **动态补译**：翻译完成后自动监听新内容（Watch 模式）
- **Token 估算**：完成后显示本次约消耗 tokens
- 支持多种目标语言
- **一键恢复原文**：主页面与 iframe 内译文一并还原
- 右键菜单「Arya：翻译页面/恢复页面」「翻译选中文本」
- **粉色品牌图标**：工具栏 / 扩展管理 / 右键菜单统一粉圆白字 A
- **快捷键**（可在 `chrome://extensions/shortcuts` 自定义）：
  - `Ctrl+Shift+Y` — 翻译当前页面
  - `Ctrl+Shift+E` — 翻译选中文本
  - `Ctrl+Shift+U` — 恢复原文

## 更新日志（v2.4.3）

- 修复文档站（如 Microsoft Learn）将整篇 `article` 当一个翻译块导致正文被清空、翻译中页面「消失」
- Learn 站点跳过反馈栏，避免「本页面是否对您有帮助？」被双语撑出大片空白
- 悬停原文提示仅在真实文字上显示；移到空白区 / 页面外自动隐藏
- 重译时去掉恢复后的 yield，减轻整页闪白

## 更新日志（v2.4.2）

- 粉色品牌图标（工具栏与右键菜单）
- 输入框「译」按钮支持拖动，位置写入本地存储并持久化
- 修复输入框互译后再译回无法删除 / 编辑的问题（React 受控输入同步）

## 更新日志（v2.4.1）

- 替换模式清理链接之间残留的纯标点碎片（如 `OpenAI, Mistral` 译后出现 `。,`）

## 更新日志（v2.4.0）

- 替换模式按段落聚合行内链接，避免拆句错译；悬停显示整段原文；恢复原文不再重复
- 划词「译入页面」与粉点预览一致：多段整句一次翻译
- 右键菜单固定为「翻译页面/恢复页面」，点击按页面状态切换
- 悬浮球增加「设置与 API」「打赏」；弹窗与悬浮球展示免费提示文案

## 更新日志（v2.3.0）

- 全模型译文持久缓存（含清除入口）
- 术语表、站点规则、划词粉点延迟 / 最短长度
- 双语注入对齐沉浸式（双层 wrapper + 主题）
- 布局保护：减少营销页错位、文档站横向滚动条

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
| 缓存 | 重复段落命中本地缓存 | 默认开启；设置页可清除 |

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
├── background.js       # 后台服务，调用各厂商 API、译文缓存、术语表
├── content/
│   └── content.js      # 页面文本提取、双语注入、划词 / 悬浮球
├── popup/              # 插件弹窗
├── options/            # API Key、术语表、站点规则等设置
├── scripts/            # 图标生成脚本（开发用）
└── icons/
```

### 开发依赖（可选）

重新生成图标时，在项目根目录执行：

```bash
npm install
node scripts/gen-icons.mjs
# 或指定源图：node scripts/gen-icons.mjs scripts/arya-brand.png
```

`node_modules` 已加入 `.gitignore`，不会提交到仓库。

## 注意事项

- 翻译会消耗对应厂商 API 额度；Token 数为估算值（字符数 ÷ 3.5），仅供参考
- API Key 保存在 `chrome.storage.sync`，请勿在公共设备上使用
- 插件会跳过 `<script>`、`<style>`、`<code>` 等区域；带 `notranslate` 类名的元素也会跳过
- 侧栏、TOC、导航在双语模式下默认不挂译文，避免窄栏撑出横向滚动条
- **iframe**：同源 iframe 由顶层 frame 递归翻译；跨域 iframe 需各自 frame 注入内容脚本（已启用 `all_frames`），顶层页面无法直接读写跨域 DOM
- 动态加载的内容在首次整页翻译后会自动补译（Watch 模式）
- 「恢复原文」与「取消翻译」会广播到标签页内所有 frame，确保 iframe 内译文一并还原或停止
