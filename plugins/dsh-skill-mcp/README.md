# dsh-skill-mcp

DSH 技能与MCP插件（v0.2），两大功能：

1. **技能软链接管理**：把任意源目录下的技能目录**以目录联接（Windows 上是 junction，macOS/Linux 上是 symlink）批量链接进用户技能根目录 `~/.dsh/skills`**，让 DSH 直接加载它们；同时提供技能生命周期管理：启用/停用、取消链接、删除。
2. **按项目自动加载 MCP**（v0.2 新增）：监测当前会话工作区，读取用户级 `~/.dsh/mcp.json` 与项目级 `<项目根>/.dsh/mcp.json`（回退 `<项目根>/.mcp.json`，Claude 格式），通过 loader **热加载 / 热卸载**该项目声明的 MCP 服务——每个项目自动带上自己的 MCP（如 quick-java 项目里的 codegraph）。

设置弹窗里有 **技能与MCP** 页面（内部 tab 切换「技能 / MCP」），侧栏底部还有 **⚡ 技能与MCP** 快捷入口，两者打开的是同一个面板。

## 安装

**前置**：已装好 DSH（`dsh web` 能正常运行），Node.js ≥ 20、pnpm ≥ 10。

**支持的 DSH 版本**：peer 依赖 `@deepseek-ai/dsh-client-* ^0.1.1-rc.2`（基于 DSH 0.1.1-rc.2 的客户端运行时适配）。

### 方式一：npm 安装

```powershell
dsh plugin --profile web add dsh-skill-mcp@latest
```

装完硬刷新浏览器（Cmd/Ctrl+Shift+R）即可看到「技能与MCP」设置页与侧栏底部 ⚡ 入口（DSH 对 client 改动热加载；仅 host 半更新时需要重启 `dsh web`）。

### 方式二：让 DSH 自己装——把下面这段提示词发给任意一个 DSH 会话

```
帮我安装 dsh-skill-mcp 插件（DSH 技能与MCP管理），步骤：
1. 执行 dsh plugin --profile web add dsh-skill-mcp@latest
2. 完成后提醒我硬刷新浏览器（Cmd/Ctrl+Shift+R）
遇到报错先查 dsh-skill-mcp README 的常见问题表。
```

### 更新

重跑 `dsh plugin --profile web add dsh-skill-mcp@latest` 即可升级到最新版，完成后硬刷新浏览器。

### 常见问题

| 现象 | 处理 |
| --- | --- |
| 安装时 pnpm 拦截 `node-pty` 构建脚本（仅旧版 dshmarket ≤1.37 的依赖） | 在 `~/.dsh/profiles/web` 执行 `pnpm approve-builds --all` 放行后重跑安装 |
| 装完看不到入口 | 硬刷新浏览器（Cmd/Ctrl+Shift+R）；host 半有改动时需重启 `dsh web` |
| 设置页在但侧栏没有 ⚡ 按钮 | 检查宿主是否加载了客户端半边：package.json 的 `exports` 必须包含 `"./package.json"`，缺了会被静默丢弃 |

### 从源码安装（可选，替代 npm 方式）

```powershell
# 1. 在 ~/.dsh/profiles/web/package.json 的 dependencies 里加入：
#    "dsh-skill-mcp": "file:F:/workspace/deepseek-harness/plugins/dsh-skill-mcp"
#    并把 "dsh-skill-mcp" 加进 dsh.profile.bundles 数组

# 2. 安装依赖
cd ~/.dsh/profiles/web
pnpm install

# 3. 重启 DSH Web（配置在宿主启动时加载）
dsh web
```

改动插件源码后（`lib/` 已随包提供，无需构建）：重新执行 `pnpm install` 刷新 `file:` 依赖，然后重启 `dsh web`。

## 功能

### 链接技能（核心）

点击 **选择文件夹…** 打开宿主的原生目录选择器（或直接粘贴路径），再点 **链接**，源目录下每个技能子目录都会在 `~/.dsh/skills` 里创建一个 junction。已有 junction 会被替换；目标是普通目录或文件时中止。这样技能源目录可以放在任何地方（比如 git 仓库），DSH 照常加载。

脚本化的等价操作：`node scripts/link-skills.mjs <目录>`——按当前系统自动切换（Windows 走 junction 脚本 `link-skills.ps1`，macOS/Linux 走 symlink 脚本 `link-skills.sh`），也可直接调用对应平台的脚本；目标目录默认 `$DSH_HOME/skills` 或 `~/.dsh/skills`。

### 启用 / 停用（switch 开关）

对 `SKILL.md` 的 frontmatter 做原子改写：

- **停用**：写入 `disable-model-invocation: true` + `user-invocable: false`——前者让模型不再自动调用，后者让聊天框 `/` 技能选择器不再列出（只写前者时聊天框仍然可选）；
- **启用**：移除这两个标记。

写入穿透 junction（直接改源目录里的文件）；宿主进程内写入被技能 watcher 锁定拒绝（EPERM/EBUSY）时自动降级为 PowerShell 子进程写入，并做内容回读校验。操作成功后客户端广播 `connection/reset`，聊天框的选择器立即重新拉取目录，无需刷新页面。

### 取消链接

只删除 junction 本身，源目录不受影响；拒绝操作普通目录。

### 删除

三重防护：仅限带 `created_by: agent` 标记的技能、`pinned: true` 的不删、junction/符号链接不删、路径限定在技能根目录内。

### 按项目自动加载 MCP（v0.2 新增）

在技能与MCP面板切到 **MCP** tab 查看。切换工作区（会话）时，插件把项目根推送给宿主，宿主读取三层配置并合并（同名时后者覆盖前者）：

| 层级 | 路径 | 格式 |
| --- | --- | --- |
| 用户级（全局共享） | `~/.dsh/mcp.json` | dsh 原生或 Claude |
| 项目级 | `<项目根>/.mcp.json` | Claude（`mcpServers`） |
| 项目级（优先） | `<项目根>/.dsh/mcp.json` | dsh 原生或 Claude |

配置示例（Claude 格式，codegraph 接入 quick-java 项目）：

```json
{
  "mcpServers": {
    "codegraph": { "command": "codegraph", "args": ["serve", "--mcp"] }
  }
}
```

dsh 原生格式（`{ "servers": { … } }` 或顶层直接是 name→config 映射）：

```json
{
  "servers": {
    "codegraph": {
      "transport": "stdio",
      "command": "codegraph",
      "args": ["serve", "--mcp"],
      "cwd": "."
    }
  }
}
```

行为说明：

- 每个条目热加载为独立 MCP client（stdio 的 `cwd` 相对路径按项目根解析，缺省即项目根——codegraph 靠项目根下的 `.codegraph/` 定位索引）；
- 切换到没有配置的项目时自动卸载，绝不触碰其它来源的 MCP 条目；
- 配置文件改动约 0.5 秒内自动生效（文件监听），无需重启；
- tab 里可对每个服务热启停（写入 `~/.dsh/project-mcp-state.json`，重启后保持），状态点显示连接情况（绿=已连接、黄=加载中、红=失败、灰=停用）与工具数。

## 界面

- 设置页与侧栏快捷入口打开同一「技能与MCP」面板，顶部 tab 切换「技能 / MCP」；
- 技能 tab：可搜索的技能列表（按名称/描述过滤；仅列表区滚动，头部固定），每行技能卡片带状态徽章（`linked`、`pinned`、`已停用`、`agent`）；
- 操作按颜色区分：启停 switch（绿=启用、灰=停用）、取消链接（蓝）、删除（红色悬停）、MCP 状态点（绿=已连接、黄=加载中、红=失败、灰=停用）。

## 技术说明

- 宿主半边与客户端半边走 **connection RPC**（通道 `/skill-mcp`，`authority: 'loopback'`，官方推荐的 Client→Host 私有通道接缝），端点覆盖 `skills/*` 与 `mcp/*`；
- 按项目 MCP 通过 `ctx.loader` 把条目热加载为 `@deepseek-ai/dsh-mcp-client`（id 前缀 `pmcp-`），运行状态由 loader fiber 阶段 + 工具目录派生；
- 客户端半边通过 `settings.section` 扩展点注册设置页，通过 `sidebar.footer.action` 插槽注册侧栏快捷按钮；
- package.json 的 `exports` 必须包含 `"./package.json"`——宿主用 `require.resolve('<pkg>/package.json')` 定位客户端 bundle，缺了这一项客户端半边会被静默丢弃。
