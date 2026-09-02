# dsh-skill-linker v0.2.0：技能 + 按项目 MCP 管理中心（单插件）

> 变更记录：原计划新建独立插件 dsh-project-mcp，经用户确认改为**合入 dsh-skill-linker**，
> 单面板内 tab 切换（技能 / MCP），全部 Client→Host 通信统一为 connection RPC。

## Summary

扩展现有插件 `dsh-skill-linker`（保留包名，升 0.2.0）：

1. **通信迁移**：host↔client 从 HTTP loopback 路由（`/api/cc-skills/*`）改为官方推荐的
   connection RPC（`ctx.connection.rpc.handle('/skill-linker', …, { authority: 'loopback' })`，
   client 侧 `ctx.connection.rpc.call`）。
2. **新增按项目自动加载 MCP**：client 监测当前会话工作区 cwd 并推送；host 读取
   用户级 `~/.dsh/mcp.json` + 项目级 `<cwd>/.dsh/mcp.json`（回退 `<cwd>/.mcp.json`），
   通过 `ctx.loader` 热加载/热卸载 `@deepseek-ai/dsh-mcp-client` 条目（id 前缀 `pmcp-`）。
   首要目标：quick-java 的 codegraph（`codegraph serve --mcp`，cwd=项目根）自动可用。
3. **UI 合并为"管理中心"单面板**：内部 tab 切换「技能 / MCP」；设置页与侧边栏快捷
   入口挂同一面板。

## 已确认的关键事实

| # | 事实 | 依据 |
|---|------|------|
| 1 | MCP 服务器 = `@deepseek-ai/dsh-mcp-client` loader 条目；`ctx.loader.create({id,name,config})` 热加载、`update(id,{config}/{disabled})` 热更新、`remove(id)` 断开并注销工具 | dsh-skill-mcp-center src/service.ts（官方生态已验证） |
| 2 | config schema：stdio → `{transport,serverName,command,args,env,cwd,toolCallTimeoutMs,failOnStartupError,reconnect?}`；http → `{transport:'streamable-http',serverName,url,headers,…}`；serverName 匹配 `[A-Za-z0-9_-]{1,32}` 全局唯一；工具名 `mcp__<serverName>__<rawName>` | @deepseek-ai/dsh-mcp-client lib/types/index.d.ts |
| 3 | client 可拿当前会话 cwd：`ctx.sessions.list.getSnapshot().current` / `.byId[id].cwd`，store 有 `subscribe(listener)→disposer` | dsh-better-sidebar src/client/intercept.tsx L168、context-types.ts L136 |
| 4 | connection RPC：host `rpc.handle(channel,(endpoint,payload)=>RpcResult,{authority:'loopback'})`；client `rpc.call(channel,endpoint,payload)` 返回 `{ok,value\|error{message}}` 信封；官方 plugin center 同接缝 | dsh-skill-mcp-center rpc.ts / client/index.tsx L836-840；官方 cordis-plugin-development SKILL.md §Call Host from Client（推荐 JSON RPC，勿走公共 HTTP） |
| 5 | codegraph：全局安装 `@colbymchenry/codegraph@1.5.0`，MCP 命令 `codegraph serve --mcp`，**cwd 必须是项目根**（靠 `.codegraph/` 定位索引）；Claude 格式 `{mcpServers:{codegraph:{command:"codegraph",args:["serve","--mcp"]}}}` | codegraph README；AppData npm node_modules |
| 6 | MCP 运行状态派生法：`ctx.tools.schemas()` 按 `mcp__<name>__` 前缀计数 + loader fiber state（0 pending/1 loading/2 active/3 failed/5 unloading）；优先探测 `ctx.get('mcpStatus')` seam | dsh-skill-mcp-center service.ts |

## 用户已确认的决策

- 配置格式：`.dsh/mcp.json` 优先，回退项目根 `.mcp.json`（Claude 格式）
- 用户级 + 项目级：`~/.dsh/mcp.json` 共享，项目级同名覆盖
- UI：单面板内 tab（技能 / MCP）；插件包名保留 `dsh-skill-linker`，升 0.2.0
- 通信：connection RPC（官方推荐），技能原有 HTTP 路由一并迁移

## 变更明细

### 1. `plugins/dsh-skill-linker/package.json`
- `version: 0.2.0`；`description` 更新为"技能 + 项目 MCP 管理中心"
- `dsh.client.inject` 增加无需变化（connection 属 client 运行时注入清单？保持四项不变，client 侧 inject 数组自行加 "connection"）

### 2. `plugins/dsh-skill-linker/lib/index.js`（host 半）
- **删除 HTTP 面**：`BASE_PATH`、`isLoopback`、`screenRequest`、`readBody`、`ACTIONS`、webServer 注册全部移除
- **导出**：`export const name = 'dsh-skill-linker'`、`export const inject = ['connection','loader','tools']`
- **RPC 通道 `/skill-linker`**，端点：
  - `skills/list` / `skills/link` / `skills/unlink` / `skills/delete` / `skills/disable` / `skills/enable`（复用现有纯函数，返回值保持 `{ok,message,…}` 业务形状）
  - `mcp/sync {cwd,force}`、`mcp/status`、`mcp/setEnabled {name,enabled}`、`mcp/reload`
- **MCP 引擎**（apply 闭包内）：
  - 配置路径：用户级 `join(DSH_HOME||~/.dsh,'mcp.json')`；项目级 `<cwd>/.dsh/mcp.json`、`<cwd>/.mcp.json`
  - 归一化：Claude 格式（`mcpServers`，command→stdio / url→streamable-http）与 dsh 原生（`servers` 键或顶层映射）；补默认 `toolCallTimeoutMs:60000`、`failOnStartupError:false`、`env:{}`；stdio `cwd` 相对路径按项目根 resolve，缺省=项目根
  - 合并：用户级 → 项目 Claude → 项目 dsh 原生（后者覆盖前者同名）；serverName 清洗 `[A-Za-z0-9_-]{1,32}`
  - reconcile：仅管理 id 前缀 `pmcp-` 的条目；create/update(config)/update(disabled)/remove
  - 启停持久化：`~/.dsh/project-mcp-state.json` `{disabled:[…]}`
  - 文件监听：`fs.watch` 配置文件父目录 + 500ms 去抖 → force reconcile；`ctx.effect` 注册清理
  - status：fiber 阶段 + 工具计数（seam 优先、`ctx.tools.schemas()` 派生回退）+ 配置文件存在性

### 3. `plugins/dsh-skill-linker/lib/client.js`（client 半）
- `inject` 增加 `"connection"`；`callApi` 改走 `ctx.connection.rpc.call('/skill-linker', endpoint, body)`（信封解包，镜像 mcp-center）
- **cwd 上报**：apply 时订阅 `ctx.sessions.list`（subscribe + 2s 轮询兜底），cwd 变化即 `mcp/sync`
- **管理中心面板**：`CenterPanel` = 头部（标题 + tab 切换「技能 / MCP」）+ tab 内容；settings.section 与 sidebar.footer.action 均挂它
  - 技能 tab：现有 SkillManagerSection（去掉自身大标题，保留 root/刷新行）
  - MCP tab：`McpPanel` —— 当前 cwd 与配置来源提示、server 行（状态点/名称/传输摘要/工具数/来源徽标/启停开关）、重新加载按钮、空态

### 4. `README.md`
- 增加 MCP 功能章节（配置格式示例、codegraph 接入 quick-java、行为说明），安装章节保持 npm 优先结构

### 5. 本地验证接入（profile 侧）
- `C:\Users\Administrator\.dsh\profiles\web\package.json`：`"dsh-skill-linker": "^0.1.0"` → `"file:F:/workspace/deepseek-harness/plugins/dsh-skill-linker"`（本地联调），`pnpm install`
- 重启 dsh web 由用户执行

## 验证步骤

1. `node --check lib/index.js && node --check lib/client.js`
2. 重启 dsh web → 设置里"管理中心"出现，技能 tab 功能同旧版（列表/链接/启停/删除）
3. MCP tab：quick-java 会话激活后出现 `codegraph`（绿点、工具数≥1）；模型可调 `mcp__codegraph__codegraph_explore`
4. 切到无配置工作区 → `pmcp-*` 条目卸载、空态显示
5. 改 `~/.dsh/mcp.json` → ~0.5s 后 tab 反映变更；启停开关重启后保持
