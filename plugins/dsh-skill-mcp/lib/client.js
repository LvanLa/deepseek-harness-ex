/**
 * dsh-skill-mcp client half (v0.2.0).
 *
 * "管理中心"插件：单面板内 tab 切换「技能 / MCP」。
 *
 * - 通信：connection RPC（官方推荐的 Client→Host 私有通道），取代 v0.1 的
 *   /api/cc-skills/* HTTP 路由。信封 {ok, value | error{message}}。
 * - 按项目 MCP：监测当前会话工作区 cwd（sessions.list store），变化即推送
 *   mcp/sync；host 热加载/热卸载对应 @deepseek-ai/dsh-mcp-client 条目。
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
      .dsh-ccs-overlay-panel { width: 640px; max-width: 92vw; max-height: 86vh; overflow-y: auto;
        background: var(--dsw-alias-bg-primary, #fff); color: var(--dsw-alias-text-primary, #222);
        border-radius: 12px; padding: 20px 22px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.2); }
      .dsh-ccs-title { margin: 0 0 6px; font-size: 16px; font-weight: 600; }
      .dsh-ccs-tabs { display: flex; gap: 2px; margin: 8px 0 14px;
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

    function CenterPanel({ pickDirectory }) {
      const [tab, setTab] = React.useState('skills');
      return jsx('div', {
        className: 'dsh-ccs-page',
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
            : jsx(McpPanel, { key: 'body' }),
        ],
      });
    }

    // ------------------------------------------------------------------
    // MCP tab：按项目自动加载的 MCP 服务状态
    // ------------------------------------------------------------------

    const SOURCE_LABEL = {
      user: '用户级',
      'project-dsh-json': '项目 .dsh',
      'project-mcp-json': '.mcp.json',
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

    function McpPanel() {
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

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
        setBusy(true); setError(null);
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
        setBusy(true); setError(null);
        try {
          await callApi('mcp/reload');
          await load();
        } catch (e) {
          setError(e?.message || String(e));
        } finally {
          setBusy(false);
        }
      };

      const servers = Array.isArray(status?.servers) ? status.servers : [];
      const files = status?.files ?? {};
      const fileLines = ['user', 'project-dsh-json', 'project-mcp-json']
        .filter((k) => files[k]?.path)
        .map((k) => `${files[k].exists ? '✓' : '—'} ${files[k].path}`);

      return jsx('div', {
        children: [
          jsx('div', {
            key: 'hint', className: 'dsh-ccs-sub', style: { marginBottom: 8 },
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
          error
            ? jsx('div', { key: 'err', className: 'dsh-ccs-msg dsh-ccs-msg-err', children: error })
            : null,
          servers.length === 0
            ? jsx('div', {
                key: 'empty', className: 'dsh-ccs-empty',
                children: '当前项目没有配置任何 MCP 服务。\n在 ~/.dsh/mcp.json（全局）或项目根 .dsh/mcp.json / .mcp.json（按项目）中声明，例如：\n{ "mcpServers": { "codegraph": { "command": "codegraph", "args": ["serve", "--mcp"] } } }',
              })
            : jsx('div', {
                key: 'list', className: 'dsh-ccs-list',
                children: servers.map((row) => jsx('div', {
                  key: row.name, className: 'dsh-ccs-row', children: [
                    jsx('span', { key: 'dot', className: `dsh-ccs-dot ${mcpDotClass(row)}`, title: row.disabled ? '已停用' : row.fiberPhase ?? '未同步' }),
                    jsx('div', {
                      key: 'main', className: 'dsh-ccs-main', children: jsx('div', {
                        className: 'dsh-ccs-text', children: [
                          jsx('div', {
                            key: 'name', className: 'dsh-ccs-name', children: [
                              row.name,
                              jsx('span', {
                                key: 'badge', className: 'dsh-ccs-badge',
                                children: SOURCE_LABEL[row.source] ?? row.source,
                              }),
                              row.toolCount > 0
                                ? jsx('span', { key: 'tools', className: 'dsh-ccs-badge', children: `${row.toolCount} 工具` })
                                : null,
                            ],
                          }),
                          jsx('div', { key: 'sub', className: 'dsh-ccs-sub', children: mcpSummary(row) || row.transport }),
                        ],
                      }),
                    }),
                    jsx(Switch, {
                      key: 'sw', checked: !row.disabled, disabled: busy,
                      onChange: () => void toggle(row),
                      title: row.disabled ? '启用该 MCP 服务' : '停用该 MCP 服务（重启后保持）',
                    }),
                  ],
                })),
              }),
          jsx('div', {
            key: 'actions', className: 'dsh-ccs-actions', children: jsx('button', {
              type: 'button', className: 'dsh-ccs-btn', disabled: busy, onClick: () => void reload(),
              children: busy ? '处理中…' : '重新加载配置',
            }),
          }),
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

      const load = React.useCallback(async () => {
        try {
          setErr(null);
          const data = await callApi('skills/list');
          setSkills(data.skills || []);
          setRoot(data.root || null);
        } catch (e) {
          setErr(e?.message || String(e));
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
          const picked = await pickDirectory();
          if (typeof picked === 'string' && picked !== '') {
            setSourceDir(picked);
            setLinkOpen(true);
          }
        } catch {
          setLinkOpen(true);
        }
      };

      return jsx(React.Fragment, {
        children: [
          root
            ? jsx('div', { key: 'root', className: 'dsh-ccs-root', children: `技能根目录：${root}` })
            : null,
          err
            ? jsx('div', { key: 'err', className: 'dsh-ccs-msg dsh-ccs-msg-err', children: err })
            : null,
          msg
            ? jsx('div', { key: 'msg', className: 'dsh-ccs-msg dsh-ccs-msg-ok', children: msg })
            : null,
          skills.length === 0
            ? jsx('div', {
                key: 'empty', className: 'dsh-ccs-empty',
                children: '还没有任何技能。从其它目录链接技能进来，或直接把技能目录放进根目录。',
              })
            : jsx('div', {
                key: 'list', className: 'dsh-ccs-list',
                children: skills.map((s) => jsx('div', {
                  key: s.name, className: 'dsh-ccs-row', children: jsx('div', {
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
                      jsx('button', {
                        key: 'unlink', type: 'button', className: 'dsh-ccs-icon-btn', disabled: busy,
                        onClick: () => void run('skills/unlink', { name: s.name }),
                        title: '移除联接点（保留源目录）', children: '断开',
                      }),
                      jsx('button', {
                        key: 'del', type: 'button', className: 'dsh-ccs-icon-btn dsh-ccs-icon-btn-danger', disabled: busy,
                        onClick: () => { if (confirm(`确定删除技能 '${s.name}'？\n仅 agent 创建且非置顶的技能可删除。`)) void run('skills/delete', { name: s.name }); },
                        title: '删除技能目录（仅 agent 创建）', children: '删除',
                      }),
                    ],
                  }),
                })),
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
          jsx('div', {
            key: 'actions', className: 'dsh-ccs-actions', children: [
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
      });
    }

    const on_off_title = (s) => (s.disabled ? '启用（模型目录 + 聊天框选择器）' : '停用（模型目录 + 聊天框选择器都隐藏）');

    // ------------------------------------------------------------------
    // 按项目 MCP：cwd 上报
    // ------------------------------------------------------------------

    /**
     * 订阅当前会话列表：cwd 变化即推送 mcp/sync。
     * subscribe 不可用时退化为 2 秒轮询兜底。
     */
    function setupProjectMcpSync(ctx) {
      let lastCwd = null;
      const tick = () => {
        let cwd;
        try {
          const snap = ctx.sessions?.list?.getSnapshot?.();
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
      try { disposeSub = ctx.sessions.list.subscribe(tick); } catch { /* store 不存在 */ }
      const timer = setInterval(tick, 2000);
      ctx.effect(() => () => {
        clearInterval(timer);
        if (typeof disposeSub === 'function') disposeSub();
      });
    }

    /** 侧边栏 footer ⚡ 快捷入口：点击打开技能与MCP全屏浮层。 */
    function SidebarLauncher() {
      const [open, setOpen] = React.useState(false);
      return jsx(React.Fragment, {
        children: [
          jsx('button', {
            key: 'btn', type: 'button', className: 'dsh-ccs-icon-btn',
            title: '技能与MCP', onClick: () => setOpen(true), children: '⚡',
          }),
          open
            ? jsx('div', {
                key: 'overlay', className: 'dsh-ccs-overlay',
                onClick: (e) => { if (e.target === e.currentTarget) setOpen(false); },
                children: jsx('div', {
                  className: 'dsh-ccs-overlay-panel',
                  children: jsx(CenterPanel, { pickDirectory: hostCtx?.workspaces?.pickDirectory }),
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
      }, (props) => jsx(CenterPanel, { ...props, pickDirectory: ctx.workspaces?.pickDirectory })));

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
