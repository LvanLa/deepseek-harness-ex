/**
 * dsh-skill-mcp client half (v0.3.0).
 *
 * "管理中心"插件：单面板内 tab 切换「技能 / MCP」。
 *
 * - 通信：connection RPC（官方推荐的 Client→Host 私有通道），取代 v0.1 的
 *   /api/cc-skills/* HTTP 路由。信封 {ok, value | error{message}}。
 * - 按项目 MCP：监测当前会话工作区 cwd（sessions.list store），变化即推送
 *   mcp/sync；host 热加载/热卸载对应 @deepseek-ai/dsh-mcp-client 条目。
 * - MCP 管理（v0.3）：添加/编辑（表单 + JSON 切换）/删除（二次确认），
 *   从其他 agent（Claude Code / Codex / Cursor / Gemini CLI）扫描导入，
 *   写入作用域显式选择（全局 / 当前项目）。
 * - 挂载点：设置页 settings.section + 侧边栏 footer 快捷入口（全屏浮层），
 *   两处均渲染同一 CenterPanel。
 */
window.__ModuleLoader__.load({
  id: "dsh-skill-mcp",
  factory: (require) => {
    const React = require("react");
    // 不用 jsx-runtime：某些 shell 构建里 require("react/jsx-runtime") 的命名导出
    // 不可靠（jsx 为 undefined → "jsx is not a function"），createElement 最稳。
    const jsx = (type, props) => React.createElement(type, props);

    const INJECT = ["slots", "locale", "workspaces", "connection"];

    /** connection RPC 通道（与 host 半一致）。 */
    const RPC_CHANNEL = "/skill-mcp";

    let hostCtx = null;

    /**
     * RPC 调用：解包 {ok, value | error} 信封，抛出传输级错误。
     * 返回的 value 保留业务形状（{ok, message, ...}）。
     */
    async function callApi(endpoint, body = {}) {
      const result = await hostCtx.connection.rpc.call(RPC_CHANNEL, endpoint, body);
      if (result.ok) return result.value;
      throw new Error(result.error?.message || `rpc ${endpoint} failed`);
    }

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------

    const css = `
      .dsh-ccs-overlay { position: fixed; inset: 0; z-index: 1000; display: flex;
        align-items: center; justify-content: center;
        background: var(--dsw-alias-scrim, rgba(0,0,0,0.45)); }
      .dsh-ccs-overlay-panel { width: 640px; max-width: 92vw; height: min(640px, 86vh);
        background: var(--dsw-alias-bg-primary, #fff); color: var(--dsw-alias-text-primary, #222);
        border-radius: 12px; padding: 20px 22px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.2);
        display: flex; flex-direction: column; }
      .dsh-ccs-page { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }
      .dsh-ccs-title { margin: 0 0 6px; font-size: 16px; font-weight: 600; flex-shrink: 0; }
      .dsh-ccs-tabs { display: flex; gap: 2px; margin: 8px 0 14px; flex-shrink: 0;
        border-bottom: 1px solid var(--dsw-alias-border-primary, rgba(127,127,127,0.25)); }
      .dsh-ccs-tab { appearance: none; padding: 7px 16px; background: transparent; border: none;
        border-bottom: 2px solid transparent; margin-bottom: -1px; cursor: pointer; font-size: 13px;
        color: var(--dsw-alias-text-secondary, #666); }
      .dsh-ccs-tab:hover { color: var(--dsw-alias-text-primary, #222); }
      .dsh-ccs-tab-active { color: var(--dsw-alias-text-link, #4b7bec); font-weight: 600;
        border-bottom-color: var(--dsw-alias-text-link, #4b7bec); }
      .dsh-ccs-root { font-size: 12px; color: var(--dsw-alias-text-secondary, #666);
        word-break: break-all; margin-bottom: 10px; }
      .dsh-ccs-list { display: flex; flex-direction: column; gap: 8px; }
      .dsh-ccs-row { display: flex; align-items: center; gap: 10px;
        padding: 10px 12px; border-radius: 8px;
        background: var(--dsw-alias-bg-secondary, rgba(127,127,127,0.07)); }
      .dsh-ccs-row-disabled { opacity: 0.55; }
      .dsh-ccs-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; }
      .dsh-ccs-text { flex: 1; min-width: 0; }
      .dsh-ccs-name { font-size: 13px; font-weight: 600; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis;
        display: flex; align-items: center; gap: 6px; }
      .dsh-ccs-sub { font-size: 12px; color: var(--dsw-alias-text-secondary, #666);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
      .dsh-ccs-badges { display: inline-flex; gap: 4px; flex-shrink: 0; }
      .dsh-ccs-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; font-weight: 400;
        background: var(--dsw-alias-bg-secondary, rgba(127,127,127,0.15));
        color: var(--dsw-alias-text-secondary, #666); }
      .dsh-ccs-badge-linked { background: var(--dsw-alias-state-info-bg, rgba(75,123,236,0.15));
        color: var(--dsw-alias-text-link, #4b7bec); }
      .dsh-ccs-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .dsh-ccs-dot-ok { background: var(--dsw-alias-state-success-label, #2e7d32); }
      .dsh-ccs-dot-loading { background: var(--dsw-alias-state-warning-label, #b7791f); }
      .dsh-ccs-dot-error { background: var(--dsw-alias-state-error-label, #e5484d); }
      .dsh-ccs-dot-off { background: var(--dsw-alias-state-inactive-label, #9e9e9e); }
      .dsh-ccs-empty { padding: 18px; text-align: center; font-size: 12px;
        color: var(--dsw-alias-text-secondary, #666); border: 1px dashed var(--dsw-alias-border-primary, rgba(127,127,127,0.3));
        border-radius: 8px; }
      /* 技能页头部：根目录信息 + 动作按钮（置顶） */
      .dsh-ccs-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        margin-bottom: 10px; flex-shrink: 0; }
      .dsh-ccs-head .dsh-ccs-root { flex: 1 1 auto; min-width: 0; margin-bottom: 0; }
      .dsh-ccs-head-actions { display: flex; gap: 8px; flex-shrink: 0; }
      .dsh-ccs-search-row { margin-bottom: 10px; flex-shrink: 0; }
      .dsh-ccs-search { width: 100%; box-sizing: border-box; }
      /* 列表区独立滚动：flex 填充 + 上限兜底（settings 页内无外层高度约束时用） */
      .dsh-ccs-list-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; max-height: 52vh; }
      .dsh-ccs-list-scroll::-webkit-scrollbar { width: 8px; }
      .dsh-ccs-list-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2, rgba(127,127,127,0.35)); border-radius: 4px; }
      .dsh-ccs-body-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; max-height: 60vh; }
      .dsh-ccs-body-scroll::-webkit-scrollbar { width: 8px; }
      .dsh-ccs-body-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2, rgba(127,127,127,0.35)); border-radius: 4px; }
      /* 浮层高度固定，列表区撑满剩余空间，去掉兜底上限 */
      .dsh-ccs-overlay-panel .dsh-ccs-list-scroll,
      .dsh-ccs-overlay-panel .dsh-ccs-body-scroll { max-height: none; }
      /* 设置页上下文：区块撑满设置内容区剩余高度，消除底部大片留白 */
      .dsh-ccs-page-fill { flex: 1 0 auto; min-height: calc(100vh - 180px); }
      .dsh-ccs-page-fill .dsh-ccs-list-scroll,
      .dsh-ccs-page-fill .dsh-ccs-body-scroll { max-height: none; }
      .dsh-ccs-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
      .dsh-ccs-msg { font-size: 12px; margin-top: 10px; white-space: pre-wrap; word-break: break-all; }
      .dsh-ccs-msg-ok { color: var(--dsw-alias-state-success-label, #2e7d32); }
      .dsh-ccs-msg-err { color: var(--dsw-alias-state-error-label, #e5484d); }
      .dsh-ccs-fileinfo { font-size: 11px; line-height: 1.8; color: var(--dsw-alias-text-secondary, #666);
        margin: 0 0 12px; word-break: break-all; }
      .dsh-ccs-switch { appearance: none; width: 34px; height: 18px; border-radius: 9px; cursor: pointer;
        background: var(--dsw-alias-state-inactive-label, #9e9e9e); position: relative;
        transition: background 0.15s; flex-shrink: 0; outline: none; }
      .dsh-ccs-switch:checked { background: var(--dsw-alias-state-success-label, #2e7d32); }
      .dsh-ccs-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
        border-radius: 50%; background: #fff; transition: transform 0.15s; }
      .dsh-ccs-switch:checked::after { transform: translateX(16px); }
      .dsh-ccs-switch:disabled { opacity: 0.5; cursor: not-allowed; }
      .dsh-ccs-btn { appearance: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;
        background: var(--dsw-alias-bg-secondary, rgba(127,127,127,0.12)); color: var(--dsw-alias-text-primary, #222);
        border: 1px solid var(--dsw-alias-border-primary, rgba(127,127,127,0.3)); }
      .dsh-ccs-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .dsh-ccs-btn-primary { background: var(--dsw-alias-state-info-bg, rgba(75,123,236,0.15));
        border-color: var(--dsw-alias-text-link, #4b7bec); color: var(--dsw-alias-text-link, #4b7bec); }
      .dsh-ccs-btn-danger { color: var(--dsh-ccs-danger, #e5484d); border-color: var(--dsw-alias-state-error-label, #e5484d); }
      .dsh-ccs-icon-btn { appearance: none; background: none; border: none; cursor: pointer; font-size: 13px;
        color: var(--dsw-alias-text-secondary, #666); padding: 2px 4px; border-radius: 4px; }
      .dsh-ccs-icon-btn:hover { background: var(--dsw-alias-bg-secondary, rgba(127,127,127,0.12)); }
      .dsh-ccs-icon-btn-danger:hover { color: var(--dsh-ccs-danger, #e5484d); }
      .dsh-ccs-input { flex: 1; min-width: 0; padding: 7px 10px; border-radius: 6px; font-size: 12px;
        border: 1px solid var(--dsw-alias-border-primary, rgba(127,127,127,0.35));
        background: var(--dsw-alias-bg-primary, transparent); color: var(--dsw-alias-text-primary, #222); }
      .dsh-ccs-input-row { display: flex; gap: 8px; align-items: center; margin: 12px 0; }
      /* 弹框：添加/编辑 MCP（遮罩用 bg-mask-1，表面用实底 bg-base，避免透出变暗）。
         z-index 取 1100，高于全屏浮层 .dsh-ccs-overlay 的 1000。 */
      .dsh-ccs-modal-mask { position: fixed; inset: 0; z-index: 1100; display: flex;
        align-items: center; justify-content: center; padding: 24px;
        background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.45)); }
      .dsh-ccs-modal { display: flex; flex-direction: column; min-width: 0; box-sizing: border-box;
        width: min(600px, 100%); max-height: min(80vh, 680px); overflow: auto; padding: 14px 16px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3)); border-radius: 12px;
        background: var(--dsw-alias-bg-base, #fff); box-shadow: 0 12px 40px rgba(0,0,0,0.22); }
      .dsh-ccs-modal .dsh-ccs-card { border: none; background: none; padding: 0; border-radius: 0; }
      /* ===== MCP 页：对齐 dsh-plugin-capabilities 的 dpc- 设计语言 =====
         走宿主 --dsw-alias-label-*/-bg-layer-*/-border-l2/-state-* tokens，
         深浅主题自适应；共享类用 .dsh-ccs-mcp 作用域覆盖，不影响技能页。 */
      .dsh-ccs-mcp { display: flex; flex-direction: column; gap: 12px; width: 100%;
        max-width: 760px; color: var(--dsw-alias-label-primary, #222); }
      .dsh-ccs-mcp .dsh-ccs-sub { color: var(--dsw-alias-label-tertiary, #8a8a8a); }
      .dsh-ccs-mcp .dsh-ccs-root { margin: 0; color: var(--dsw-alias-label-secondary, #555); }
      .dsh-ccs-mcp .dsh-ccs-fileinfo { margin: 0; font-size: 11px; line-height: 1.8;
        color: var(--dsw-alias-label-tertiary, #8a8a8a); word-break: break-all; }
      /* MCP 工具栏：添加 / 导入 / 重新加载 */
      .dsh-ccs-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
        flex-shrink: 0; }
      /* 列表头：标题 + 计数（同 dpc-listHead） */
      .dsh-ccs-listhead { display: flex; align-items: baseline; gap: 7px; padding: 0 2px; }
      .dsh-ccs-listhead-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; }
      .dsh-ccs-listhead-count { font-size: 12px; line-height: 18px;
        color: var(--dsw-alias-label-tertiary, #8a8a8a); font-variant-numeric: tabular-nums; }
      /* 服务卡片：双列网格（同 dpc-cards/dpc-card） */
      .dsh-ccs-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
        align-items: stretch; gap: 10px; }
      @media (max-width: 680px) { .dsh-ccs-cards { grid-template-columns: minmax(0, 1fr); } }
      .dsh-ccs-mcard { display: flex; flex-direction: column; gap: 6px; min-width: 0;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3)); border-radius: 10px;
        background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.06)); padding: 10px 12px;
        transition: background 0.15s; }
      .dsh-ccs-mcard:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); }
      .dsh-ccs-mcard-off { opacity: 0.6; }
      .dsh-ccs-mcard-top { display: flex; align-items: center; gap: 8px; }
      .dsh-ccs-mcard-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; font-size: 14px; line-height: 20px; font-weight: 600;
        font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); }
      .dsh-ccs-mcard-spacer { flex: 1; }
      .dsh-ccs-mcard-desc { font-size: 12px; line-height: 18px;
        color: var(--dsw-alias-label-secondary, #555);
        font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dsh-ccs-mcard-acts { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      /* 标签（同 dpc-tag）：source 业务色、off 警示色 */
      .dsh-ccs-tag { display: inline-flex; align-items: center; min-height: 18px; flex: none;
        border-radius: 5px; padding: 1px 6px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.14));
        color: var(--dsw-alias-label-secondary, #555); font-size: 11px; line-height: 16px; white-space: nowrap; }
      .dsh-ccs-tag[data-kind='source'] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4b7bec) 10%, transparent);
        color: var(--dsw-alias-state-business-primary, #4b7bec); }
      .dsh-ccs-tag[data-kind='off'] { background: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #b7791f) 12%, transparent);
        color: var(--dsw-alias-label-secondary, #555); }
      /* MCP 消息条（同 dpc-banner）：ok 绿 / err 红 tint */
      .dsh-ccs-mcp .dsh-ccs-msg { margin: 0; display: flex; align-items: flex-start; gap: 8px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3)); border-radius: 8px;
        padding: 9px 12px; background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.06));
        font-size: 12px; line-height: 18px; white-space: pre-wrap; word-break: break-all;
        color: var(--dsw-alias-label-primary, #222); }
      .dsh-ccs-mcp .dsh-ccs-msg-ok { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2e7d32) 35%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2e7d32) 8%, transparent); }
      .dsh-ccs-mcp .dsh-ccs-msg-err { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 35%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 8%, transparent);
        color: var(--dsw-alias-state-error-primary, #e5484d); }
      .dsh-ccs-mcp .dsh-ccs-empty { margin: 0; padding: 14px 2px; text-align: left;
        font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary, #8a8a8a);
        border: none; background: none; white-space: pre-wrap; }
      /* MCP 按钮 / 输入框（作用域覆盖，不动技能页） */
      .dsh-ccs-mcp .dsh-ccs-btn { appearance: none; padding: 5px 12px; border-radius: 8px;
        cursor: pointer; font-size: 12px; line-height: 18px;
        background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.12));
        color: var(--dsw-alias-label-primary, #222);
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3)); }
      .dsh-ccs-mcp .dsh-ccs-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.16)); }
      .dsh-ccs-mcp .dsh-ccs-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .dsh-ccs-mcp .dsh-ccs-btn-primary { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4b7bec) 14%, transparent);
        border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4b7bec) 40%, transparent);
        color: var(--dsw-alias-state-business-primary, #4b7bec); font-weight: 600; }
      .dsh-ccs-mcp .dsh-ccs-btn-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4b7bec) 22%, transparent); }
      .dsh-ccs-mcp .dsh-ccs-icon-btn { appearance: none; background: none; border: none; cursor: pointer;
        font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8a8a);
        padding: 3px 8px; border-radius: 6px; }
      .dsh-ccs-mcp .dsh-ccs-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12));
        color: var(--dsw-alias-label-primary, #222); }
      .dsh-ccs-mcp .dsh-ccs-icon-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .dsh-ccs-mcp .dsh-ccs-icon-btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 12%, transparent);
        color: var(--dsw-alias-state-error-primary, #e5484d); }
      .dsh-ccs-mcp .dsh-ccs-input, .dsh-ccs-mcp .dsh-ccs-select, .dsh-ccs-mcp .dsh-ccs-textarea {
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35)); border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08));
        color: var(--dsw-alias-label-primary, #222); outline: none; }
      .dsh-ccs-mcp .dsh-ccs-input:focus-visible, .dsh-ccs-mcp .dsh-ccs-select:focus-visible,
      .dsh-ccs-mcp .dsh-ccs-textarea:focus-visible { border-color: var(--dsw-alias-state-business-primary, #4b7bec);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4b7bec) 18%, transparent); }
      .dsh-ccs-mcp .dsh-ccs-select:disabled { opacity: 0.5; cursor: not-allowed; }
      /* MCP 添加/编辑表单与导入面板：内联展开的卡片 */
      .dsh-ccs-card { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3)); border-radius: 10px;
        background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.06)); flex-shrink: 0; }
      .dsh-ccs-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .dsh-ccs-card-title { font-size: 13px; line-height: 20px; font-weight: 600; flex: 1; min-width: 0; }
      .dsh-ccs-json-toggle { display: inline-flex; align-items: center; gap: 5px; font-size: 12px;
        color: var(--dsw-alias-label-tertiary, #8a8a8a); cursor: pointer; user-select: none; }
      .dsh-ccs-json-toggle:hover { color: var(--dsw-alias-label-primary, #222); }
      .dsh-ccs-form-row { display: flex; gap: 8px; align-items: center; }
      .dsh-ccs-label { flex: none; width: 64px; font-size: 12px;
        color: var(--dsw-alias-label-tertiary, #8a8a8a); text-align: right; }
      .dsh-ccs-select { appearance: auto; padding: 6px 8px; border-radius: 8px; font-size: 12px;
        cursor: pointer; min-width: 0; }
      .dsh-ccs-textarea { width: 100%; box-sizing: border-box; min-height: 64px; padding: 7px 10px;
        border-radius: 8px; font-size: 12px;
        font-family: var(--ds-font-family-code, ui-monospace, Consolas, 'Courier New', monospace);
        line-height: 1.5; resize: vertical; }
      .dsh-ccs-textarea-tall { min-height: 120px; }
      /* 导入面板：按 agent 分组的复选列表 */
      .dsh-ccs-group { border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3));
        border-radius: 8px; overflow: hidden; margin-bottom: 8px; }
      .dsh-ccs-group-head { display: flex; align-items: center; gap: 8px; padding: 7px 10px;
        background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08)); font-size: 12px; font-weight: 600;
        color: var(--dsw-alias-label-primary, #222); cursor: pointer; user-select: none; }
      .dsh-ccs-group-head:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14)); }
      .dsh-ccs-group-count { font-weight: 400; color: var(--dsw-alias-label-tertiary, #8a8a8a);
        font-variant-numeric: tabular-nums; }
      .dsh-ccs-check-row { display: flex; align-items: center; gap: 10px; padding: 7px 10px;
        border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18));
        font-size: 12px; color: var(--dsw-alias-label-primary, #222); cursor: pointer; }
      .dsh-ccs-check-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); }
      .dsh-ccs-check-row-existing { opacity: 0.5; cursor: not-allowed; }
      .dsh-ccs-check-name { font-weight: 600; flex: none;
        font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); }
      .dsh-ccs-check-sub { flex: 1; min-width: 0; color: var(--dsw-alias-label-tertiary, #8a8a8a);
        font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      /* 侧栏 footer 入口：整行按钮（图标 + 文字），对齐原生 Settings 行。 */
      div:has(> [data-slot='sidebar.footer.action']) { flex-wrap: wrap; }
      .dsh-ccs-launcher { flex: 0 0 100%; min-width: 0; display: flex; align-items: center;
        height: 40px; margin: 0; position: relative; }
      .dsh-ccs-launcher-btn { width: 100%; min-width: 0; height: 40px; cursor: pointer;
        color: var(--dsw-alias-label-primary, #222); background: none; border: none; border-radius: 0;
        display: inline-flex; align-items: center; gap: 6px; padding: 0 8px 0 6px;
        font-family: inherit; font-size: 14px; overflow: hidden; }
      .dsh-ccs-launcher-btn:hover { background: var(--dsw-alias-interactive-bg-hover-solid, rgba(127,127,127,0.12)); }
      .dsh-ccs-launcher-icon { flex: none; display: inline-flex; align-items: center; }
      .dsh-ccs-launcher-label { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      /* 侧栏收起成 56px rail：入口缩成 36px 圆形，文字隐藏。 */
      .dsh-ccs-launcher.dsh-ccs-rail { flex: none; width: 36px; height: 36px; margin: 0; }
      .dsh-ccs-launcher.dsh-ccs-rail .dsh-ccs-launcher-btn { border-radius: 50%; justify-content: center;
        gap: 0; width: 36px; height: 36px; padding: 0; }
      .dsh-ccs-launcher.dsh-ccs-rail .dsh-ccs-launcher-label { display: none; }
    `;

    function ensureStyles() {
      if (document.getElementById('dsh-ccs-style')) return;
      const el = document.createElement('style');
      el.id = 'dsh-ccs-style';
      el.textContent = css;
      document.head.appendChild(el);
    }

    // ------------------------------------------------------------------
    // Shared bits
    // ------------------------------------------------------------------

    /** iOS 风格开关，加载即显示 checked，避免状态闪烁。 */
    const Switch = ({ checked, onChange, disabled, title }) =>
      jsx('input', {
        type: 'checkbox', className: 'dsh-ccs-switch', checked,
        onChange: (e) => onChange(e.target.checked), disabled, title,
      });

    // ------------------------------------------------------------------
    // 技能与MCP：单面板 + tab（技能 / MCP）
    // ------------------------------------------------------------------

    function CenterPanel({ pickDirectory, fillHeight }) {
      const [tab, setTab] = React.useState('skills');
      return jsx('div', {
        className: `dsh-ccs-page${fillHeight ? ' dsh-ccs-page-fill' : ''}`,
        children: [
          jsx('h2', { key: 'title', className: 'dsh-ccs-title', children: '技能与MCP' }),
          jsx('div', {
            key: 'tabs', className: 'dsh-ccs-tabs', children: [
              jsx('button', {
                key: 'skills', type: 'button',
                className: `dsh-ccs-tab${tab === 'skills' ? ' dsh-ccs-tab-active' : ''}`,
                onClick: () => setTab('skills'), children: '技能',
              }),
              jsx('button', {
                key: 'mcp', type: 'button',
                className: `dsh-ccs-tab${tab === 'mcp' ? ' dsh-ccs-tab-active' : ''}`,
                onClick: () => setTab('mcp'), children: 'MCP',
              }),
            ],
          }),
          tab === 'skills'
            ? jsx(SkillManagerSection, { key: 'body', pickDirectory })
            : jsx('div', {
                key: 'body', className: 'dsh-ccs-body-scroll',
                children: jsx(McpPanel),
              }),
        ],
      });
    }

    // ------------------------------------------------------------------
    // MCP tab：状态 + 添加/编辑/删除 + 从其他 agent 导入
    // ------------------------------------------------------------------

    const SOURCE_LABEL = {
      user: '用户级',
      'project-dsh-json': '项目 .dsh',
      'project-mcp-json': '.mcp.json',
    };

    /** 编辑模式下 RPC source → 保存作用域（写回原文件）。 */
    const SOURCE_TO_SCOPE = {
      user: 'user',
      'project-dsh-json': 'project-dsh',
      'project-mcp-json': 'project-mcp',
    };

    const SCOPE_LABEL = {
      user: '全局 ~/.dsh/mcp.json',
      'project-dsh': '当前项目 .dsh/mcp.json',
      'project-mcp': '当前项目 .mcp.json',
    };

    const AGENT_LABEL = {
      'claude-code': 'Claude Code',
      codex: 'Codex',
      cursor: 'Cursor',
      gemini: 'Gemini CLI',
    };

    function mcpSummary(row) {
      if (row.transport === 'streamable-http') return String(row.url || '');
      const args = Array.isArray(row.args) && row.args.length > 0 ? ' ' + row.args.join(' ') : '';
      return `${row.command ?? ''}${args}`.trim();
    }

    function mcpDotClass(row) {
      if (row.disabled) return 'dsh-ccs-dot-off';
      if (row.connected) return 'dsh-ccs-dot-ok';
      if (row.fiberPhase === 'failed') return 'dsh-ccs-dot-error';
      if (row.fiberPhase === 'loading' || row.fiberPhase === 'pending') return 'dsh-ccs-dot-loading';
      return 'dsh-ccs-dot-off';
    }

    /** 每行 `KEY=VALUE` 或 `KEY: VALUE` 的文本 → 对象（# 开头跳过）。 */
    function parseKvLines(text) {
      const out = {};
      for (const line of String(text || '').split('\n')) {
        const t = line.trim();
        if (t === '' || t.startsWith('#')) continue;
        const m = t.match(/^([^=:]+?)\s*[=:]\s*(.*)$/);
        if (m) out[m[1].trim()] = m[2].trim();
      }
      return out;
    }

    function kvToText(record) {
      return Object.entries(record || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    }

    function headersToText(record) {
      return Object.entries(record || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
    }

    function importSummary(server) {
      if (server.transport === 'http') return String(server.url || '');
      const args = Array.isArray(server.args) && server.args.length > 0 ? ' ' + server.args.join(' ') : '';
      return `${server.command ?? ''}${args}`.trim();
    }

    /**
     * 编辑器字段 → mcp/save payload。表单模式解析 KV / 参数文本；
     * JSON 模式直接取原始条目字段。非法输入抛 Error（消息展示给用户）。
     */
    function editorToPayload(fields) {
      if (fields.jsonMode) {
        let raw;
        try { raw = JSON.parse(fields.jsonText); } catch (e) { throw new Error(`JSON 解析失败：${e.message}`); }
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('JSON 条目必须是一个对象。');
        const isHttp = raw.command === undefined || raw.command === null || raw.command === '';
        return {
          name: fields.name, scope: fields.scope,
          transport: isHttp ? 'http' : 'stdio',
          command: raw.command, args: raw.args, env: raw.env, cwd: raw.cwd,
          url: raw.url, headers: raw.headers,
        };
      }
      return {
        name: fields.name.trim(), scope: fields.scope,
        transport: fields.transport,
        command: fields.command,
        args: fields.transport === 'stdio' ? fields.args.trim().split(/\s+/).filter(Boolean) : [],
        env: fields.transport === 'stdio' ? parseKvLines(fields.env) : {},
        // cwd 不在表单里提供：host 统一按当前项目根兜底；需要固定目录请走 JSON 编辑（写 cwd 字段）。
        url: fields.url,
        headers: fields.transport === 'http' ? parseKvLines(fields.headers) : {},
      };
    }

    /** 添加/编辑表单（含 JSON 编辑切换）。 */
    function McpEditor({ editor, setEditor, hasProject, onSaved, setMsg, setErr, busy, setBusy }) {
      const f = editor.fields;
      const setField = (patch) => setEditor({ ...editor, fields: { ...f, ...patch } });

      const save = async () => {
        setBusy(true); setErr(null);
        try {
          const payload = editorToPayload(f);
          const res = await callApi('mcp/save', payload);
          if (!res.ok) throw new Error(res.error);
          setMsg(res.message);
          try { hostCtx?.emit?.('connection/reset'); } catch { /* 静默降级 */ }
          await onSaved();
          setEditor(null);
        } catch (e) {
          setErr(e?.message || String(e));
        } finally {
          setBusy(false);
        }
      };

      const toggleJson = (on) => {
        const jsonText = f.jsonText
          || JSON.stringify(f.transport === 'http'
            ? { type: 'http', url: 'https://example.com/mcp' }
            : { command: 'npx', args: ['-y', 'package'] }, null, 2);
        setField({ jsonMode: on, jsonText });
      };

      const rows = [];
      if (editor.mode === 'add') {
        rows.push(jsx('div', {
          key: 'name', className: 'dsh-ccs-form-row', children: [
            jsx('span', { key: 'l', className: 'dsh-ccs-label', children: '名称' }),
            jsx('input', {
              key: 'v', className: 'dsh-ccs-input', value: f.name,
              onChange: (e) => setField({ name: e.target.value }),
              placeholder: '1-32 位字母数字 _ -（如 codegraph）',
            }),
          ],
        }));
      }
      if (!f.jsonMode) {
        rows.push(jsx('div', {
          key: 'transport', className: 'dsh-ccs-form-row', children: [
            jsx('span', { key: 'l', className: 'dsh-ccs-label', children: '类型' }),
            jsx('select', {
              key: 'v', className: 'dsh-ccs-select', value: f.transport,
              onChange: (e) => setField({ transport: e.target.value }),
              children: [
                jsx('option', { key: 'stdio', value: 'stdio', children: 'stdio（本地命令）' }),
                jsx('option', { key: 'http', value: 'http', children: 'HTTP（远程服务）' }),
              ],
            }),
          ],
        }));
        if (f.transport === 'stdio') {
          rows.push(
            jsx('div', {
              key: 'command', className: 'dsh-ccs-form-row', children: [
                jsx('span', { key: 'l', className: 'dsh-ccs-label', children: '命令' }),
                jsx('input', {
                  key: 'v', className: 'dsh-ccs-input', value: f.command,
                  onChange: (e) => setField({ command: e.target.value }),
                  placeholder: '如 npx / codegraph / node',
                }),
              ],
            }),
            jsx('div', {
              key: 'args', className: 'dsh-ccs-form-row', children: [
                jsx('span', { key: 'l', className: 'dsh-ccs-label', children: '参数' }),
                jsx('input', {
                  key: 'v', className: 'dsh-ccs-input', value: f.args,
                  onChange: (e) => setField({ args: e.target.value }),
                  placeholder: '空格分隔，如 serve --mcp',
                }),
              ],
            }),
            jsx('div', {
              key: 'env', className: 'dsh-ccs-form-row', children: [
                jsx('span', { key: 'l', className: 'dsh-ccs-label', children: '环境变量' }),
                jsx('textarea', {
                  key: 'v', className: 'dsh-ccs-textarea', value: f.env,
                  onChange: (e) => setField({ env: e.target.value }),
                  placeholder: '每行一条，如 API_KEY=abc',
                }),
              ],
            }),
          );
        } else {
          rows.push(
            jsx('div', {
              key: 'url', className: 'dsh-ccs-form-row', children: [
                jsx('span', { key: 'l', className: 'dsh-ccs-label', children: 'URL' }),
                jsx('input', {
                  key: 'v', className: 'dsh-ccs-input', value: f.url,
                  onChange: (e) => setField({ url: e.target.value }),
                  placeholder: 'https://example.com/mcp',
                }),
              ],
            }),
            jsx('div', {
              key: 'headers', className: 'dsh-ccs-form-row', children: [
                jsx('span', { key: 'l', className: 'dsh-ccs-label', children: '请求头' }),
                jsx('textarea', {
                  key: 'v', className: 'dsh-ccs-textarea', value: f.headers,
                  onChange: (e) => setField({ headers: e.target.value }),
                  placeholder: '每行一条，如 Authorization: Bearer xxx',
                }),
              ],
            }),
          );
        }
      } else {
        rows.push(jsx('textarea', {
          key: 'json', className: 'dsh-ccs-textarea dsh-ccs-textarea-tall', value: f.jsonText,
          onChange: (e) => setField({ jsonText: e.target.value }),
          spellCheck: false,
          placeholder: '{ "command": "…", "args": […] } 或 { "type": "http", "url": "…" }',
        }));
      }
      // 写入位置：添加时显式选择；编辑时锁定为来源文件。
      rows.push(jsx('div', {
        key: 'scope', className: 'dsh-ccs-form-row', children: [
          jsx('span', { key: 'l', className: 'dsh-ccs-label', children: '写入位置' }),
          editor.mode === 'add'
            ? jsx('select', {
                key: 'v', className: 'dsh-ccs-select', value: f.scope,
                onChange: (e) => setField({ scope: e.target.value }),
                children: [
                  jsx('option', { key: 'user', value: 'user', children: SCOPE_LABEL.user }),
                  jsx('option', {
                    key: 'project-dsh', value: 'project-dsh', disabled: !hasProject,
                    children: hasProject ? SCOPE_LABEL['project-dsh'] : `${SCOPE_LABEL['project-dsh']}（需先打开项目）`,
                  }),
                ],
              })
            : jsx('span', { key: 'v', className: 'dsh-ccs-sub', children: SCOPE_LABEL[f.scope] ?? f.scope }),
        ],
      }));

      return jsx('div', {
        className: 'dsh-ccs-card',
        children: [
          jsx('div', {
            key: 'head', className: 'dsh-ccs-card-head', children: [
              jsx('span', {
                key: 'title', className: 'dsh-ccs-card-title',
                children: editor.mode === 'add' ? '添加 MCP 服务' : `编辑 MCP 服务：${editor.name}`,
              }),
              jsx('label', {
                key: 'json', className: 'dsh-ccs-json-toggle', children: [
                  jsx('input', {
                    key: 'cb', type: 'checkbox', checked: f.jsonMode,
                    onChange: (e) => toggleJson(e.target.checked),
                  }),
                  'JSON 编辑',
                ],
              }),
            ],
          }),
          ...rows,
          jsx('div', {
            key: 'btns', className: 'dsh-ccs-form-row', children: [
              jsx('button', {
                key: 'save', type: 'button', className: 'dsh-ccs-btn dsh-ccs-btn-primary',
                disabled: busy || (editor.mode === 'add' && !f.name.trim()),
                onClick: () => void save(), children: busy ? '保存中…' : '保存',
              }),
              jsx('button', {
                key: 'cancel', type: 'button', className: 'dsh-ccs-btn',
                disabled: busy, onClick: () => setEditor(null), children: '取消',
              }),
            ],
          }),
        ],
      });
    }

    /** 从其他 agent 导入：按 agent 分组的复选列表 + 作用域选择。 */
    function McpImporter({ importer, setImporter, hasProject, onSaved, setMsg, setErr, busy, setBusy }) {
      const toggleKey = (key, on) => {
        const checked = new Set(importer.checked);
        if (on) checked.add(key); else checked.delete(key);
        setImporter({ ...importer, checked });
      };
      // 按来源 agent 分组（保持扫描顺序：claude-code / cursor / gemini / codex）。
      const groups = [];
      for (const s of importer.servers) {
        let g = groups.find((x) => x.agent === s.agent);
        if (!g) { g = { agent: s.agent, items: [] }; groups.push(g); }
        g.items.push(s);
      }

      const doImport = async () => {
        const items = importer.servers
          .filter((s) => importer.checked.has(`${s.agent}/${s.name}`))
          .map((s) => ({ agent: s.agent, name: s.name }));
        if (items.length === 0) return;
        setBusy(true); setErr(null);
        try {
          const res = await callApi('mcp/import/apply', { items, scope: importer.scope });
          if (!res.ok) throw new Error(res.error);
          setMsg(res.message);
          setImporter({ ...importer, checked: new Set(), results: res.results });
          try { hostCtx?.emit?.('connection/reset'); } catch { /* 静默降级 */ }
          await onSaved();
        } catch (e) {
          setErr(e?.message || String(e));
        } finally {
          setBusy(false);
        }
      };

      return jsx('div', {
        className: 'dsh-ccs-card',
        children: [
          jsx('div', {
            key: 'head', className: 'dsh-ccs-card-head', children: [
              jsx('span', { key: 'title', className: 'dsh-ccs-card-title', children: '从其他 agent 导入 MCP' }),
              jsx('select', {
                key: 'scope', className: 'dsh-ccs-select', value: importer.scope,
                onChange: (e) => setImporter({ ...importer, scope: e.target.value }),
                children: [
                  jsx('option', { key: 'user', value: 'user', children: SCOPE_LABEL.user }),
                  jsx('option', {
                    key: 'project-dsh', value: 'project-dsh', disabled: !hasProject,
                    children: hasProject ? SCOPE_LABEL['project-dsh'] : `${SCOPE_LABEL['project-dsh']}（需先打开项目）`,
                  }),
                ],
              }),
              jsx('button', {
                key: 'close', type: 'button', className: 'dsh-ccs-btn', disabled: busy,
                onClick: () => setImporter(null), children: '关闭',
              }),
            ],
          }),
          importer.loading
            ? jsx('div', { key: 'loading', className: 'dsh-ccs-empty', children: '正在扫描其他 agent 的配置…' })
            : null,
          !importer.loading && importer.servers.length === 0
            ? jsx('div', {
                key: 'empty', className: 'dsh-ccs-empty',
                children: '未在本机发现其他 agent 的 MCP 配置。\n支持：Claude Code（~/.claude.json）、Cursor（~/.cursor/mcp.json）、Codex（~/.codex/config.toml）、Gemini CLI（~/.gemini/settings.json）。',
              })
            : null,
          ...groups.map((g) => {
            const selectable = g.items.filter((s) => !importer.existing.has(s.name));
            const allChecked = selectable.length > 0 && selectable.every((s) => importer.checked.has(`${s.agent}/${s.name}`));
            return jsx('div', { key: g.agent, className: 'dsh-ccs-group', children: [
              jsx('label', {
                key: 'head', className: 'dsh-ccs-group-head', children: [
                  jsx('input', {
                    key: 'cb', type: 'checkbox', checked: allChecked, disabled: selectable.length === 0,
                    onChange: (e) => {
                      const checked = new Set(importer.checked);
                      for (const s of selectable) {
                        const key = `${s.agent}/${s.name}`;
                        if (e.target.checked) checked.add(key); else checked.delete(key);
                      }
                      setImporter({ ...importer, checked });
                    },
                  }),
                  `${AGENT_LABEL[g.agent] ?? g.agent}`,
                  jsx('span', { key: 'n', className: 'dsh-ccs-group-count', children: `（${g.items.length}）` }),
                ],
              }),
              ...g.items.map((s) => {
                const key = `${s.agent}/${s.name}`;
                const exists = importer.existing.has(s.name);
                return jsx('label', {
                  key, className: `dsh-ccs-check-row${exists ? ' dsh-ccs-check-row-existing' : ''}`, children: [
                    jsx('input', {
                      key: 'cb', type: 'checkbox', checked: importer.checked.has(key), disabled: exists,
                      onChange: (e) => toggleKey(key, e.target.checked),
                    }),
                    jsx('span', { key: 'name', className: 'dsh-ccs-check-name', children: s.name }),
                    jsx('span', { key: 'sub', className: 'dsh-ccs-check-sub', children: importSummary(s) || s.transport }),
                    exists ? jsx('span', { key: 'badge', className: 'dsh-ccs-badge', children: '已存在' }) : null,
                  ],
                });
              }),
            ] });
          }),
          Array.isArray(importer.results) && importer.results.length > 0
            ? jsx('div', {
                key: 'results', className: 'dsh-ccs-msg',
                children: importer.results.map((r, i) => `${r.ok ? '✓' : '✗'} ${r.name}${r.error ? `：${r.error}` : ''}`).join('\n'),
              })
            : null,
          !importer.loading && importer.servers.length > 0
            ? jsx('div', {
                key: 'btns', className: 'dsh-ccs-form-row', children: jsx('button', {
                  type: 'button', className: 'dsh-ccs-btn dsh-ccs-btn-primary', disabled: busy || importer.checked.size === 0,
                  onClick: () => void doImport(), children: busy ? '导入中…' : `导入所选（${importer.checked.size}）`,
                }),
              })
            : null,
        ],
      });
    }

    function McpPanel() {
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [msg, setMsg] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [editor, setEditor] = React.useState(null);
      const [importer, setImporter] = React.useState(null);

      const load = React.useCallback(async () => {
        try {
          setError(null);
          setStatus(await callApi('mcp/status'));
        } catch (e) {
          setError(e?.message || String(e));
        }
      }, []);

      React.useEffect(() => { void load(); }, [load]);

      const toggle = async (row) => {
        if (busy) return;
        setBusy(true); setError(null); setMsg(null);
        try {
          await callApi('mcp/setEnabled', { name: row.name, enabled: row.disabled });
          // MCP 工具目录变了：让聊天侧的会话缓存失效并重取。
          try { hostCtx?.emit?.('connection/reset'); } catch { /* 静默降级 */ }
          await load();
        } catch (e) {
          setError(e?.message || String(e));
        } finally {
          setBusy(false);
        }
      };

      const reload = async () => {
        if (busy) return;
        setBusy(true); setError(null); setMsg(null);
        try {
          await callApi('mcp/reload');
          await load();
        } catch (e) {
          setError(e?.message || String(e));
        } finally {
          setBusy(false);
        }
      };

      const openAdd = () => {
        setError(null); setMsg(null);
        setEditor({
          mode: 'add', name: '', scope: 'user',
          // name / scope 必须放 fields 里 —— 输入框、保存校验与 payload 都读 f.*。
          fields: {
            name: '', scope: 'user', transport: 'stdio', command: '', args: '', env: '', url: '', headers: '',
            jsonMode: false, jsonText: '',
          },
        });
      };

      const openEdit = async (row) => {
        setError(null); setMsg(null);
        try {
          const res = await callApi('mcp/get', { name: row.name });
          if (!res.ok) throw new Error(res.error);
          const raw = res.raw ?? {};
          const isHttp = raw.command === undefined || raw.command === null || raw.command === '';
          setEditor({
            mode: 'edit', name: row.name, scope: SOURCE_TO_SCOPE[res.source] || 'user',
            fields: {
              name: row.name,
              // 编辑模式锁定写回原来源文件（scope 必须在 fields 里才会随 payload 提交）。
              scope: SOURCE_TO_SCOPE[res.source] || 'user',
              transport: isHttp ? 'http' : 'stdio',
              command: typeof raw.command === 'string' ? raw.command : '',
              args: Array.isArray(raw.args) ? raw.args.join(' ') : '',
              env: kvToText(raw.env),
              url: typeof raw.url === 'string' ? raw.url : '',
              headers: headersToText(raw.headers),
              jsonMode: false,
              jsonText: JSON.stringify(raw, null, 2),
            },
          });
        } catch (e) {
          setError(e?.message || String(e));
        }
      };

      const removeRow = async (row) => {
        const path = status?.files?.[row.source]?.path || SOURCE_LABEL[row.source] || row.source;
        if (!confirm(`确定从 ${path} 中删除 MCP 服务 '${row.name}'？\n该操作会直接修改配置文件并卸载对应工具。`)) return;
        setBusy(true); setError(null); setMsg(null);
        try {
          const res = await callApi('mcp/remove', { name: row.name });
          if (!res.ok) throw new Error(res.error);
          setMsg(res.message);
          try { hostCtx?.emit?.('connection/reset'); } catch { /* 静默降级 */ }
          await load();
        } catch (e) {
          setError(e?.message || String(e));
        } finally {
          setBusy(false);
        }
      };

      const openImport = async () => {
        setError(null); setMsg(null);
        setImporter({ loading: true, servers: [], existing: new Set(), checked: new Set(), scope: 'user', results: null });
        try {
          const res = await callApi('mcp/import/scan');
          if (!res.ok) throw new Error(res.error);
          setImporter({
            loading: false,
            servers: Array.isArray(res.servers) ? res.servers : [],
            existing: new Set(Array.isArray(res.existing) ? res.existing : []),
            checked: new Set(), scope: 'user', results: null,
          });
        } catch (e) {
          setError(e?.message || String(e));
          setImporter(null);
        }
      };

      const servers = Array.isArray(status?.servers) ? status.servers : [];
      const files = status?.files ?? {};
      const hasProject = Boolean(status?.cwd);
      const fileLines = ['user', 'project-dsh-json', 'project-mcp-json']
        .filter((k) => files[k]?.path)
        .map((k) => `${files[k].exists ? '✓' : '—'} ${files[k].path}`);

      return jsx('div', {
        className: 'dsh-ccs-mcp',
        children: [
          jsx('div', {
            key: 'hint', className: 'dsh-ccs-sub', style: { marginBottom: 0 },
            children: '切换工作区后自动加载该项目声明的 MCP 服务；改动配置文件约 0.5 秒内生效。',
          }),
          status?.cwd
            ? jsx('div', { key: 'cwd', className: 'dsh-ccs-root', children: `当前项目：${status.cwd}` })
            : null,
          fileLines.length > 0
            ? jsx('div', {
                key: 'files', className: 'dsh-ccs-fileinfo',
                children: fileLines.join('\n'),
              })
            : null,
          // 工具栏：添加 / 导入 / 重新加载
          jsx('div', {
            key: 'toolbar', className: 'dsh-ccs-toolbar', children: [
              jsx('button', {
                key: 'add', type: 'button', className: 'dsh-ccs-btn dsh-ccs-btn-primary',
                disabled: busy || editor !== null, onClick: openAdd, children: '添加 MCP 服务…',
              }),
              jsx('button', {
                key: 'import', type: 'button', className: 'dsh-ccs-btn',
                disabled: busy || importer !== null, onClick: () => void openImport(), children: '从其他 agent 导入…',
              }),
              jsx('button', {
                key: 'reload', type: 'button', className: 'dsh-ccs-btn',
                disabled: busy, onClick: () => void reload(), children: busy ? '处理中…' : '重新加载配置',
              }),
            ],
          }),
          editor
            ? jsx('div', {
                key: 'editor', className: 'dsh-ccs-modal-mask',
                // 点遮罩关闭（点在弹框本体上不关）
                onClick: (e) => { if (e.target === e.currentTarget) setEditor(null); },
                children: jsx('div', {
                  className: 'dsh-ccs-modal',
                  children: jsx(McpEditor, {
                    editor, setEditor, hasProject, onSaved: load,
                    setMsg, setErr: setError, busy, setBusy,
                  }),
                }),
              })
            : null,
          importer
            ? jsx(McpImporter, {
                key: 'importer', importer, setImporter, hasProject, onSaved: load,
                setMsg, setErr: setError, busy, setBusy,
              })
            : null,
          error
            ? jsx('div', { key: 'err', className: 'dsh-ccs-msg dsh-ccs-msg-err', children: error })
            : null,
          msg
            ? jsx('div', { key: 'msg', className: 'dsh-ccs-msg dsh-ccs-msg-ok', children: msg })
            : null,
          servers.length === 0
            ? jsx('div', {
                key: 'empty', className: 'dsh-ccs-empty',
                children: '当前项目没有配置任何 MCP 服务。\n点击上方「添加 MCP 服务」或「从其他 agent 导入」，也可直接在 ~/.dsh/mcp.json（全局）或项目根 .dsh/mcp.json / .mcp.json（按项目）中声明。',
              })
            : [
                // 列表头：标题 + 计数（同 dpc-listHead）
                jsx('div', {
                  key: 'listhead', className: 'dsh-ccs-listhead', children: [
                    jsx('h3', { key: 't', className: 'dsh-ccs-listhead-title', children: 'MCP 服务' }),
                    jsx('span', { key: 'n', className: 'dsh-ccs-listhead-count', children: `${servers.length}` }),
                  ],
                }),
                // 服务卡片：双列网格（同 dpc-card：top / desc / acts）
                jsx('div', {
                  key: 'list', className: 'dsh-ccs-cards',
                  children: servers.map((row) => jsx('div', {
                    key: row.name, className: `dsh-ccs-mcard${row.disabled ? ' dsh-ccs-mcard-off' : ''}`, children: [
                      jsx('div', {
                        key: 'top', className: 'dsh-ccs-mcard-top', children: [
                          jsx('span', { key: 'dot', className: `dsh-ccs-dot ${mcpDotClass(row)}`, title: row.disabled ? '已停用' : row.fiberPhase ?? '未同步' }),
                          jsx('span', { key: 'name', className: 'dsh-ccs-mcard-name', title: row.name, children: row.name }),
                          row.disabled ? jsx('span', { key: 'off', className: 'dsh-ccs-tag', 'data-kind': 'off', children: '已停用' }) : null,
                          jsx('span', { key: 'sp', className: 'dsh-ccs-mcard-spacer' }),
                          jsx(Switch, {
                            key: 'sw', checked: !row.disabled, disabled: busy,
                            onChange: () => void toggle(row),
                            title: row.disabled ? '启用该 MCP 服务' : '停用该 MCP 服务（重启后保持）',
                          }),
                        ],
                      }),
                      jsx('div', {
                        key: 'desc', className: 'dsh-ccs-mcard-desc', title: mcpSummary(row) || row.transport,
                        children: mcpSummary(row) || row.transport,
                      }),
                      jsx('div', {
                        key: 'acts', className: 'dsh-ccs-mcard-acts', children: [
                          jsx('span', { key: 'src', className: 'dsh-ccs-tag', 'data-kind': 'source', children: SOURCE_LABEL[row.source] ?? row.source }),
                          row.toolCount > 0
                            ? jsx('span', { key: 'tools', className: 'dsh-ccs-tag', children: `${row.toolCount} 工具` })
                            : null,
                          jsx('span', { key: 'sp', className: 'dsh-ccs-mcard-spacer' }),
                          jsx('button', {
                            key: 'edit', type: 'button', className: 'dsh-ccs-icon-btn', disabled: busy,
                            onClick: () => void openEdit(row),
                            title: '编辑该条目（表单 / JSON）', children: '编辑',
                          }),
                          jsx('button', {
                            key: 'del', type: 'button', className: 'dsh-ccs-icon-btn dsh-ccs-icon-btn-danger', disabled: busy,
                            onClick: () => void removeRow(row),
                            title: '从配置文件删除（需确认）', children: '删除',
                          }),
                        ],
                      }),
                    ],
                  })),
                }),
              ],
        ],
      });
    }

    // ------------------------------------------------------------------
    // 技能 tab（v0.1 逻辑保留，动作改走 RPC）
    // ------------------------------------------------------------------

    function SkillManagerSection({ pickDirectory }) {
      const [skills, setSkills] = React.useState([]);
      const [root, setRoot] = React.useState(null);
      const [msg, setMsg] = React.useState(null);
      const [err, setErr] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [linkOpen, setLinkOpen] = React.useState(false);
      const [sourceDir, setSourceDir] = React.useState('');
      const [query, setQuery] = React.useState('');

      const load = React.useCallback(async () => {
        setBusy(true);
        try {
          setErr(null);
          const data = await callApi('skills/list');
          setSkills(data.skills || []);
          setRoot(data.root || null);
        } catch (e) {
          setErr(e?.message || String(e));
        } finally {
          setBusy(false);
        }
      }, []);

      React.useEffect(() => { void load(); }, [load]);

      const run = async (action, body) => {
        setBusy(true); setMsg(null); setErr(null);
        try {
          const data = await callApi(action, body || {});
          if (!data.ok) throw new Error(data.error);
          setMsg(data.message);
          // 技能目录变了：发 connection/reset 让聊天框的 '/' 技能选择器
          // 清掉按会话缓存的目录并重拉（各监听方只做缓存清理/重取，可安全复用）。
          try { hostCtx?.emit?.('connection/reset'); } catch { /* 宿主事件不可用时静默降级 */ }
          await load();
        } catch (e) {
          setErr(e?.message || String(e));
        } finally {
          setBusy(false);
        }
      };

      const openPicker = async () => {
        try {
          // pickDirectory 依赖 this（内部用 this.api.host），不能以裸函数传递后直接调用。
          if (typeof pickDirectory !== 'function') throw new Error('宿主未提供目录选择器');
          const picked = await pickDirectory();
          if (typeof picked === 'string' && picked !== '') {
            setSourceDir(picked);
            setLinkOpen(true);
          }
          // null = 用户取消，静默即可。
        } catch (e) {
          setErr(`无法打开目录选择器：${e?.message || e}。可手动粘贴路径后点击「链接」。`);
          setLinkOpen(true);
        }
      };

      // 搜索过滤：按名称 / 描述，大小写不敏感。
      const q = query.trim().toLowerCase();
      const filtered = q === ''
        ? skills
        : skills.filter((s) =>
            (s.name || '').toLowerCase().includes(q)
            || (s.description || '').toLowerCase().includes(q));

      return jsx(React.Fragment, {
        children: [
          // 头部：根目录信息（左）+ 动作按钮（右），固定在列表上方
          jsx('div', {
            key: 'head', className: 'dsh-ccs-head', children: [
              root
                ? jsx('div', { key: 'root', className: 'dsh-ccs-root', children: `技能根目录：${root}` })
                : null,
              jsx('div', {
                key: 'acts', className: 'dsh-ccs-head-actions', children: [
                  jsx('button', {
                    key: 'pick', type: 'button', className: 'dsh-ccs-btn dsh-ccs-btn-primary', disabled: busy,
                    onClick: () => void openPicker(), children: '选择目录链接…',
                  }),
                  jsx('button', {
                    key: 'refresh', type: 'button', className: 'dsh-ccs-btn', disabled: busy,
                    onClick: () => void load(), children: busy ? '处理中…' : '刷新',
                  }),
                ],
              }),
            ],
          }),
          linkOpen
            ? jsx('div', {
                key: 'link', className: 'dsh-ccs-input-row', children: [
                  jsx('input', {
                    key: 'input', className: 'dsh-ccs-input', value: sourceDir,
                    onChange: (e) => setSourceDir(e.target.value),
                    placeholder: '技能源目录（其下每个子目录视为一个技能）',
                  }),
                  jsx('button', {
                    key: 'go', type: 'button', className: 'dsh-ccs-btn dsh-ccs-btn-primary', disabled: busy || !sourceDir,
                    onClick: () => void run('skills/link', { sourceDirectory: sourceDir }),
                    children: '链接',
                  }),
                ],
              })
            : null,
          err
            ? jsx('div', { key: 'err', className: 'dsh-ccs-msg dsh-ccs-msg-err', children: err })
            : null,
          msg
            ? jsx('div', { key: 'msg', className: 'dsh-ccs-msg dsh-ccs-msg-ok', children: msg })
            : null,
          // 搜索框
          jsx('div', {
            key: 'search', className: 'dsh-ccs-search-row', children: jsx('input', {
              type: 'search', className: 'dsh-ccs-input dsh-ccs-search', value: query,
              onChange: (e) => setQuery(e.target.value),
              placeholder: '搜索技能（名称 / 描述）…',
            }),
          }),
          // 列表区：独立滚动，不带动整页
          skills.length === 0
            ? jsx('div', {
                key: 'empty', className: 'dsh-ccs-empty',
                children: '还没有任何技能。从其它目录链接技能进来，或直接把技能目录放进根目录。',
              })
            : filtered.length === 0
              ? jsx('div', { key: 'nomatch', className: 'dsh-ccs-empty', children: '没有匹配的技能。' })
              : jsx('div', {
                  key: 'scroll', className: 'dsh-ccs-list-scroll', children: jsx('div', {
                    key: 'list', className: 'dsh-ccs-list',
                    children: filtered.map((s) => jsx('div', {
                      key: s.name, className: `dsh-ccs-row${s.disabled ? ' dsh-ccs-row-disabled' : ''}`, children: jsx('div', {
                        className: 'dsh-ccs-main', children: [
                          jsx('div', {
                            key: 'text', className: 'dsh-ccs-text', children: [
                              jsx('div', {
                                key: 'name', className: 'dsh-ccs-name', children: [
                                  s.name,
                                  jsx('span', {
                                    key: 'badges', className: 'dsh-ccs-badges', children: [
                                      s.agent_created ? jsx('span', { key: 'a', className: 'dsh-ccs-badge', children: 'agent' }) : null,
                                      s.pinned ? jsx('span', { key: 'p', className: 'dsh-ccs-badge', children: '置顶' }) : null,
                                      s.linked ? jsx('span', { key: 'l', className: 'dsh-ccs-badge dsh-ccs-badge-linked', children: '已链接' }) : null,
                                    ],
                                  }),
                                ],
                              }),
                              jsx('div', { key: 'desc', className: 'dsh-ccs-sub', children: s.description || s.target || '' }),
                            ],
                          }),
                          jsx(Switch, {
                            key: 'sw', checked: !s.disabled, disabled: busy || s.layout === 'file',
                            onChange: (on) => void run(on ? 'skills/enable' : 'skills/disable', { name: s.name }),
                            title: s.layout === 'file' ? '单文件技能请手动编辑' : on_off_title(s),
                          }),
                          // 断开与删除职责不同、守卫互补，都只在必然成功时显示：
                          // 断开 = 仅移除联接点、保留源目录（junction 技能才有）；
                          // 删除 = 连源目录一起删（仅 agent 创建、非置顶、非联接）。
                          s.linked
                            ? jsx('button', {
                                key: 'unlink', type: 'button', className: 'dsh-ccs-icon-btn', disabled: busy,
                                onClick: () => void run('skills/unlink', { name: s.name }),
                                title: '移除联接点（保留源目录）', children: '断开',
                              })
                            : null,
                          s.agent_created && !s.pinned && !s.linked
                            ? jsx('button', {
                                key: 'del', type: 'button', className: 'dsh-ccs-icon-btn dsh-ccs-icon-btn-danger', disabled: busy,
                                onClick: () => { if (confirm(`确定删除技能 '${s.name}'？\n仅 agent 创建且非置顶的技能可删除。`)) void run('skills/delete', { name: s.name }); },
                                title: '删除技能目录（仅 agent 创建）', children: '删除',
                              })
                            : null,
                        ],
                      }),
                    })),
                  }),
                }),
        ],
      });
    }

    const on_off_title = (s) => (s.disabled ? '启用（模型目录 + 聊天框选择器）' : '停用（模型目录 + 聊天框选择器都隐藏）');

    // ------------------------------------------------------------------
    // 按项目 MCP：cwd 上报
    // ------------------------------------------------------------------

    /**
     * 订阅当前会话列表：cwd 变化即推送 mcp/sync。
     * sessions 服务通过 ctx.get('sessions') 获取（服务不在注入列表里，
     * ctx.sessions 永远是 undefined —— v0.2/v0.3.0 的静默失效根因）。
     * 快照形状见 SessionsPort：list.getSnapshot() → { ids, byId, current, phase }，
     * 当前会话 cwd = byId[current].cwd。subscribe 不可用时退化为 2 秒轮询兜底。
     */
    function setupProjectMcpSync(ctx) {
      let lastCwd = null;
      const sessionsOf = () => {
        try { return typeof ctx.get === 'function' ? ctx.get('sessions') : undefined; } catch { return undefined; }
      };
      const tick = () => {
        let cwd;
        try {
          const snap = sessionsOf()?.list?.getSnapshot?.();
          const id = snap?.current;
          cwd = id !== undefined ? snap?.byId?.[id]?.cwd : undefined;
        } catch { return; }
        if (typeof cwd !== 'string' || cwd === '' || cwd === lastCwd) return;
        lastCwd = cwd;
        void callApi('mcp/sync', { cwd })
          .catch((e) => console.warn('[dsh-skill-mcp] mcp sync failed:', e?.message || e));
      };
      tick();
      let disposeSub = null;
      try { disposeSub = sessionsOf()?.list?.subscribe?.(tick) ?? null; } catch { /* store 不存在 */ }
      const timer = setInterval(tick, 2000);
      ctx.effect(() => () => {
        clearInterval(timer);
        if (typeof disposeSub === 'function') disposeSub();
      });
    }

    /**
     * 侧边栏 footer 快捷入口：整行「⚡ 技能与MCP」按钮，点击打开全屏浮层。
     * 插槽只传 `wide`（侧栏是否展开）；收起时缩成 36px 圆形、隐藏文字。
     * 注意：宿主不渲染描述里的 label，文字必须由组件自绘。
     */
    function SidebarLauncher({ wide }) {
      const [open, setOpen] = React.useState(false);
      return jsx(React.Fragment, {
        children: [
          jsx('div', {
            key: 'seat', className: `dsh-ccs-launcher${wide === false ? ' dsh-ccs-rail' : ''}`,
            children: jsx('button', {
              key: 'btn', type: 'button', className: 'dsh-ccs-launcher-btn',
              title: '技能与MCP', 'aria-label': '技能与MCP', onClick: () => setOpen(true),
              children: [
                jsx('span', { key: 'icon', className: 'dsh-ccs-launcher-icon', children: '⚡' }),
                jsx('span', { key: 'label', className: 'dsh-ccs-launcher-label', children: '技能与MCP' }),
              ],
            }),
          }),
          open
            ? jsx('div', {
                key: 'overlay', className: 'dsh-ccs-overlay',
                onClick: (e) => { if (e.target === e.currentTarget) setOpen(false); },
                children: jsx('div', {
                  className: 'dsh-ccs-overlay-panel',
                  children: jsx(CenterPanel, {
                    pickDirectory: hostCtx?.workspaces
                      ? () => hostCtx.workspaces.pickDirectory()
                      : undefined,
                  }),
                }),
              })
            : null,
        ],
      });
    }

    // ------------------------------------------------------------------
    // apply
    // ------------------------------------------------------------------

    const apply = (ctx) => {
      hostCtx = ctx;
      ensureStyles();
      ctx.effect(() => () => { hostCtx = null; });

      setupProjectMcpSync(ctx);

      // 设置页：技能与MCP（settings.section 槽位）
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-skill-mcp',
        order: 99,
        label: () => '技能与MCP',
      }, (props) => jsx(CenterPanel, {
        ...props,
        fillHeight: true,
        // 注意要包一层箭头函数：方法内部依赖 this，摘下来传会丢绑定。
        pickDirectory: ctx.workspaces ? () => ctx.workspaces.pickDirectory() : undefined,
      })));

      // 侧边栏 footer ⚡ 快捷入口（sidebar.footer.action 槽位）
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-skill-mcp',
        order: 30,
        label: () => '技能与MCP',
      }, SidebarLauncher));
    };

    return { apply, inject: INJECT };
  },
});
