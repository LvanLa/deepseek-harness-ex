# MCP 管理页面改造计划（v0.3.0）

## 概要

为 dsh-skill-mcp 的 MCP 面板增加完整管理能力：

1. **从其他 agent 导入 MCP**：扫描本机 Claude Code / Codex / Cursor / Gemini CLI 的配置，勾选后复制到 dsh 配置。
2. **添加/编辑/删除 MCP 服务**：表单填写 + 可切换 JSON 直接编辑；删除需二次确认。
3. **按项目作用域管理**：添加/导入时显式选择写入「全局 `~/.dsh/mcp.json`」还是「当前项目 `.dsh/mcp.json`」，不静默处理；切换项目自动加载沿用现有 mcp/sync 逻辑。

参考实现：`F:\workspace\deepseek-harness\plugins\dsh-plugin-capabilities-main`（`src/agents.ts` 外部 agent 扫描、`src/mcp.ts` 行管理、`src/client/McpTab.tsx` 导入弹窗与表单交互）。

## 现状分析

- **宿主端** [lib/index.js](../../lib/index.js)：connection RPC 通道 `/skill-mcp`，已有 `mcp/sync`（cwd 变化热加载三层配置合并）、`mcp/status`、`mcp/setEnabled`、`mcp/reload`。三层配置：用户级 `~/.dsh/mcp.json` → 项目 `.mcp.json`（Claude 格式）→ 项目 `.dsh/mcp.json`，后者覆盖同名。文件监听 0.5s 内自动重载。
- **前端** [lib/client.js](../../lib/client.js)：McpPanel 只读（启停 Switch + 重新加载），无添加/导入/编辑/删除。
- **参考插件** 的做法（本计划沿用其思路，但适配本插件的零依赖 + RPC 架构）：
  - `agents.ts`：`scanAllMcp()` 读 `~/.claude.json`+`~/.claude/settings.json`、`~/.cursor/mcp.json`、`~/.codex/config.toml`（smol-toml）、`~/.gemini/settings.json`；SSE 等不支持的传输跳过。
  - `mcp.ts`：upsert/toggle/remove + 校验（serverName `[A-Za-z0-9_-]{1,32}`、stdio 必须有 command、http 必须 http(s) URL）。
  - `routes.ts` `/import/scan`、`/import/apply`：scan 返回 `{servers, existing}`；apply 按选择写入目标层，逐条返回结果，已存在则跳过。
- **已安装副本**（需同步）：`C:\Users\Administrator\.dsh\profiles\web\node_modules\dsh-skill-mcp\lib\`。
- **已应用的两处前置修改**（中断前已完成，保留）：
  - `flatStringRecord()` 扁平字符串记录辅助函数（index.js）。
  - `normalizeMcpEntry` 的 headers 读取修复：支持 Claude 扁平格式 `{ "X-Key": "v" }`，旧嵌套写法兜底（index.js）。

## 已确认的需求决策

| 决策点 | 结论 |
|---|---|
| 管理能力 | 添加 + 编辑 + 删除 |
| 导入来源 | Claude Code / Codex / Cursor / Gemini CLI 全部 |
| 编辑交互 | 弹出表单，可切换 JSON 直接编辑 |
| env/args 格式 | env 每行 `KEY=VALUE`；headers 每行 `KEY: VALUE`；args 空格分隔 |
| 删除 | 全部二次确认（confirm） |
| 作用域 | 显式下拉选择（全局 / 当前项目），不静默 |
| 按项目加载 | 保留现有 sync 逻辑，仅增强 UI |

## 变更方案

### 1. 后端 lib/index.js

**模块级新增**（放在 `readMcpConfigFile` 附近）：

- `serverMapOf(doc)`：取 `doc.mcpServers ?? doc.servers`，返回 map 或 null。
- `readMcpDoc(filePath)`：读原始 JSON 文档；ENOENT → `{doc:null}`；解析失败 → `{error}`。
- `writeMcpDoc(filePath, doc)`：`JSON.stringify(doc, null, 2) + '\n'`，经 `atomicWrite`（mkdir recursive）。
- `parseTomlSubset(text)`：**零依赖最小 TOML 解析器**（Codex 用，替代参考插件的 smol-toml 依赖）：
  - 支持 `[a.b.c]` 节头、`key = value`、基本/字面字符串、多行数组（括号配平累积）、内联表 `{ K = "v" }`、布尔、数字、`#` 注释。足以覆盖 `[mcp_servers.<name>]` 的 command/args/env/url。
- `mapForeignEntry(agent, name, entry)`：归一化为 `{agent, name, transport:'stdio'|'http', command?, args?, env?, url?, headers?}`；`type:'sse'`、无 command/url 的条目返回 null（对齐参考插件）。
- `scanForeignMcp()`（async）：
  - claude-code：`~/.claude/settings.json` + `~/.claude.json` 的 `mcpServers`（后者覆盖前者）
  - cursor：`~/.cursor/mcp.json` 的 `mcpServers`
  - codex：`~/.codex/config.toml` 的 `[mcp_servers.*]`（`url` → http）
  - gemini：`~/.gemini/settings.json` 的 `mcpServers`（`httpUrl` → http；仅 `url` 的 SSE 跳过）
  - 按 `agent/name` 去重；所有文件缺失/损坏 → 跳过该文件。

**apply() 内新增**（依赖 lastCwd / userMcpPath）：

- `scopeFilePath(scope)`：`'user'` → `userMcpPath()`；`'project-dsh'` → `projectDshPath(lastCwd)`；`'project-mcp'` → `projectClaudePath(lastCwd)`；项目作用域但 `lastCwd === null` → 返回 null（报错提示先打开工作区）。
- `resync()`：`lastCwd !== null` 时 `sync(lastCwd, true)`（写入后立即热加载，不依赖 0.5s watcher）。
- `saveMcpServer(payload)`（添加/编辑 upsert）：
  - payload `{ name, scope, transport, command, args, env, cwd, url, headers }`
  - 校验：`sanitizeServerName`（1-32 位 `[A-Za-z0-9_-]`）；stdio 必须有 command；http 必须 `^https?://` URL。
  - 生成 Claude 格式条目：stdio → `{ command, args?, env?, cwd? }`；http → `{ type: 'http', url, headers? }`。
  - 文件不存在 → 创建 `{ mcpServers: { … } }`；已有 `servers` 键的文件沿用该键。同名已存在 → 替换（编辑语义），message 区分「已更新/已添加」。
  - 写入 + resync。
- `getMcpServer(name)`：按 user → project-mcp-json → project-dsh-json 顺序查找原始条目，返回 `{ source, path, raw }`（编辑表单/JSON 编辑器填充用）。
- `removeMcpServer(name)`：按同顺序查找所在文件，`delete map[name]` 后写回 + resync；找不到报错。
- `applyImport(payload)`：`{ items:[{agent,name}], scope }` → scan 后过滤所选；目标文件中已存在的条目逐条返回 `{ok:false, error:'已存在于目标配置'}`；其余转成 Claude 格式条目写入，写回 + resync，返回逐条 results。
- **新增 RPC endpoints**：`mcp/import/scan`（返回 `{servers, existing:[...desired.keys()]}`）、`mcp/import/apply`、`mcp/save`、`mcp/get`、`mcp/remove`。
- `mcp/status` 无需改动（已含 source/files 信息）。

### 2. 前端 lib/client.js（McpPanel）

**头部动作行**（现有 `重新加载配置` 移入）：`导入…`、`添加…`、`重新加载配置`。

**编辑器面板**（内联展开，样式沿用现有 input-row 体系）：

- 表单字段：名称（编辑模式只读）、类型 select（stdio / HTTP）、
  - stdio：命令、参数（空格分隔，如 `serve --mcp`）、环境变量（textarea 每行 `KEY=VALUE`）、工作目录（可选）
  - HTTP：URL、请求头（textarea 每行 `KEY: VALUE`）
- 作用域 select（**显式必选**）：`全局 ~/.dsh/mcp.json` / `当前项目 .dsh/mcp.json`（status.cwd 为空时项目项禁用并提示）；编辑模式锁定为来源文件并显示路径（`.mcp.json` 来源则显示 `当前项目 .mcp.json`）。
- 「JSON 编辑」开关：textarea 显示/接收**单条条目**的原始 JSON（编辑模式从 `mcp/get` 的 raw 初始化，添加模式给模板 `{ "command": "…", "args": [] }` 或 `{ "type": "http", "url": "…" }`）；保存时 `JSON.parse` 校验后平铺成与表单相同的 payload 提交 `mcp/save`。
- 保存/取消按钮；错误显示复用 `dsh-ccs-msg-err`。

**导入面板**（内联展开）：

- 打开即调 `mcp/import/scan`，加载中/空态提示。
- 按 agent 分组展示（Claude Code / Codex / Cursor / Gemini CLI），组头全选；每行复选框 + 名称 + 摘要（command+args 或 url）；当前已加载的同名条目置灰标注「已存在」且不可勾选。
- 作用域 select（同编辑器）；「导入所选」→ `mcp/import/apply` → 逐条结果展示（成功绿/失败红）。

**列表行新增操作**：

- 编辑（icon 按钮「编辑」）：先 `mcp/get` 取 raw 填充编辑器。
- 删除（红色 icon 按钮）：`confirm(\`确定从 <来源文件路径> 中删除 MCP 服务 '<name>'？\`)` 二次确认 → `mcp/remove`。

**联动**：保存/导入/删除成功后 `hostCtx.emit('connection/reset')`（工具目录变更）+ 重新加载 status，与现有 toggle 行为一致。

**CSS 新增**：`.dsh-ccs-form`（字段网格）、`.dsh-ccs-textarea`（等宽、min-height）、`.dsh-ccs-select`、`.dsh-ccs-group-head`（导入分组头）、`.dsh-ccs-check-row`（复选行）等，全部走 `--dsw-alias-*` 变量并带 hover。

### 3. 收尾

- `package.json` 版本 0.2.0 → 0.3.0，description 补充「add/edit/import MCP servers」。
- 两份 lib 文件同步到已安装副本 `C:\Users\Administrator\.dsh\profiles\web\node_modules\dsh-skill-mcp\lib\`。

## 假设与决策

- 写入格式统一 Claude 格式（`mcpServers` 键），`readMcpConfigFile` 在加载端已兼容；文件已有 `servers` 键时沿用，避免破坏手工维护的文件。
- 编辑不提供「重命名」：改名 = 新建 + 删旧，避免移动语义复杂化。
- Codex TOML 解析用内置 ~60 行子集解析器，不引入运行时依赖（插件保持零依赖、可打包）。
- 删除 `.mcp.json`（可能被 Claude Code 共享）不区分对待——统一二次确认。
- 项目作用域只写 `.dsh/mcp.json`（我们自己的约定文件）；`.mcp.json` 仅在编辑该来源条目时原位写回。

## 验证步骤

1. `node --check lib/index.js && node --check lib/client.js`。
2. 同步到已安装副本后重启 dsh / 硬刷新（Ctrl+Shift+R）。
3. 功能验证：
   - 添加 stdio 服务（如 `codegraph serve --mcp`）到全局 → 状态点亮、工具计数出现；
   - 切到 HTTP 类型填 URL → 保存后 source 标签正确；
   - 导入面板能看到本机 Claude/Cursor/Codex/Gemini 的真实条目，勾选导入到当前项目后自动加载；
   - 编辑条目改参数 → 热更新生效（约 0.5s）；
   - JSON 模式粘贴非法 JSON → 报错不写入；
   - 删除有二次确认，删除后条目从对应文件消失且工具被卸载；
   - 切换项目 → 项目作用域配置自动加载/卸载（现有逻辑回归）。
