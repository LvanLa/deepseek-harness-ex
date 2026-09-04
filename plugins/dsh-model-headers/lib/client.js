/**
 * dsh-model-headers client half (v0.1.2).
 *
 * 设置页 section「模型请求头」：
 *   - 规则卡片列表（双列）：启停开关 / 模型通配符 / 头摘要 / 编辑 / 删除（二次确认）
 *   - 添加·编辑弹框：模型下拉（combobox：点选 settings.yaml 现有模型 / 推导通配符 / 手输任意）+ 头键值行（值可插入 ${sessionId} 变量）
 *   - 通信：connection RPC 通道 '/model-headers'，信封 {ok, value | error{message}}
 * - 挂载点：settings.section 槽位（order 100，排在「技能与MCP」之后）。
 */
window.__ModuleLoader__.load({
  id: "dsh-model-headers",
  factory: (require) => {
    const React = require("react");
    // 不用 jsx-runtime：某些 shell 构建里 require("react/jsx-runtime") 的命名导出
    // 不可靠（jsx 为 undefined → "jsx is not a function"），createElement 最稳。
    const jsx = (type, props) => React.createElement(type, props);

    const INJECT = ["slots", "connection"];

    /** connection RPC 通道（与 host 半一致）。 */
    const RPC_CHANNEL = "/model-headers";

    let hostCtx = null;

    async function callApi(endpoint, body = {}) {
      const result = await hostCtx.connection.rpc.call(RPC_CHANNEL, endpoint, body);
      if (result.ok) return result.value;
      throw new Error(result.error?.message || `rpc ${endpoint} failed`);
    }

    // ------------------------------------------------------------------
    // Styles（沿用 dsh-ccs/dpc 设计语言，类前缀 dsh-mh-）
    // ------------------------------------------------------------------

    const css = `
      .dsh-mh-page { display: flex; flex-direction: column; gap: 12px; width: 100%;
        max-width: 760px; color: var(--dsw-alias-label-primary, #222);
        flex: 1 0 auto; min-height: calc(100vh - 180px); }
      .dsh-mh-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
      .dsh-mh-desc { margin: 0; display: flex; align-items: flex-start; gap: 8px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3)); border-radius: 8px;
        padding: 9px 12px; background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.06));
        font-size: 12px; line-height: 18px; white-space: pre-wrap;
        color: var(--dsw-alias-label-secondary, #555); }
      .dsh-mh-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; flex-shrink: 0; }
      .dsh-mh-listhead { display: flex; align-items: baseline; gap: 7px; padding: 0 2px; }
      .dsh-mh-listhead-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; }
      .dsh-mh-listhead-count { font-size: 12px; line-height: 18px;
        color: var(--dsw-alias-label-tertiary, #8a8a8a); font-variant-numeric: tabular-nums; }
      .dsh-mh-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
        align-items: stretch; gap: 10px; }
      @media (max-width: 680px) { .dsh-mh-cards { grid-template-columns: minmax(0, 1fr); } }
      .dsh-mh-card { display: flex; flex-direction: column; gap: 6px; min-width: 0;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3)); border-radius: 10px;
        background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.06)); padding: 10px 12px;
        transition: background 0.15s; }
      .dsh-mh-card:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); }
      .dsh-mh-card-off { opacity: 0.6; }
      .dsh-mh-card-top { display: flex; align-items: center; gap: 8px; }
      .dsh-mh-card-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; font-size: 14px; line-height: 20px; font-weight: 600;
        font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); }
      .dsh-mh-card-spacer { flex: 1; }
      .dsh-mh-card-headers { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .dsh-mh-card-header-line { font-size: 12px; line-height: 18px;
        color: var(--dsw-alias-label-secondary, #555);
        font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dsh-mh-card-header-line .dsh-mh-var { color: var(--dsw-alias-state-business-primary, #4b7bec); }
      .dsh-mh-tag { display: inline-flex; align-items: center; min-height: 18px; flex: none;
        border-radius: 5px; padding: 1px 6px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.14));
        color: var(--dsw-alias-label-secondary, #555); font-size: 11px; line-height: 16px; white-space: nowrap; }
      .dsh-mh-tag[data-kind='off'] { background: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #b7791f) 12%, transparent);
        color: var(--dsw-alias-label-secondary, #555); }
      .dsh-mh-switch { appearance: none; width: 34px; height: 18px; border-radius: 9px; cursor: pointer;
        background: var(--dsw-alias-state-inactive-label, #9e9e9e); position: relative;
        transition: background 0.15s; flex-shrink: 0; outline: none; }
      .dsh-mh-switch:checked { background: var(--dsw-alias-state-success-label, #2e7d32); }
      .dsh-mh-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
        border-radius: 50%; background: #fff; transition: transform 0.15s; }
      .dsh-mh-switch:checked::after { transform: translateX(16px); }
      .dsh-mh-btn { appearance: none; display: inline-flex; align-items: center; justify-content: center;
        padding: 6px 14px; border-radius: 8px; cursor: pointer;
        font-size: 12px; line-height: 18px;
        background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.12));
        color: var(--dsw-alias-label-primary, #222);
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3)); }
      .dsh-mh-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.16)); }
      .dsh-mh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .dsh-mh-btn-primary { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4b7bec) 14%, transparent);
        border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4b7bec) 40%, transparent);
        color: var(--dsw-alias-state-business-primary, #4b7bec); font-weight: 600; }
      .dsh-mh-btn-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4b7bec) 22%, transparent); }
      .dsh-mh-icon-btn { appearance: none; background: none; border: none; cursor: pointer;
        font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8a8a);
        padding: 3px 8px; border-radius: 6px; }
      .dsh-mh-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12));
        color: var(--dsw-alias-label-primary, #222); }
      .dsh-mh-icon-btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 12%, transparent);
        color: var(--dsw-alias-state-error-primary, #e5484d); }
      .dsh-mh-input { border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35)); border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08));
        color: var(--dsw-alias-label-primary, #222); outline: none;
        padding: 6px 11px; font-size: 13px; line-height: 18px; min-width: 0; }
      .dsh-mh-input:focus-visible { border-color: var(--dsw-alias-state-business-primary, #4b7bec);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4b7bec) 18%, transparent); }
      .dsh-mh-mono { font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); }
      .dsh-mh-msg { margin: 0; display: flex; align-items: flex-start; gap: 8px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3)); border-radius: 8px;
        padding: 9px 12px; background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.06));
        font-size: 12px; line-height: 18px; white-space: pre-wrap; word-break: break-all;
        color: var(--dsw-alias-label-primary, #222); }
      .dsh-mh-msg-ok { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2e7d32) 35%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2e7d32) 8%, transparent); }
      .dsh-mh-msg-err { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 35%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 8%, transparent);
        color: var(--dsw-alias-state-error-primary, #e5484d); }
      .dsh-mh-empty { margin: 0; padding: 14px 2px; font-size: 13px; line-height: 20px;
        color: var(--dsw-alias-label-tertiary, #8a8a8a); white-space: pre-wrap; }
      /* 弹框 */
      .dsh-mh-modal-mask { position: fixed; inset: 0; z-index: 1100; display: flex;
        align-items: center; justify-content: center; padding: 24px;
        background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.45)); backdrop-filter: blur(2px); }
      .dsh-mh-modal { display: flex; flex-direction: column; min-width: 0; box-sizing: border-box;
        width: min(520px, 100%); max-height: min(80vh, 680px); overflow: auto; padding: 20px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3)); border-radius: 14px;
        background: var(--dsw-alias-bg-base, #fff); box-shadow: 0 16px 48px rgba(0,0,0,0.24); }
      .dsh-mh-modal-title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600;
        color: var(--dsw-alias-label-primary, #222); }
      .dsh-mh-modal-desc { margin: 4px 0 0; font-size: 12px; line-height: 18px;
        color: var(--dsw-alias-label-tertiary, #8a8a8a); }
      .dsh-mh-field { margin-top: 16px; }
      .dsh-mh-field-label { display: block; margin: 0 0 6px; font-size: 11px; line-height: 16px;
        font-weight: 500; color: var(--dsw-alias-label-secondary, #555); }
      .dsh-mh-hv-row { display: flex; gap: 8px; align-items: center; }
      .dsh-mh-hv-row + .dsh-mh-hv-row { margin-top: 8px; }
      .dsh-mh-hv-name { flex: 2 1 0; min-width: 0; }
      .dsh-mh-hv-value { flex: 3 1 0; min-width: 0; }
      .dsh-mh-hv-var { flex: none; height: 32px; padding: 0 10px; font-size: 11px; }
      .dsh-mh-hv-del { flex: none; width: 32px; height: 32px; padding: 0; display: inline-flex;
        align-items: center; justify-content: center; border-radius: 8px; }
      .dsh-mh-btn-dashed { width: 100%; justify-content: center; margin-top: 8px; height: 30px;
        border-style: dashed; background: transparent; color: var(--dsw-alias-label-secondary, #555); }
      .dsh-mh-btn-dashed:hover:not(:disabled) { color: var(--dsw-alias-state-business-primary, #4b7bec);
        border-color: var(--dsw-alias-state-business-primary, #4b7bec); background: transparent; }
      .dsh-mh-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px;
        padding-top: 14px; border-top: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.18)); }
      /* 模型下拉（combobox：可手输通配符，也可点选；fixed 定位避免撑出弹框滚动条） */
      @keyframes dsh-mh-pop { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
      .dsh-mh-combo { position: relative; flex: 1; min-width: 0; }
      .dsh-mh-combo-input { width: 100%; box-sizing: border-box; }
      .dsh-mh-combo-menu { position: fixed; z-index: 1200; box-sizing: border-box;
        overflow: auto; padding: 5px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3)); border-radius: 10px;
        background: var(--dsw-alias-bg-base, #fff); box-shadow: 0 10px 32px rgba(0,0,0,0.16);
        animation: dsh-mh-pop 0.14s ease; }
      .dsh-mh-combo-group { margin: 4px 8px 2px; font-size: 10px; line-height: 14px; font-weight: 600;
        letter-spacing: 0.03em; color: var(--dsw-alias-label-tertiary, #8a8a8a); user-select: none; }
      .dsh-mh-combo-opt { display: flex; align-items: center; gap: 4px; width: 100%; box-sizing: border-box;
        appearance: none; border: none; background: none; cursor: pointer; text-align: left;
        border-radius: 7px; padding: 4px 10px; transition: background 0.15s; }
      .dsh-mh-combo-opt:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); }
      .dsh-mh-combo-opt.is-active { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4b7bec) 10%, transparent); }
      .dsh-mh-combo-opt-check { flex: none; width: 14px; text-align: center; font-size: 11px; line-height: 18px;
        color: var(--dsw-alias-state-business-primary, #4b7bec); }
      .dsh-mh-combo-opt-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; font-size: 12px; line-height: 18px;
        font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace);
        color: var(--dsw-alias-label-primary, #222); }
      .dsh-mh-combo-opt.is-wild .dsh-mh-combo-opt-name {
        color: var(--dsw-alias-state-business-primary, #4b7bec); font-weight: 600; }
      .dsh-mh-combo-empty { padding: 8px 10px; font-size: 12px; line-height: 18px;
        color: var(--dsw-alias-label-tertiary, #8a8a8a); white-space: pre-wrap; }
    `;

    function ensureStyles() {
      if (document.getElementById('dsh-mh-style')) return;
      const el = document.createElement('style');
      el.id = 'dsh-mh-style';
      el.textContent = css;
      document.head.appendChild(el);
    }

    // ------------------------------------------------------------------
    // UI 组件
    // ------------------------------------------------------------------

    const Switch = ({ checked, onChange, disabled, title }) =>
      jsx('input', {
        type: 'checkbox', className: 'dsh-mh-switch', checked,
        onChange: (e) => onChange(e.target.checked), disabled, title,
      });

    /** 头值里的 ${sessionId} 变量着色展示。 */
    function renderHeaderValue(value) {
      const parts = String(value).split('${sessionId}');
      if (parts.length === 1) return value;
      const children = [];
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] !== '') children.push(parts[i]);
        if (i < parts.length - 1) {
          children.push(jsx('span', { key: `v${i}`, className: 'dsh-mh-var', children: '${sessionId}' }));
        }
      }
      return children;
    }

    /**
     * 模型下拉（combobox）：可手输任意通配符，也可点选。
     * 选项按 provider（供应商）分组展示，末组为推导通配符（*、grok-*、gpt-5.6-* …）。
     * fixed 定位依输入框实时测量（打开帧 + 渲染帧 + models 就绪时重测），避免首开尺寸错位。
     */
    function ModelCombo({ value, models, onChange }) {
      const [open, setOpen] = React.useState(false);
      const [query, setQuery] = React.useState(''); // 本次打开后手动输入的过滤词（打开时重置，避免只剩已选值）
      const [menuStyle, setMenuStyle] = React.useState(null);
      const ref = React.useRef(null);
      const inputRef = React.useRef(null);

      // 供应商 → 模型 id 分组（保持配置出现顺序）
      const groups = React.useMemo(() => {
        const map = new Map();
        for (const m of models || []) {
          let ids = map.get(m.provider);
          if (!ids) map.set(m.provider, (ids = []));
          if (!ids.includes(m.id)) ids.push(m.id);
        }
        return [...map.entries()].map(([provider, ids]) => ({ provider, ids }));
      }, [models]);

      // 通配符推导：* + 去掉最后一个 - 段的前缀
      const wildcards = React.useMemo(() => {
        const set = new Set(['*']);
        for (const m of models || []) {
          const parts = m.id.split('-');
          if (parts.length >= 2) set.add(`${parts.slice(0, -1).join('-')}-*`);
        }
        return [...set];
      }, [models]);

      /** 依输入框位置计算下拉的 fixed 定位与高度；下方空间不足时上翻。 */
      const placeMenu = React.useCallback(() => {
        const r = inputRef.current?.getBoundingClientRect();
        if (!r) return;
        const ITEM = 26, HEADER = 18, PAD = 12, GAP = 4;
        const rowCount = groups.reduce((n, g) => n + g.ids.length, 0) + wildcards.length;
        const headerCount = groups.length + (wildcards.length > 0 ? 1 : 0);
        const natural = Math.min(rowCount * ITEM + headerCount * HEADER + PAD, 440);
        const below = window.innerHeight - r.bottom - 12;
        const above = r.top - 12;
        const openUp = below < Math.min(natural, 160) && above > below;
        const maxH = Math.max(120, Math.min(natural, openUp ? above : below));
        setMenuStyle({
          left: r.left,
          width: r.width,
          maxHeight: maxH,
          ...(openUp ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
        });
      }, [groups, wildcards]);

      const openMenu = React.useCallback(() => {
        setQuery('');
        placeMenu();
        setOpen(true);
        // autoFocus 可能早于最终布局，下一帧再测一次保证首开位置/宽度正确
        requestAnimationFrame(placeMenu);
      }, [placeMenu]);

      React.useEffect(() => {
        if (!open) return;
        const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        const onReposition = () => { placeMenu(); };
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('keydown', onKey);
        // 弹框/页面滚动与窗口缩放时跟随重定位
        window.addEventListener('resize', onReposition);
        window.addEventListener('scroll', onReposition, true);
        return () => {
          document.removeEventListener('mousedown', onDoc);
          document.removeEventListener('keydown', onKey);
          window.removeEventListener('resize', onReposition);
          window.removeEventListener('scroll', onReposition, true);
        };
      }, [open, placeMenu]);

      // models 异步就绪后重测一次，修正首开时的加载态尺寸
      React.useEffect(() => {
        if (open) placeMenu();
      }, [open, groups, wildcards, placeMenu]);

      // 打开/过滤后把已选中项滚动进可视区
      React.useEffect(() => {
        if (!open) return;
        const el = ref.current?.querySelector('.dsh-mh-combo-opt.is-active');
        el?.scrollIntoView?.({ block: 'nearest' });
      }, [open, query]);

      const q = query.trim().toLowerCase();
      const match = (s) => q === '' || q === '*' || s.toLowerCase().includes(q);
      const visibleGroups = groups
        .map((g) => ({ ...g, ids: g.ids.filter(match) }))
        .filter((g) => g.ids.length > 0);
      const visibleWildcards = wildcards.filter(match);
      const current = String(value);

      const optButton = (val, wild, key) => jsx('button', {
        key, type: 'button',
        className: `dsh-mh-combo-opt${wild ? ' is-wild' : ''}${val === current ? ' is-active' : ''}`,
        onClick: () => { onChange(val); setOpen(false); },
        children: [
          jsx('span', { key: 'c', className: 'dsh-mh-combo-opt-check',
            children: val === current ? '✓' : '' }),
          jsx('span', { key: 'n', className: 'dsh-mh-combo-opt-name', children: val }),
        ],
      });

      const items = [];
      for (const g of visibleGroups) {
        items.push(jsx('div', { key: `g:${g.provider}`, className: 'dsh-mh-combo-group',
          children: g.provider }));
        for (const id of g.ids) items.push(optButton(id, false, `m:${g.provider}:${id}`));
      }
      if (visibleWildcards.length > 0) {
        items.push(jsx('div', { key: 'g:wild', className: 'dsh-mh-combo-group', children: '通配符' }));
        for (const w of visibleWildcards) items.push(optButton(w, true, `w:${w}`));
      }

      return jsx('div', {
        ref, className: 'dsh-mh-combo',
        children: [
          jsx('input', {
            key: 'i', ref: inputRef, className: 'dsh-mh-input dsh-mh-mono dsh-mh-combo-input',
            placeholder: 'grok-*（可手输通配符，或点选下拉项）', value,
            onChange: (e) => { onChange(e.target.value); setQuery(e.target.value); showMenu(); },
            onFocus: openMenu,
          }),
          open && jsx('div', { key: 'menu', className: 'dsh-mh-combo-menu', style: menuStyle, children:
            models === null
              ? jsx('div', { className: 'dsh-mh-combo-empty', children: '读取模型列表…' })
              : items.length === 0
                ? jsx('div', { className: 'dsh-mh-combo-empty', children: '无匹配项，可直接使用通配符（如 grok-*）' })
                : items,
          }),
        ],
      });
    }

    /** 编辑弹框：模型通配符（下拉可点选 / 可手输）+ 头键值行。 */
    function RuleEditor({ initial, onClose, onSaved }) {
      const [model, setModel] = React.useState(initial?.model || '');
      const [models, setModels] = React.useState(null); // [{ provider, id }] | null 加载中
      const [pairs, setPairs] = React.useState(() => {
        const entries = Object.entries(initial?.headers || {});
        return entries.length > 0 ? entries.map(([name, value]) => ({ name, value })) : [{ name: '', value: '' }];
      });
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      React.useEffect(() => {
        let alive = true;
        callApi('models/list')
          .then((d) => { if (alive) setModels(d.models || []); })
          .catch(() => { if (alive) setModels([]); });
        return () => { alive = false; };
      }, []);

      const setPair = (i, patch) => {
        setPairs((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));
      };
      const removePair = (i) => {
        setPairs((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev));
      };

      const save = async () => {
        setError(null);
        const headers = {};
        for (const p of pairs) {
          if (p.name.trim() !== '') headers[p.name.trim()] = p.value;
        }
        if (model.trim() === '') { setError('模型通配符不能为空'); return; }
        if (Object.keys(headers).length === 0) {
          setError('至少需要一条请求头（头名称不能为空）');
          return;
        }
        setBusy(true);
        try {
          const saved = await callApi('headers/save', {
            rule: { id: initial?.id, enabled: initial?.enabled !== false, model, headers },
          });
          onSaved(saved.rule);
        } catch (e) {
          setError(e.message);
          setBusy(false);
        }
      };

      return jsx('div', {
        className: 'dsh-mh-modal-mask',
        onClick: (e) => { if (e.target === e.currentTarget && !busy) onClose(); },
        children: jsx('div', {
          className: 'dsh-mh-modal',
          children: [
            jsx('h3', { key: 't', className: 'dsh-mh-modal-title',
              children: initial?.id ? '编辑规则' : '添加规则' }),
            jsx('p', { key: 'd', className: 'dsh-mh-modal-desc',
              children: '匹配模型通配符的 LLM 请求将在发出前注入下列自定义请求头' }),
            jsx('div', { key: 'f1', className: 'dsh-mh-field', children: [
              jsx('label', { key: 'l', className: 'dsh-mh-field-label',
                children: '模型匹配（支持 * 通配符，不区分大小写）' }),
              jsx(ModelCombo, { key: 'c', value: model, models, onChange: setModel }),
            ] }),
            jsx('div', { key: 'f2', className: 'dsh-mh-field', children: [
              jsx('label', { key: 'l', className: 'dsh-mh-field-label',
                children: '注入头（值支持 ${sessionId} 变量）' }),
              ...pairs.map((p, i) => jsx('div', { key: i, className: 'dsh-mh-hv-row', children: [
                jsx('input', {
                  key: 'n', className: 'dsh-mh-input dsh-mh-mono dsh-mh-hv-name',
                  placeholder: '头名称，如 X-Grok-Conv-Id', value: p.name,
                  onChange: (e) => setPair(i, { name: e.target.value }),
                }),
                jsx('input', {
                  key: 'v', className: 'dsh-mh-input dsh-mh-mono dsh-mh-hv-value',
                  placeholder: '固定值 或 ${sessionId}', value: p.value,
                  onChange: (e) => setPair(i, { value: e.target.value }),
                }),
                jsx('button', {
                  key: 'sv', type: 'button', className: 'dsh-mh-btn dsh-mh-hv-var',
                  title: '插入 ${sessionId} 变量',
                  onClick: () => setPair(i, { value: `${p.value}\${sessionId}` }),
                  children: '+会话ID',
                }),
                jsx('button', {
                  key: 'x', type: 'button', className: 'dsh-mh-icon-btn dsh-mh-icon-btn-danger dsh-mh-hv-del',
                  title: '移除该头', disabled: pairs.length === 1,
                  onClick: () => removePair(i), children: '✕',
                }),
              ] })),
              jsx('button', {
                key: 'add', type: 'button', className: 'dsh-mh-btn dsh-mh-btn-dashed',
                onClick: () => setPairs((prev) => [...prev, { name: '', value: '' }]),
                children: '+ 添加头',
              }),
            ] }),
            error && jsx('div', { key: 'e', className: 'dsh-mh-msg dsh-mh-msg-err', style: { marginTop: '12px' }, children: error }),
            jsx('div', { key: 'a', className: 'dsh-mh-modal-actions', children: [
              jsx('button', { key: 'c', type: 'button', className: 'dsh-mh-btn', disabled: busy, onClick: onClose, children: '取消' }),
              jsx('button', { key: 's', type: 'button', className: 'dsh-mh-btn dsh-mh-btn-primary', disabled: busy, onClick: () => void save(), children: busy ? '保存中…' : '保存' }),
            ] }),
          ],
        }),
      });
    }

    function HeadersPanel() {
      const [rules, setRules] = React.useState(null);
      const [configFile, setConfigFile] = React.useState('');
      const [message, setMessage] = React.useState(null); // { kind: 'ok'|'err', text }
      const [editing, setEditing] = React.useState(null); // rule 对象（{} = 新增）
      const [busyId, setBusyId] = React.useState(null);

      const reload = React.useCallback(async () => {
        try {
          const data = await callApi('headers/list');
          setRules(data.rules || []);
          setConfigFile(data.configFile || '');
        } catch (e) {
          setMessage({ kind: 'err', text: `加载失败：${e.message}` });
        }
      }, []);

      React.useEffect(() => { void reload(); }, [reload]);

      const run = async (endpoint, body, okText) => {
        const id = body?.id || 'new';
        setBusyId(id);
        try {
          await callApi(endpoint, body);
          setMessage(okText ? { kind: 'ok', text: okText } : null);
          await reload();
        } catch (e) {
          setMessage({ kind: 'err', text: `${endpoint} 失败：${e.message}` });
        } finally {
          setBusyId(null);
        }
      };

      const remove = (rule) => {
        if (!confirm(`确定删除规则 '${rule.model}'？\n该规则的所有自定义请求头将停止注入。`)) return;
        void run('headers/remove', { id: rule.id }, `已删除规则 '${rule.model}'。`);
      };

      const toggle = (rule, enabled) => {
        void run('headers/toggle', { id: rule.id, enabled }, enabled ? `已启用 '${rule.model}'。` : `已停用 '${rule.model}'。`);
      };

      const enabledCount = (rules || []).filter((r) => r.enabled).length;

      return jsx('div', { className: 'dsh-mh-page', children: [
        jsx('h2', { key: 't', className: 'dsh-mh-title', children: '模型请求头' }),
        jsx('div', { key: 'd', className: 'dsh-mh-desc',
          children: '按模型名匹配 LLM 请求并注入自定义请求头。\n值支持固定字符串和 ${sessionId}（运行时替换为当前会话 ID，适合中转的会话粘性/缓存路由）。' }),
        jsx('div', { key: 'tb', className: 'dsh-mh-toolbar', children: [
          jsx('button', { key: 'add', type: 'button', className: 'dsh-mh-btn dsh-mh-btn-primary',
            onClick: () => setEditing({}), children: '添加规则' }),
        ] }),
        jsx('div', { key: 'lh', className: 'dsh-mh-listhead', children: [
          jsx('span', { key: 'lt', className: 'dsh-mh-listhead-title', children: '规则' }),
          rules && jsx('span', { key: 'lc', className: 'dsh-mh-listhead-count',
            children: `${rules.length} 条 · 启用 ${enabledCount}` }),
        ] }),
        message && jsx('div', { key: 'msg',
          className: `dsh-mh-msg ${message.kind === 'ok' ? 'dsh-mh-msg-ok' : 'dsh-mh-msg-err'}`,
          children: message.text }),
        rules === null
          ? jsx('div', { key: 'loading', className: 'dsh-mh-empty', children: '加载中…' })
          : rules.length === 0
            ? jsx('div', { key: 'empty', className: 'dsh-mh-empty',
              children: '还没有规则。点击「添加规则」，例如：\n模型 grok-* → 头 X-Grok-Conv-Id: ${sessionId}' })
            : jsx('div', { key: 'cards', className: 'dsh-mh-cards', children:
              rules.map((rule) => jsx('div', {
                key: rule.id,
                className: `dsh-mh-card${rule.enabled ? '' : ' dsh-mh-card-off'}`,
                children: [
                  jsx('div', { key: 'top', className: 'dsh-mh-card-top', children: [
                    jsx(Switch, { key: 'sw', checked: rule.enabled, disabled: busyId === rule.id,
                      title: rule.enabled ? '停用' : '启用', onChange: (v) => toggle(rule, v) }),
                    jsx('span', { key: 'n', className: 'dsh-mh-card-name', title: rule.model, children: rule.model }),
                    !rule.enabled && jsx('span', { key: 'off', className: 'dsh-mh-tag', 'data-kind': 'off', children: '已停用' }),
                    jsx('span', { key: 'sp', className: 'dsh-mh-card-spacer' }),
                    jsx('button', { key: 'e', type: 'button', className: 'dsh-mh-icon-btn', title: '编辑',
                      disabled: busyId === rule.id, onClick: () => setEditing(rule), children: '编辑' }),
                    jsx('button', { key: 'del', type: 'button', className: 'dsh-mh-icon-btn dsh-mh-icon-btn-danger', title: '删除',
                      disabled: busyId === rule.id, onClick: () => remove(rule), children: '删除' }),
                  ] }),
                  jsx('div', { key: 'hs', className: 'dsh-mh-card-headers', children:
                    Object.entries(rule.headers || {}).map(([name, value]) =>
                      jsx('div', { key: name, className: 'dsh-mh-card-header-line',
                        children: [`${name}: `, renderHeaderValue(value)] })) }),
                ],
              })) }),
        configFile && jsx('div', { key: 'cfg', className: 'dsh-mh-empty', style: { fontSize: '11px' },
          children: `配置文件：${configFile}（外部编辑自动热加载）` }),
        editing && jsx(RuleEditor, {
          key: editing.id || 'new',
          initial: editing,
          onClose: () => setEditing(null),
          onSaved: (rule) => {
            setEditing(null);
            setMessage({ kind: 'ok', text: `已保存规则 '${rule.model}'，即刻生效。` });
            void reload();
          },
        }),
      ] });
    }

    // ------------------------------------------------------------------
    // apply
    // ------------------------------------------------------------------

    const apply = (ctx) => {
      hostCtx = ctx;
      ensureStyles();
      ctx.effect(() => () => { hostCtx = null; });

      // 设置页：模型请求头（settings.section 槽位，排在「技能与MCP」之后）
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-model-headers',
        order: 100,
        label: () => '模型请求头',
      }, (props) => jsx(HeadersPanel, props)));
    };

    return { apply, inject: INJECT };
  },
});
