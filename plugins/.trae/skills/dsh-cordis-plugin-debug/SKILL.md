---
name: "dsh-cordis-plugin-debug"
description: "排查 dsh/cordis 插件装配与启动故障（inject 报错、服务访问失败、loader entry 失败、插件版本不兼容），并完成源码修复到 profile 部署的闭环。当 dsh 报 fatal load failure、'cannot get property X without inject'、loader entry failed、或插件 RPC/服务注册失败时调用。"
---

# dsh/cordis 插件装配故障排查与修复

适用于 deepseek-harness (dsh) 插件开发与排障。核心是理解 cordis 的依赖注入语义、
dsh 的双部署位置，以及按堆栈定位真实故障点。

## 0. 关键事实（先建立心智模型）

### dsh 插件有两份代码，改源码 ≠ 运行生效
- **workspace 源码**：开发目录（如 `plugins/<name>/lib/index.js`）
- **profile 运行副本**：`~/.dsh/profiles/<profile>/node_modules/<plugin>/lib/index.js`
  （Windows: `C:\Users\<user>\.dsh\profiles\web\node_modules\...`）
- dsh 启动时加载的是**运行副本**。堆栈里的文件路径以哪份为准，故障就在哪份。
- 修改源码后必须**复制到运行副本**，并用 `Get-FileHash` 核对两份哈希一致。
- `pnpm install` 可能按 lockfile 把运行副本还原成 npm 版本，本地补丁在 install 后必须复核。

### cordis 依赖注入的三条铁律
1. **静态 `export const inject = [...]` 只控制本插件 fiber 的启动门槛**：
   依赖未就绪时 fiber 保持 INACTIVE、apply 不执行。它**不会**解锁任何属性访问，
   也不能跨作用域传递。headless 等 profile 缺少某服务时，静态声明会让插件**永不装配**。
2. **属性解析沿 fiber 链向上逐层找 store**，找不到就抛
   `cannot get property "X" without inject`。
3. **服务内部固定以自己的"提供方 ctx"（`Service` 构造时的 `this.ctx`）访问依赖**。
   调用方用 `ctx.get('service')` 拿到的是未绑定调用方作用域的原始实例——
   服务内部访问它自己的依赖时，解析路径与调用方无关，调用方声明 inject 也救不了。

### 正确模式：运行时注入回调
```js
// 等待依赖就绪后执行；回调 ctx 经 inject 持有依赖；随本插件卸载自动清理
ctx.inject(['connection', 'webServer'], (svc) => {
  svc.connection.rpc.handle(channel, handler)
})
```
官方核心插件自身也是这样写的（如 dsh-client-connection 挂路由用
`ctx.inject(["webServer"], (webCtx) => webCtx.effect(() => webCtx.webServer.register(route)))`）。
这同时解决"依赖晚到"（自动等待）、"作用域解析"（回调 fiber 的 store 含依赖）、
"headless 无服务"（静默等待而非崩溃）三个问题。

## 1. 排查流程

### 步骤 1：堆栈定位——确认加载的是哪份代码
- 读堆栈中**插件自己文件**的帧：路径在 `~/.dsh/profiles/.../node_modules/<plugin>/`
  即运行副本；行号与 workspace 源码对照即可判断新旧（修复后行号会位移）。
- 核心包源码位置（Volta 安装）：
  `C:\Users\<user>\AppData\Local\Volta\tools\image\packages\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
  下含 cordis、dsh-client-connection、dsh-subagent、dsh-settings 等。
- `AggregateError: loader entries failed to apply` 是聚合错误，必须展开
  `[errors]` 数组逐条看，每条对应一个失败插件——**与本次改动无关的插件错误不要混为一谈**。

### 步骤 2：按报错类型处置
| 报错特征 | 含义 | 处置方向 |
|---|---|---|
| `cannot get property "X" without inject` | 某 ctx 作用域链上找不到服务 X | 找到访问 X 的代码帧；若在核心服务内部（owner 是其 this.ctx），调用方改用 `ctx.inject([...], cb)` 回调，而非 `ctx.get(...)` 后直调 |
| `... is not a function`（核心服务方法） | 插件针对旧版核心 API 编写 | 核心源码中 Grep 新方法名/符号；查插件新版是否适配（见步骤 3） |
| `does not provide an export named 'X'` | ESM 命名导出被核心移除/改名 | 同上，属插件与核心版本不兼容 |
| 插件日志正常但仍 fatal | fatal 来自**其他** loader entry | 展开 AggregateError 的 errors 列表逐条归因 |

### 步骤 3：第三方插件版本不兼容的核验顺序
1. `npm view <pkg> version` 看 latest；`npm view <pkg> dist-tags --json` 看 next/alpha。
2. `npm view <pkg>@<ver> peerDependencies --json` 对照已装核心版本
   （核心版本见核心包 `package.json`，dsh 本体版本在 Volta 目录 `@deepseek-ai/dsh/package.json`）。
3. 不能只看版本号——**下载核验代码**：
   `npm pack <pkg>@<ver> --pack-destination $env:TEMP\xxx` 后解包，
   Grep 报错的 API 名，确认新版是否真的移除/替换了该调用。
4. 兼容层/shim 也要验证其探测的接口在新核心中存在（方法名、`Symbol.for(...)` 键名
   都可能改——例如核心内部符号跨版本改名后，shim 的特性检测会失败并主动抛错）。
5. 所有已发布版本都不兼容时，建议用户从 profile 暂时卸载该插件（需用户确认），
   等上游适配；不要在 node_modules 里长期打补丁（install 即丢失）。

### 步骤 4：修复后的部署与验证闭环
1. `node --check <file>` 语法检查。
2. ESM 烟测：`node -e "import('file:///.../lib/index.js').then(m => console.log(m.inject, typeof m.apply))"`。
3. 复制到运行副本并核对哈希一致。
4. 重启 dsh，预期看到插件自己的 ready 日志（如 `rpc '...' ready`），
   且 AggregateError 中不再出现该插件。

## 2. profile 维护操作（Windows / pnpm）

- profile 配置：`~/.dsh/profiles/<profile>/package.json`
  - 卸载插件需同时删 `dependencies` 和 `dsh.profile.bundles` 两处条目。
- 安装/更新：`pnpm install --dir <profile-dir> --no-frozen-lockfile`
  （frozen-lockfile 在该环境默认开启，改了 package.json 必须加此参数）。
- pnpm 写临时文件会被沙箱拦截（EPERM），需在沙箱外执行该命令。
- install 后复核：本地补丁插件的文件哈希、被删插件在 lockfile 中 0 引用。

## 3. 禁忌清单

- ❌ 以为加静态 `inject = ['webServer']` 能解决服务内部访问报错——不能，且 headless 下会冻结插件。
- ❌ 用 `ctx.get('service')` 拿到服务后直接调用会触发服务内部依赖解析的方法——
  服务方法内部用它自己的 owner ctx，绕不过注入要求。
- ❌ 只改 workspace 源码不同步运行副本，或同步后不核对哈希。
- ❌ 把 AggregateError 里其他插件的失败归因到自己的改动——先逐条展开。
- ❌ 凭版本号猜测"新版已修复"——必须 npm pack 解包核验实际代码。
- ❌ 未经用户确认直接卸载/禁用插件或修改 profile 配置（持久化环境变更）。
