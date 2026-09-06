# Dify 自动化（Chrome 扩展）

对话式 AI Workflow Engineer：在浏览器侧边栏用自然语言描述需求，自动在 Dify 上完成 **设计 → DSL 生成 → 导入创建 → 参数自检 → 草稿测试 → 发布** 的全流程，不用手动拖节点。

兼容 Dify 云端（cloud.dify.ai）与自建部署（Docker 本地），支持 Dify 1.17 的新版 Cookie + CSRF 鉴权与旧版 token 鉴权。

## 功能

- 💬 **双模式**：「干活」全功能搭建；「快聊」关闭推理秒回，用于梳理需求
- 🤖 **多模型预设**：一键切换 OpenRouter（MiMo 2.5 / 2.5 Pro）、DeepSeek 官方 API 等预设，接口地址 + 模型 + Key 三件套一起换；兼容任意 OpenAI 格式接口
- 🔌 **本地部署直连**：自动检测浏览器里已登录的 Dify（云端/自建均可），复用登录态，新版凭据系统自动续期
- 🛠 **9 个工具**：列模型 / 列应用 / 列知识库 / 列工具插件（含 MCP）/ DSL 导入创建 / 读画布 / 写画布 / 草稿运行 / 发布
- 🧹 **自动修复**（确定性代码，不靠模型自觉）：
  - 模型节点 provider+name 校验，配错自动修正，无可用模型时兜底默认模型
  - 知识库检索 → LLM 的上下文接线补全（context + {{#context#}} 注入）
  - if-else / 问题分类器分支漏连检测
  - 环检测、孤岛节点、节点 id 字符合法性、缺 start/end、缺 prompt、tool 节点编造 provider
  - 画布并发冲突（409）自动刷新重提
  - 同名应用防重复创建
- 📺 **过程可见**：思维链实时流式显示、工具调用明细、工作流测试逐节点进度、运行结果卡片
- ⏹ **可中断**：停止按钮立刻掐断（含超时兜底），步数耗尽强制输出总结

## 安装

1. 下载本仓库（Code → Download ZIP，或 git clone）
2. Chrome 打开 chrome://extensions → 右上角开启「开发者模式」→「加载已解压的扩展程序」→ 选择本目录
3. 点工具栏图标打开侧边栏

## 配置

点侧边栏右上角 ⚙：

| 配置项 | 说明 |
|---|---|
| Dify 地址 | 不用填——自动检测浏览器里已登录的 Dify 标签页（云端或自建均可），检测失败点「检测」按钮 |
| LLM API Base | 默认 https://openrouter.ai/api/v1，兼容任意 OpenAI 格式接口 |
| LLM API Key | 你的模型服务 Key（**仓库不含任何 Key，需要自己填**） |
| 模型 | 手填或点「拉取列表」（仅列出支持工具调用的模型） |
| 快聊模型 | 快聊模式专用（默认 DeepSeek V3.1，非推理所以快） |
| 自定义规则 | 追加到系统提示词，优先级最高 |

> 本仓库已对所有 API Key 做空白处理。预设按钮只包含接口地址和模型名，Key 需要自己填一次（会按「模型 → Key」记住对应关系）。

## 使用示例

按我的结构搭一个工作流，节点和顺序如下，不要加别的节点：
1. 开始：输入变量 question（段落文本）
2. LLM「理解改写」：把 question 改写成适合检索的查询
3. 知识库检索：用「商品知识库」
4. LLM「回答生成」：根据检索结果回答
5. 结束：输出回答
模型都用 MiMo 2.5，测试通过后发布

也可以直接说需求（"做一个电商客服，回答前先联网搜索"），它会引导安装缺失的工具插件并自动接线。

## 常见报错速查

| 报错 | 原因与处理 |
|---|---|
| Model is not configured | 工作区没配模型，或建流时模型还没配好。去 Dify「设置 → 模型供应商」配置；新版会运行时自动修复 |
| HTTP 409 Workflow graph might have been modified | 画布并发冲突，已自动刷新重提 |
| HTTP 404 app_not_found (did you mean /advanced-...) | 应用是 chatflow 类型，已自动识别端点 |
| 检测显示未连接 | 确认浏览器里有已登录的 Dify 标签页；多个 Dify 标签时优先匹配域名含 dify 的 |
| 发布 HTTP 400/415 | v1.3.1 已修复（空 body 的 JSON 头问题） |

## 目录结构

- manifest.json — MV3 + Side Panel + cookies/scripting/tabs 权限
- background.js — Agent 主循环 + Dify 客户端（三层鉴权）+ 9 个工具 + DSL 校验/自愈
- sidepanel.html/js — 对话界面（双模式/流式思维链/结果卡片/历史持久化）
- vendor/js-yaml.min.js — DSL 导入前本地预检用（MIT）

## 安全说明

- 不含任何服务器，全部请求从你的浏览器直接发出
- Dify 登录态走浏览器 Cookie（新版 Dify）+ CSRF 头，token 不会出本机
- 请勿把填入 Key 的版本公开分享；本仓库所有 Key 字段均为空白

## License

MIT（vendor/js-yaml.min.js 为其原仓库 MIT 许可）
