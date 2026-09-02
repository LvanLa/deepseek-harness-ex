/**
 * dsh-skill-linker client half.
 *
 * "技能管理" page inside the settings dialog, registered through the
 * `settings.section` extension point (the same seam ui-settings-plugins uses):
 *   - lists ~/.dsh/skills with link / pinned / disabled / agent flags
 *   - enable/disable is the row's primary action (frontmatter
 *     `disable-model-invocation`, host routes disable/enable)
 *   - "添加软链接": a native directory picker (workspaces.pickDirectory())
 *     or manual path input, then the host junction-links every skill under
 *     the chosen directory into ~/.dsh/skills
 *   - per-row unlink / delete (delete only for agent-created, non-linked
 *     rows, mirroring the host guards)
 *
 * Talks to the host half over plain HTTP (/api/cc-skills/*), the same
 * client↔host pattern dsh-tokenledger uses for its panel.
 */

console.info("[dsh-skill-linker] client bundle executing");
window.__ModuleLoader__.load({
  id: "dsh-skill-linker",
  factory: (require) => {
    const React = require("react");
    const jsx = require("react/jsx-runtime");
    const inject = ["slots", "locale", "workspaces"];
    const BASE = "/api/cc-skills";
    /** apply 时捕获的宿主 client ctx，用于写操作后广播 connection/reset。 */
    let hostCtx = null;

    // NOTE: several --dsw-alias-* tokens are NOT defined in every host
    // context (verified via computed styles: --dsw-alias-surface-primary and
    // --dsw-alias-border-secondary resolve to empty), so every var() here
    // carries a concrete fallback. Canvas/CanvasText follow the active theme.
    const css = `
.dsh-ccs-page{display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--dsw-alias-label-primary,CanvasText);flex:1;min-height:0;overflow:hidden}
.dsh-ccs-list{flex:1;min-height:0;overflow-y:auto;max-height:52vh;padding-right:2px}
.dsh-ccs-head{display:flex;align-items:baseline;gap:10px;padding-right:30px}
.dsh-ccs-head h2{margin:0;font-size:15px}
.dsh-ccs-root{color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.5));font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.dsh-ccs-refresh{flex:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.5));cursor:pointer;font-size:12px;padding:2px 6px;border-radius:4px}
.dsh-ccs-refresh:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,CanvasText)}
.dsh-ccs-intro{margin:0;color:var(--dsw-alias-label-secondary,rgba(0,0,0,.72));font-size:12px;line-height:1.5}
.dsh-ccs-card{border:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.14));border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px}
.dsh-ccs-cardtitle{font-weight:600;font-size:12px}
.dsh-ccs-linkrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsh-ccs-pick{border:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.14));background:var(--dsw-alias-surface-secondary,rgba(0,0,0,.03));color:var(--dsw-alias-label-primary,CanvasText);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer}
.dsh-ccs-pick:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsh-ccs-input{flex:1;min-width:160px;height:28px;border:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-surface-secondary,rgba(0,0,0,.03));color:var(--dsw-alias-label-primary,CanvasText);font-size:12px;padding:0 8px}
.dsh-ccs-golink{flex:none;border:0;background:var(--dsw-alias-interactive-bg-selected,#2e6fda);color:var(--dsw-alias-label-onfill-primary,#fff);border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer}
.dsh-ccs-golink:disabled{opacity:.45;cursor:default}
.dsh-ccs-hint{color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.5));font-size:11px}
.dsh-ccs-msg{font-size:12px;border-radius:6px;padding:6px 10px;white-space:pre-wrap;word-break:break-all}
.dsh-ccs-msg.ok{color:var(--dsw-alias-state-success-label,#2e7d32);background:var(--dsw-alias-state-success-bg,rgba(46,125,50,.08))}
.dsh-ccs-msg.err{color:var(--dsw-alias-state-error-label,#e5484d);background:var(--dsw-alias-state-error-bg,rgba(229,72,77,.08))}
.dsh-ccs-err{font-size:12px;color:var(--dsw-alias-state-error-label,#e5484d)}
.dsh-ccs-rows{display:flex;flex-direction:column;gap:8px}
/* 行卡片：对齐 dsh-skill-explorer 的 .skill —— 描边卡片、hover 提升边框 */
.dsh-ccs-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.14));border-radius:8px;background:var(--dsw-alias-surface-primary,Canvas)}
.dsh-ccs-row:hover{border-color:var(--dsw-alias-border-l2,#b8bcc4);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.03))}
.dsh-ccs-row.dim{opacity:.55}
.dsh-ccs-rowmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-ccs-namewrap{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.dsh-ccs-name{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary,CanvasText);font-family:ui-monospace,Consolas,monospace}
.dsh-ccs-badge{flex:none;font-size:10px;padding:1px 6px;border-radius:99px;background:var(--dsw-alias-state-business-secondary,rgba(67,83,163,.1));color:var(--dsw-alias-state-business-primary,#4353a3);border:1px solid var(--dsw-alias-state-business-tertiary,rgba(67,83,163,.22))}
.dsh-ccs-badge.warn{background:var(--dsw-alias-state-neutral-secondary,rgba(95,107,122,.12));color:#5f6b7a;border-color:rgba(95,107,122,.32)}
.dsh-ccs-desc{color:var(--dsw-alias-label-secondary,rgba(0,0,0,.65));font-size:12px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-ccs-acts{flex:none;display:flex;gap:6px;align-items:center}
.dsh-ccs-switch{display:inline-flex;align-items:center;background:none;border:none;padding:2px;cursor:pointer;border-radius:99px}
.dsh-ccs-switch:disabled{opacity:.5;cursor:default}
.dsh-ccs-switchtrack{width:30px;height:16px;border-radius:99px;background:var(--dsw-alias-border-l2,#d1d5db);position:relative;transition:background .18s ease;flex:none}
.dsh-ccs-switchthumb{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-bg-base,#fff);transition:left .18s ease;box-shadow:0 1px 2px rgba(0,0,0,.25)}
.dsh-ccs-switch[aria-checked="true"] .dsh-ccs-switchtrack{background:var(--dsw-alias-state-success-primary,#10b981)}
.dsh-ccs-switch[aria-checked="true"] .dsh-ccs-switchthumb{left:16px}
.dsh-ccs-act.unlink{color:#2e6fda}
.dsh-ccs-act.unlink:hover{color:#1b5ac9;background:rgba(46,111,218,.08)}
.dsh-ccs-act{border:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.5));font-size:12px;padding:4px 6px;border-radius:4px}
.dsh-ccs-act:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,CanvasText)}
.dsh-ccs-act.danger:hover{color:var(--dsw-alias-state-error-label,#e5484d)}
.dsh-ccs-empty{color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.5));padding:10px 6px}
.dsh-ccs-loading{color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.5));padding:10px 6px}
.dsh-ccs-wrap{position:relative;flex:0 0 100%;min-width:0}
.dsh-ccs-trigger{width:100%;display:flex;align-items:center;gap:8px;border:0;background:transparent;color:var(--dsw-alias-label-primary,CanvasText);font-size:12px;padding:6px 8px;border-radius:6px;cursor:pointer}
.dsh-ccs-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,CanvasText)}
.dsh-ccs-overlay{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
.dsh-ccs-modal{position:relative;width:min(760px,92vw);height:min(680px,85vh);display:flex;flex-direction:column;background:var(--dsw-alias-surface-primary,Canvas);color:var(--dsw-alias-label-primary,CanvasText);border:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.14));border-radius:12px;padding:20px 22px;box-shadow:0 16px 48px rgba(0,0,0,.25)}
.dsh-ccs-close{position:absolute;top:10px;right:12px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.5));font-size:14px;cursor:pointer;padding:4px 8px;border-radius:6px}
.dsh-ccs-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,CanvasText)}
.dsh-ccs-search{flex:none;width:100%;height:32px;border:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-surface-secondary,rgba(0,0,0,.03));color:var(--dsw-alias-label-primary,CanvasText);font-size:13px;padding:0 10px}
`;

    async function callApi(action, body) {
      if (action === "list") {
        const response = await fetch(BASE + "/list", { headers: { accept: "application/json" } });
        return response.json();
      }
      const response = await fetch(BASE + "/" + action, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      return response.json();
    }

    function Badge({ text, warn }) {
      return jsx.jsx("span", { className: "dsh-ccs-badge" + (warn ? " warn" : ""), children: text });
    }

    function SkillRow({ row, busy, onRun }) {
      return jsx.jsxs("div", {
        className: "dsh-ccs-row" + (row.disabled ? " dim" : ""),
        children: [
          jsx.jsxs("div", { className: "dsh-ccs-rowmain", title: row.description || row.name, children: [
            jsx.jsxs("div", { className: "dsh-ccs-namewrap", children: [
              jsx.jsx("span", { className: "dsh-ccs-name", children: row.name }),
              row.linked ? jsx.jsx(Badge, { text: "linked" }) : null,
              row.pinned ? jsx.jsx(Badge, { text: "pinned" }) : null,
              row.disabled ? jsx.jsx(Badge, { text: "已停用", warn: true }) : null,
              row.agent_created ? jsx.jsx(Badge, { text: "agent" }) : null,
            ] }),
            jsx.jsx("div", { className: "dsh-ccs-desc", children: row.description }),
          ] }),
          jsx.jsxs("div", { className: "dsh-ccs-acts", children: [
            jsx.jsx("button", {
              className: "dsh-ccs-switch",
              role: "switch",
              "aria-checked": String(!row.disabled),
              "aria-label": row.disabled ? "启用技能" : "停用技能",
              title: row.disabled ? "启用" : "停用",
              disabled: busy,
              onClick: () => onRun(row.disabled ? "enable" : "disable", { name: row.name }),
              children: jsx.jsx("span", { className: "dsh-ccs-switchtrack", children: jsx.jsx("span", { className: "dsh-ccs-switchthumb" }) }),
            }),
            row.linked ? jsx.jsx("button", { className: "dsh-ccs-act unlink", disabled: busy, onClick: () => onRun("unlink", { name: row.name }), children: "取消链接" }) : null,
            row.agent_created && !row.linked ? jsx.jsx("button", { className: "dsh-ccs-act danger", disabled: busy, onClick: () => onRun("delete", { name: row.name }), children: "删除" }) : null,
          ] }),
        ],
      }, row.name);
    }

    function SkillManagerSection({ pickDirectory }) {
      const [rows, setRows] = React.useState([]);
      const [root, setRoot] = React.useState("");
      const [error, setError] = React.useState("");
      const [loading, setLoading] = React.useState(true);
      const [source, setSource] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState(null);
      const [query, setQuery] = React.useState("");

      const load = React.useCallback(async () => {
        setLoading(true);
        setError("");
        try {
          const data = await callApi("list");
          if (!data.ok) throw new Error(data.error || "list failed");
          setRows(Array.isArray(data.skills) ? data.skills : []);
          setRoot(data.root || "");
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setLoading(false);
        }
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const run = async (action, body) => {
        setBusy(true);
        setMsg(null);
        try {
          const data = await callApi(action, body);
          setMsg(data.ok ? { ok: true, text: data.message || "完成" } : { ok: false, text: data.error || "操作失败" });
          if (data.ok) {
            await load();
            // 技能目录变了：发 connection/reset 让聊天框的 '/' 技能选择器
            // 清掉按会话缓存的目录并重拉（与整页刷新同一条事件路径，
            // 各监听方都只做缓存清理/重取，可安全复用）。
            try { hostCtx?.emit?.("connection/reset"); } catch { /* 宿主事件不可用时静默降级 */ }
          }
          return data;
        } catch (e) {
          setMsg({ ok: false, text: String(e?.message || e) });
          return { ok: false };
        } finally {
          setBusy(false);
        }
      };

      const chooseFolder = async () => {
        setMsg(null);
        try {
          const picked = await pickDirectory?.();
          if (picked == null) return;
          setSource(picked);
        } catch (e) {
          setMsg({ ok: false, text: "无法打开目录选择器，请直接在输入框粘贴路径。" + (e?.message ? ` (${e.message})` : "") });
        }
      };

      const link = () => run("link", { sourceDirectory: source.trim() });

      const q = query.trim().toLowerCase();
      const filtered = q
        ? rows.filter((row) => row.name.toLowerCase().includes(q) || String(row.description || "").toLowerCase().includes(q))
        : rows;

      return jsx.jsxs("div", { className: "dsh-ccs-page", children: [
        jsx.jsxs("div", { className: "dsh-ccs-head", children: [
          jsx.jsx("h2", { children: "技能管理" }),
          jsx.jsx("span", { className: "dsh-ccs-root", title: root, children: root }),
          jsx.jsx("button", { className: "dsh-ccs-refresh", onClick: load, children: "刷新" }),
        ] }),
        jsx.jsx("p", { className: "dsh-ccs-intro", children: "启用、停用技能，或把某个文件夹下的所有技能以目录联接（junction）的方式链接到技能根目录。" }),
        jsx.jsxs("div", { className: "dsh-ccs-card", children: [
          jsx.jsx("div", { className: "dsh-ccs-cardtitle", children: "添加软链接" }),
          jsx.jsxs("div", { className: "dsh-ccs-linkrow", children: [
            jsx.jsx("button", { className: "dsh-ccs-pick", disabled: busy, onClick: chooseFolder, children: "选择文件夹…" }),
            jsx.jsx("input", {
              className: "dsh-ccs-input",
              placeholder: "或手动输入技能所在的文件夹路径",
              value: source,
              onChange: (e) => setSource(e.target.value),
            }),
            jsx.jsx("button", { className: "dsh-ccs-golink", disabled: busy || !source.trim(), onClick: link, children: "链接" }),
          ] }),
          jsx.jsx("div", { className: "dsh-ccs-hint", children: "所选文件夹下的每个子目录都会被链接为一个技能；已存在的链接会被替换，普通文件夹会中止以避免误覆盖。" }),
        ] }),
        msg ? jsx.jsx("div", { className: "dsh-ccs-msg " + (msg.ok ? "ok" : "err"), children: msg.text }) : null,
        error ? jsx.jsx("div", { className: "dsh-ccs-err", children: error }) : null,
        jsx.jsx("input", {
          className: "dsh-ccs-search",
          placeholder: "搜索技能…",
          value: query,
          onChange: (e) => setQuery(e.target.value),
        }),
        jsx.jsx("div", {
          className: "dsh-ccs-list",
          children: loading
            ? jsx.jsx("div", { className: "dsh-ccs-loading", children: "加载中…" })
            : rows.length === 0
              ? jsx.jsx("div", { className: "dsh-ccs-empty", children: "还没有技能 — 链接技能目录或直接新建一个。" })
              : filtered.length === 0
                ? jsx.jsx("div", { className: "dsh-ccs-empty", children: "没有匹配的技能。" })
                : jsx.jsx("div", { className: "dsh-ccs-rows", children: filtered.map((row) => jsx.jsx(SkillRow, { row, busy, onRun: run }, row.name)) }),
        }),
      ] });
    }

    /**
     * Sidebar footer shortcut: toggles a full-screen overlay hosting the same
     * SkillManagerSection that the settings dialog mounts. The overlay owns
     * Esc/✕ dismissal and stops click-through on its backdrop.
     */
    function SkillShortcut({ pickDirectory }) {
      const [open, setOpen] = React.useState(false);
      React.useEffect(() => {
        if (!open) return;
        const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [open]);
      return jsx.jsxs("div", { className: "dsh-ccs-wrap", children: [
        jsx.jsxs("button", { className: "dsh-ccs-trigger", onClick: () => setOpen(true), children: [
          jsx.jsx("span", { "aria-hidden": true, children: "⚡" }),
          jsx.jsx("span", { children: "技能管理" }),
        ] }),
        open ? jsx.jsx("div", {
          className: "dsh-ccs-overlay",
          onClick: (e) => { if (e.target === e.currentTarget) setOpen(false); },
          children: jsx.jsxs("div", { className: "dsh-ccs-modal", role: "dialog", "aria-label": "技能管理", children: [
            jsx.jsx("button", { className: "dsh-ccs-close", onClick: () => setOpen(false), children: "✕" }),
            jsx.jsx(SkillManagerSection, { pickDirectory }),
          ] }),
        }) : null,
      ] });
    }

    function apply(ctx) {
      console.info("[dsh-skill-linker] apply called");
      hostCtx = ctx;
      if (!document.querySelector("style[data-dsh-cc-skills]")) {
        const style = document.createElement("style");
        style.dataset.dshCcSkills = "true";
        style.textContent = css;
        document.head.appendChild(style);
      }
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "skills",
            order: 25,
            label: () => "技能管理",
            inject: () => ({ pickDirectory: () => ctx.get("workspaces")?.pickDirectory() }),
          },
          SkillManagerSection
        )
      );
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          {
            name: "sidebar.footer.action",
            id: "dsh-skill-linker",
            locale: "dsh-skill-linker",
            order: 30,
            inject: () => ({ pickDirectory: () => ctx.get("workspaces")?.pickDirectory() }),
          },
          SkillShortcut
        )
      );
    }

    return { apply, inject };
  },
});
