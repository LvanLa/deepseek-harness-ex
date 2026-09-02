# 计划：dsh-cc-switch-skill — 设置弹窗内的技能管理页

## Summary

把技能管理从侧栏小弹层迁移为**设置弹窗中的独立页面**（`settings.section` 扩展点）。用户打开设置 → 左侧导航「技能管理」→ 管理页：
1. **添加软链接**区置顶：「选择文件夹」按钮调用宿主**原生目录选择器**（`workspaces.pickDirectory()`），选中路径后一键把该目录下所有技能 junction 到 `~/.dsh/skills`；手动输入保留为后备
2. 技能列表：每行名称 + 徽标（linked/pinned/disabled/agent）+ 描述 + 右侧操作组；**启用/停用为醒目主按钮**（disabled 行整行降透明度），另有取消链接、删除（守卫内）
3. 侧栏 footer 的「Skills」按钮及小弹层移除（设置壳的 open state 无外部打开通道，按钮无处可去）

Host 端路由已完备（list/link/unlink/delete/disable/enable），**本次只改 client 端** + 同步安装副本 + README。

## Current State Analysis

- **Host** [lib/index.js](f:/workspace/deepseek-harness/plugins/dsh-cc-switch-skill/lib/index.js)：6 个 loopback 屏蔽路由全部就绪 — **不改**
- **Client** [lib/client.js](f:/workspace/deepseek-harness/plugins/dsh-cc-switch-skill/lib/client.js)：`SkillAction`（footer 按钮）+ `SkillPanel`（absolute 小弹层）— **整体重构**
- **`settings.section` 契约**（dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:67-71,148-151）：`kind:'list'`；options `id`（导航 key）/ `order`（位置）/ `label`（注册方本地化文本函数）；owner props 仅 `{ close }`；壳渲染时 `renderSlot("settings.section", { close: onClose }, { only: active })`（ui-settings-general client.js:164）— 组件 props 直接收 `close`
- **真实注册范例**（ui-settings-plugins client.js:1276-1287）：`ctx.slots.inject("settings.section", () => ctx.slots.register({ name:"settings.section", id, order, label: () => t("nav"), locale: NS, inject: sectionInjected }, SectionComponent))`
- **原生目录选择器**：`workspaces.pickDirectory()`（dsh-client-runtime client.js:9954，`api.host.pickDirectory({})`，返回 `Promise<path|null>`，null=取消）。选择器包本身通过 `inject:["slots","workspaces"]` 取服务 — 我们同样把 `"workspaces"` 加进插件 apply 返回的 cordis inject
- **同步约束**：改动后必须 Copy-Item 同步到 `C:\Users\Administrator\.dsh\profiles\web\node_modules\dsh-cc-switch-skill\lib\`

## Proposed Changes

### 1. `f:\workspace\deepseek-harness\plugins\dsh-cc-switch-skill\lib\client.js`（重构）

**入口**：
- 删除 `sidebar.footer.action` 注册与 `SkillAction`/旧 CSS 小弹层
- `apply` 返回 `inject = ["slots", "locale", "workspaces"]`
- 注册：
  ```js
  ctx.slots.inject("settings.section", () => ctx.slots.register(
    { name: "settings.section", id: "skills", order: 25, label: () => "技能管理" },
    SkillManagerSection
  ));
  ```
- `apply` 内取 `const workspaces = ctx.get("workspaces")`，把 `pickDirectory: () => workspaces.pickDirectory()` 作为 prop 传给组件（section 挂载时机晚于插件 apply，闭包安全）

**`SkillManagerSection` 组件**（settings 内容列内渲染，不需要自带遮罩/关闭）：
- 标题行：说明文案 + 技能根路径（`/api/cc-skills/list` 返回的 `root`）+ refresh
- 「添加软链接」卡片区（顶部）：
  - 主按钮「选择文件夹」→ `props.pickDirectory()`；成功把路径写入文本框；返回 null（取消）静默忽略；抛错时在消息条提示并回退到手动输入
  - 文本框（可手动输入）+「链接」按钮 → `POST /link { sourceDirectory }` → 成功后刷新列表
- 技能列表（两列行布局）：
  - 左：名称 + 徽标（`linked`/`pinned`/`disabled`/`agent`）+ 灰色描述；disabled 行 `opacity:.55`
  - 右操作组（按状态显隐，与 host 守卫一致）：
    - **停用/启用**（主按钮，调 disable/enable）
    - 取消链接（仅 linked）
    - 删除（仅 `agent_created && !linked`，调 delete）
- 消息条：每次操作的 host 返回 message/error，成功绿色失败红色
- 数据流沿用 `callApi`/`load`/`run` 平移；CSS 新增 `.dsh-ccs-*` 类（设置内容列宽内自适应，浅/深色沿用现有 dsw CSS 变量）

### 2. `f:\workspace\deepseek-harness\plugins\dsh-cc-switch-skill\README.md`

入口说明改为「设置 → 技能管理」，移除侧栏按钮描述。

### 3. 同步安装副本

```powershell
Copy-Item "f:\workspace\deepseek-harness\plugins\dsh-cc-switch-skill\lib\*.js" "C:\Users\Administrator\.dsh\profiles\web\node_modules\dsh-cc-switch-skill\lib\" -Force
```

## Assumptions & Decisions

- **入口只在设置弹窗**：设置壳 `open`/`activeId` 是组件本地 state，无对外打开服务（ui-settings-general client.js:177-187）；`openSection` 仅经 onboarding 通道暴露，不可复用 → 侧栏按钮移除
- **label 直接返回中文字符串**（label 契约是注册方本地化文本函数；本插件不注册 locale 字典，文案硬编码中文）
- **启用/停用 = disable/enable 路由**（frontmatter `disable-model-invocation`），host 不加新动作
- delete 按钮显隐与 host 守卫对齐（`agent_created && !linked`），不显示必然失败的按钮

## Verification

1. 同步副本 → 重启 `dsh web --no-open` → 浏览器打开 http://127.0.0.1:3080
2. 侧栏底部不再有 Skills 按钮；打开设置弹窗，左侧导航出现「技能管理」
3. 进入页面：造临时测试源目录（2 个技能，含 `created_by: agent`）
   - 「选择文件夹」→ 原生目录对话框 → 选中路径 → 「链接」→ 列表出现 2 个 `linked` 技能（磁盘验证 junction）
   - 「停用」→ `disabled:true` + SKILL.md 含标志 →「启用」恢复
   - 「取消链接」→ junction 移除、源目录完好
4. 清理测试目录与 junction，停掉后台服务器
