/**
 * dsh-skill-mcp host half (v0.2.0).
 *
 * 技能与MCP引擎，两部分共用同一条 connection RPC 通道（官方推荐的
 * Client→Host 私有通道接缝，authority: 'loopback'，取代 v0.1 的
 * /api/cc-skills/* HTTP 路由）：
 *
 * 技能管理（v0.1 逻辑原样保留）：
 *   skills/list      用户级技能 + 链接/置顶/停用/agent 标记
 *   skills/link      { sourceDirectory } — 目录联接进 ~/.dsh/skills
 *   skills/unlink    { name } — 只移除联接点
 *   skills/delete    { name } — agent 创建 + 非置顶 + 路径围栏内才可删
 *   skills/disable   { name } — frontmatter 双标记停用
 *   skills/enable    { name } — 移除双标记
 *
 * 按项目 MCP 自动加载（v0.2 新增）：
 *   mcp/sync         { cwd, force? } — client 推送当前会话工作区；
 *                    host 读取用户级 ~/.dsh/mcp.json + 项目级
 *                    <cwd>/.dsh/mcp.json（回退 <cwd>/.mcp.json Claude 格式），
 *                    通过 ctx.loader 热加载/热卸载 @deepseek-ai/dsh-mcp-client
 *                    条目（id 前缀 pmcp-，绝不触碰其他来源的条目）
 *   mcp/status       条目 + fiber 阶段 + 工具计数 + 配置文件存在性
 *   mcp/setEnabled   { name, enabled } — 热启停并持久化到
 *                    ~/.dsh/project-mcp-state.json
 *   mcp/reload       强制重读配置并 reconcile
 *
 * codegraph 场景：command "codegraph"、args ["serve","--mcp"]、cwd=项目根
 * （靠项目根下的 .codegraph/ 定位索引）。
 */

import { execFile } from 'node:child_process'
import { watch as fsWatch } from 'node:fs'
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import path from 'node:path'

const execFileP = promisify(execFile)

/**
 * Last-resort write path. Inside the dsh host, opens under the skills root
 * can be denied with EPERM for stretches of time (the skills watcher seems
 * to hold the tree during/after hot-loads). A powershell child process from
 * the same host usually still writes fine, so callers fall back to it when
 * the in-process atomic write is denied. Content travels base64/UTF-16 to
 * survive quoting. The script reads the file back and diffs — a silent
 * denial must not masquerade as success (the file already exists, so a
 * mere existence check is useless).
 */
async function powershellWrite(target, content) {
  const b64 = Buffer.from(content, 'utf16le').toString('base64')
  const script =
    `$p='${target}'; ` +
    `$d=[System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${b64}')); ` +
    `[System.IO.File]::WriteAllText($p, $d, (New-Object System.Text.UTF8Encoding $false)); ` +
    `$back=[System.IO.File]::ReadAllText($p); ` +
    `if ($back -ceq $d) { exit 0 } else { Write-Error 'write verification failed'; exit 2 }`
  await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
}

/**
 * atomicWrite, with the powershell escape hatch when the in-process write is
 * denied (EPERM/EACCES/EBUSY after all retries). Other errors rethrow.
 */
async function writeTextResilient(target, content) {
  try {
    await atomicWrite(target, content)
    return
  } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY') throw e
    // The powershell escape hatch only exists on Windows. On POSIX the
    // watcher lock is not observed in practice, so surface the denial.
    if (process.platform !== 'win32') {
      throw new Error(`write denied under the skills root (watcher lock); retry in a moment — ${e2str(e)}`)
    }
    try {
      await powershellWrite(target, content)
    } catch (e2) {
      throw new Error(`write denied under the skills root (watcher lock); retry in a moment — ${e2str(e2)}`)
    }
  }
}

/** Normalize an error to a short single-line string for error messages. */
function e2str(e) {
  return String(e?.message || e).slice(0, 160)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024
const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/
const AGENT_MARKER = 'created_by: agent'
const DISABLE_KEY = 'disable-model-invocation'
/** 聊天框选择器的可见性开关：false 时聊天框不再列出该技能。 */
const USER_INVOCABLE_KEY = 'user-invocable'
const PIN_KEY = 'pinned'

// RPC 通道与按项目 MCP 的命名空间。
const RPC_CHANNEL = '/skill-mcp'
const MCP_ENTRY_PREFIX = 'pmcp-'
const MCP_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh')
}

function skillsRoot() {
  return path.join(dshHome(), 'skills')
}

function fail(error) {
  return { ok: false, error }
}

function ok(message, extra = {}) {
  return { ok: true, message, ...extra }
}

/** connection RPC 的信封（镜像 dsh-skill-mcp-center 的 RpcResult 形状）。 */
function rpcOk(value) {
  return { ok: true, value }
}

function rpcFail(message) {
  return { ok: false, error: { code: 'internal', message: String(message).slice(0, 300), details: {} } }
}

/**
 * Minimal CRLF-safe YAML frontmatter reader (plain `key: value` lines plus
 * `|` / `>` block scalars) — the subset that appears in real SKILL.md files.
 */
function parseFrontmatter(content) {
  const text = String(content).replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return { error: 'SKILL.md must start with YAML frontmatter (---).' }
  const end = text.slice(3).search(/\n---\s*(\n|$)/)
  if (end < 0) return { error: "frontmatter is not closed; ensure a closing '---' line." }
  const raw = text.slice(3, end + 3)
  const body = text.slice(end + 3).replace(/^---\s*\n?/, '')
  const data = {}
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/)
    if (!m) continue
    const [, key, value] = m
    if (value === '|' || value === '|-' || value === '|+' || value === '>' || value === '>-' || value === '>+') {
      const block = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const next = lines[j]
        if (next.trim() === '') { block.push(''); continue }
        if (/^[ \t]/.test(next)) { block.push(next.replace(/\r$/, '')); continue }
        break
      }
      i = j - 1
      const stripped = block.map((l) => l.replace(/^[ \t]{1,8}/, ''))
      let joined
      if (value.startsWith('|')) joined = stripped.join('\n')
      else joined = stripped.join(' ')
      joined = joined.replace(/\n{3,}/g, '\n\n')
      joined = value.endsWith('-') ? joined.replace(/\s+$/, '') : joined.replace(/\s+$/, '\n')
      data[key] = joined.trim() === '' ? '' : joined
      continue
    }
    data[key] = value.replace(/^['"]|['"]$/g, '')
  }
  return { data, body, raw }
}

function validateName(name) {
  if (!name) return 'Skill name is required.'
  if (name.length > MAX_NAME_LENGTH) return `Skill name exceeds ${MAX_NAME_LENGTH} characters.`
  if (!VALID_NAME_RE.test(name)) return `Invalid skill name '${name}'. Use lowercase letters, numbers, hyphens, dots, underscores; must start with a letter or digit.`
  return null
}

/** Junction/symlink probe: `lstat` reports junctions as directories, so readlink is the reliable test. */
async function linkTargetOf(p) {
  try { return await readlink(p) } catch { return null }
}

/**
 * Resolve a skill by name in the two layouts the skill-filesystem watcher
 * loads: <root>/<name>/SKILL.md and <root>/<name>.md.
 */
async function findSkill(name, root) {
  const nameErr = validateName(name)
  if (nameErr) return { error: nameErr }
  const dir = path.join(root, name)
  const skillMd = path.join(dir, 'SKILL.md')
  try {
    await readFile(skillMd, 'utf8')
    return { dir, skillMd, root, layout: 'dir' }
  } catch { /* fall through to the single-file layout */ }
  const fileMd = path.join(root, name + '.md')
  try {
    await readFile(fileMd, 'utf8')
    return { dir: null, skillMd: fileMd, root, layout: 'file' }
  } catch {
    return { error: `Skill '${name}' not found under ${root} (looked for ${name}/SKILL.md and ${name}.md).` }
  }
}

/** Atomic write: temp file + rename, so a watcher never sees a half-written file. */
async function atomicWrite(target, content) {
  // The skills watcher / Defender can transiently deny opens (EPERM/EBUSY)
  // under the skills root right after a hot-load; back off and retry.
  let lastError
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 0 : 300))
    try {
      await mkdir(path.dirname(target), { recursive: true })
    } catch (e) {
      lastError = e
      if (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY') throw e
      continue
    }
    const tmp = target + '.tmp-' + process.pid + '-' + Date.now()
    try {
      await writeFile(tmp, content, 'utf8')
      await rename(tmp, target)
      return
    } catch (e) {
      lastError = e
      if (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY') throw e
    }
  }
  throw lastError
}

// ---------------------------------------------------------------------------
// Skills: list
// ---------------------------------------------------------------------------

async function listSkills() {
  const root = skillsRoot()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return ok(`skills root ${root} does not exist yet`, { skills: [], root })
  }
  const rows = []
  const seen = new Set()
  const pushRow = async (name, contentPath, layout, linked, target) => {
    if (seen.has(name)) return
    seen.add(name)
    let content = ''
    try { content = await readFile(contentPath, 'utf8') } catch { content = '' }
    const data = parseFrontmatter(content).data || {}
    rows.push({
      name,
      layout,
      linked,
      target: target || null,
      agent_created: content.includes(AGENT_MARKER),
      pinned: String(data[PIN_KEY]).toLowerCase() === 'true',
      disabled: String(data[DISABLE_KEY]).toLowerCase() === 'true'
        || String(data[USER_INVOCABLE_KEY]).toLowerCase() === 'false',
      description: String(data.description || '').slice(0, 100),
    })
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = path.join(root, e.name)
    const linked = await linkTargetOf(full) !== null
    const target = linked ? await linkTargetOf(full) : null
    // Junctions/symlinks report neither isDirectory() nor isFile() on Node 24,
    // so anything that is not a plain .md file is treated as a directory skill.
    if (e.isFile()) {
      if (e.name.endsWith('.md')) await pushRow(e.name.slice(0, -3), full, 'file', linked, target)
    } else {
      await pushRow(e.name, path.join(full, 'SKILL.md'), 'dir', linked, target)
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return ok(`${rows.length} skill(s)`, { skills: rows, root })
}

// ---------------------------------------------------------------------------
// Skills: link / unlink (the plugin's own feature)
// ---------------------------------------------------------------------------

/**
 * Create a junction (Windows) or plain symlink (macOS/Linux — Node ignores
 * the 'junction' type there). Defender and the skills watcher can transiently
 * lock the skills root while it hot-loads the previously linked skill, so
 * each attempt first clears a possible half-created reparse point, then
 * tries symlink 'junction' and — Windows only — `mklink /J` (no privilege
 * needed either).
 */
async function createJunction(link, target) {
  let lastError
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 0 : 250))
    try { await rm(link, { force: true }) } catch { /* nothing to clear */ }
    try {
      await symlink(target, link, 'junction')
      return
    } catch (e) {
      lastError = e
      if (e.code === 'EEXIST') throw e
    }
    if (process.platform !== 'win32') continue
    try {
      await execFileP('cmd.exe', ['/d', '/c', 'mklink', '/J', link, target])
      return
    } catch (e) {
      lastError = e
    }
  }
  throw lastError
}

/**
 * Junction every subdirectory of `sourceDirectory` into the skills root.
 * Mirrors scripts/link-skills.ps1: an existing reparse point at the target
 * is replaced; an ordinary directory or file aborts the whole run so the
 * user can decide instead of us silently skipping.
 */
async function linkAllSkills(sourceDirectory) {
  if (!sourceDirectory || !path.isAbsolute(sourceDirectory)) {
    return fail('sourceDirectory must be an absolute path.')
  }
  let stat
  try { stat = await lstat(sourceDirectory) } catch { return fail(`Source directory not found: ${sourceDirectory}`) }
  if (!stat.isDirectory()) return fail(`Not a directory: ${sourceDirectory}`)
  let sources
  try { sources = await readdir(sourceDirectory, { withFileTypes: true }) } catch (e) {
    return fail(`Cannot read ${sourceDirectory}: ${e.message}`)
  }
  const root = skillsRoot()
  await mkdir(root, { recursive: true })
  const linked = []
  for (const entry of sources) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const link = path.join(root, entry.name)
    const existingTarget = await linkTargetOf(link)
    if (existingTarget !== null) {
      // Re-link: drop the old junction (never its target) before recreating.
      await rm(link, { force: true })
    } else {
      let exists
      try { exists = await lstat(link) } catch { exists = null }
      if (exists) return fail(`Target exists and is not a link: ${link} — remove it manually or pick another name. Everything before this entry is already linked.`)
    }
    const target = path.join(await realpath(sourceDirectory), entry.name)
    try {
      await createJunction(link, target)
    } catch (e) {
      return fail(`Failed to link '${entry.name}': ${e.message}. Everything before this entry is already linked.`)
    }
    linked.push(entry.name)
  }
  return ok(linked.length ? `Linked ${linked.length} skill(s) from ${sourceDirectory} into ${root}.` : `No skill directories found under ${sourceDirectory}.`, { linked })
}

/** Remove one junction. Refuses anything that is not a reparse point. */
async function unlinkSkill(name) {
  const nameErr = validateName(name)
  if (nameErr) return fail(nameErr)
  const link = path.join(skillsRoot(), name)
  if ((await linkTargetOf(link)) === null) {
    return fail(`'${name}' under the skills root is not a junction; refusing to remove it with unlink. Use delete for real skills.`)
  }
  await rm(link, { force: true })
  return ok(`Unlinked '${name}'. The source directory is untouched.`)
}

// ---------------------------------------------------------------------------
// Skills: delete guards (from dsh-skill-manage)
// ---------------------------------------------------------------------------

/**
 * Last-line defense before a recursive delete: refuses the skills root
 * itself, paths resolving outside the root, and junctioned/symlinked dirs
 * (a junction lstat's as a directory, so readlink is checked explicitly).
 */
async function validateDeleteTarget(dir, root) {
  let st
  try { st = await lstat(dir) } catch { return `Skill directory not found: ${dir}` }
  if (st.isSymbolicLink()) return `Refusing to delete '${dir}': it is a symlink. Remove the link with unlink instead.`
  if ((await linkTargetOf(dir)) !== null) return `Refusing to delete '${dir}': it is a junction. Remove the link with unlink instead.`
  const resolvedRoot = await realpath(root).catch(() => root)
  const resolved = await realpath(dir).catch(() => dir)
  if (resolved === resolvedRoot) return 'Refusing to delete: target resolves to the skills root itself.'
  const rel = path.relative(resolvedRoot, resolved)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return `Refusing to delete '${dir}': path does not resolve inside the skills root.`
  return null
}

/** Ownership guards: only agent-created skills are deletable, pinned skills are refused. */
async function validateDeleteOwnership(name, skillMd) {
  let content
  try { content = await readFile(skillMd, 'utf8') } catch { return null }
  const data = parseFrontmatter(content).data || {}
  if (String(data[PIN_KEY]).toLowerCase() === 'true') {
    return `Skill '${name}' is pinned (\`pinned: true\`) and cannot be deleted. Unpin it first.`
  }
  if (!content.includes(AGENT_MARKER)) {
    return `Refusing to delete '${name}': not agent-created (no \`${AGENT_MARKER}\` marker). Marketplace and user-authored skills are off-limits.`
  }
  return null
}

async function deleteSkill(name) {
  const found = await findSkill(name, skillsRoot())
  if (found.error) return fail(found.error)
  const root = found.root
  if (found.layout === 'file') {
    const owner = await validateDeleteOwnership(name, found.skillMd)
    if (owner) return fail(owner)
    await rm(found.skillMd, { force: true })
    return ok(`Skill '${name}' deleted (${name}.md).`)
  }
  const unsafe = await validateDeleteTarget(found.dir, root)
  if (unsafe) return fail(unsafe)
  const owner = await validateDeleteOwnership(name, found.skillMd)
  if (owner) return fail(owner)
  await rm(found.dir, { recursive: true, force: true })
  return ok(`Skill '${name}' deleted.`)
}

// ---------------------------------------------------------------------------
// Skills: frontmatter flags (disable / enable, from dsh-skill-manage)
// ---------------------------------------------------------------------------

/**
 * 停用/启用（对齐 dsh-skill-explorer 的 set-enabled 语义，但更彻底）：
 *   停用 = `disable-model-invocation: true`（模型目录隐藏）
 *        + `user-invocable: false`（聊天框选择器也不列出）
 *   启用 = 两个标记一起移除。
 * 只写 disable-model-invocation 时，聊天框按 user-invocable（默认 true）
 * 过滤，技能依然可选 —— 这正是"面板显示已停用但聊天框还能选到"的原因。
 */
async function setSkillEnabled(name, enabled) {
  const found = await findSkill(name, skillsRoot())
  if (found.error) return fail(found.error)
  if (found.layout === 'file') return fail(`Skill '${name}' is a single-file skill; edit ${name}.md manually.`)
  // Linked skills: write through the junction's source path. Same file, but
  // the source usually sits outside the skills root — exactly where the
  // watcher's write denials strike.
  let writePath = found.skillMd
  try {
    const real = await realpath(found.dir)
    if (path.resolve(real) !== path.resolve(found.dir)) writePath = path.join(real, 'SKILL.md')
  } catch { /* keep the original path */ }
  let content
  try { content = await readFile(writePath, 'utf8') } catch { return fail(`Cannot read ${writePath}.`) }
  const parsed = parseFrontmatter(content)
  if (parsed.error) return fail(`Refusing to touch '${name}': ${parsed.error}`)
  if (parsed.data.description && parsed.data.description.length > MAX_DESCRIPTION_LENGTH) {
    return fail(`Refusing to touch '${name}': description exceeds ${MAX_DESCRIPTION_LENGTH} chars.`)
  }
  const lines = content.split('\n')
  if (lines.indexOf('---', 1) < 0) return fail(`Refusing to touch '${name}': cannot locate end of frontmatter.`)
  /** 在当前 frontmatter 里删除 key 行；返回是否删除过（下标随删随扫，避免漂移）。 */
  const cutKey = (key) => {
    const end = lines.indexOf('---', 1)
    for (let i = 1; i < end; i++) {
      if (lines[i].startsWith(key + ':')) { lines.splice(i, 1); return true }
    }
    return false
  }
  if (enabled) {
    const changed = [DISABLE_KEY, USER_INVOCABLE_KEY].map(cutKey)
    if (!changed.some(Boolean)) return ok(`Skill '${name}' is already enabled.`)
  } else {
    const disabled = String(parsed.data[DISABLE_KEY]).toLowerCase() === 'true'
    const hidden = String(parsed.data[USER_INVOCABLE_KEY]).toLowerCase() === 'false'
    if (disabled && hidden) return ok(`Skill '${name}' is already disabled.`)
    cutKey(DISABLE_KEY)
    cutKey(USER_INVOCABLE_KEY)
    lines.splice(lines.indexOf('---', 1), 0, `${USER_INVOCABLE_KEY}: false`, `${DISABLE_KEY}: true`)
  }
  await writeTextResilient(writePath, lines.join('\n'))
  return ok(enabled
    ? `Skill '${name}' enabled.`
    : `Skill '${name}' disabled (hidden from the model catalog and the chat picker).`)
}

// ---------------------------------------------------------------------------
// Project MCP: config reading & normalization
// ---------------------------------------------------------------------------

/** mcp-client 的 serverName 约束：[A-Za-z0-9_-]{1,32}，全局唯一。 */
function sanitizeServerName(raw) {
  const name = String(raw ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
  return /^[A-Za-z0-9_-]{1,32}$/.test(name) ? name : ''
}

function plainStringMap(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) continue
    out[k] = {}
    for (const [k2, v2] of Object.entries(v)) {
      if (typeof v2 === 'string' || typeof v2 === 'number' || typeof v2 === 'boolean') out[k][k2] = v2
    }
  }
  return out
}

function numOrDefault(raw, dflt) {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : dflt
}

/**
 * 把一条原始配置（dsh 原生或 Claude 格式）归一化成完整的 mcp-client config。
 * stdio 的 cwd 相对路径按 projectRoot resolve，缺省即项目根 —— codegraph
 * 正是靠 cwd 下的 .codegraph/ 定位索引。
 */
function normalizeMcpEntry(rawName, raw, projectRoot) {
  const serverName = sanitizeServerName(rawName)
  if (serverName === '') return null
  const type = String(raw.type ?? '').toLowerCase()
  const url = typeof raw.url === 'string' && raw.url !== '' ? raw.url : null
  if (type === 'http' || type === 'sse' || type === 'streamable-http' || (!raw.command && url)) {
    return {
      transport: 'streamable-http',
      serverName,
      url,
      headers: plainStringMap(raw.headers)[Object.keys(plainStringMap(raw.headers))[0] ?? ''] ?? {},
      toolCallTimeoutMs: numOrDefault(raw.toolCallTimeoutMs, 60_000),
      failOnStartupError: false,
    }
  }
  const command = typeof raw.command === 'string' ? raw.command : ''
  if (command === '') return null
  const args = Array.isArray(raw.args) ? raw.args.map(String) : []
  const envEntries = plainStringMap({ env: raw.env }).env ?? {}
  const cwd = typeof raw.cwd === 'string' && raw.cwd !== ''
    ? path.resolve(projectRoot, raw.cwd)
    : projectRoot
  const config = {
    transport: 'stdio',
    serverName,
    command,
    args,
    env: envEntries,
    cwd,
    toolCallTimeoutMs: numOrDefault(raw.toolCallTimeoutMs, 60_000),
    failOnStartupError: false,
  }
  if (raw.reconnect !== null && typeof raw.reconnect === 'object' && !Array.isArray(raw.reconnect)) {
    config.reconnect = raw.reconnect
  }
  return config
}

/**
 * 读一个配置文件并展开为 Map<serverName, config>。
 * 识别两种格式：Claude（{ mcpServers: {…} }）与 dsh 原生（{ servers: {…} }
 * 或顶层直接是 name→config 映射）。解析失败返回 { error }。
 */
async function readMcpConfigFile(filePath, projectRoot) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { servers: {} }
    return { error: `${filePath}: ${e2str(e)}` }
  }
  let doc
  try {
    doc = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (e) {
    return { error: `${filePath}: invalid JSON — ${e2str(e)}` }
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { error: `${filePath}: top level must be a JSON object.` }
  }
  const rawMap = doc.mcpServers ?? doc.servers ?? doc
  if (rawMap === null || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
    return { error: `${filePath}: no mcpServers/servers map found.` }
  }
  const servers = {}
  for (const [name, raw] of Object.entries(rawMap)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const config = normalizeMcpEntry(name, raw, projectRoot)
    if (config !== null) servers[config.serverName] = config
  }
  return { servers }
}

async function pathExists(p) {
  try { await lstat(p); return true } catch { return false }
}

/** 启停状态文件：{ disabled: [name, …] }。损坏时按空处理。 */
function mcpStatePath() {
  return path.join(dshHome(), 'project-mcp-state.json')
}

async function loadMcpDisabled() {
  try {
    const doc = JSON.parse(await readFile(mcpStatePath(), 'utf8'))
    if (Array.isArray(doc?.disabled)) return doc.disabled.map(String)
  } catch { /* absent or corrupt → empty */ }
  return []
}

async function saveMcpDisabled(disabled) {
  await mkdir(dshHome(), { recursive: true })
  await atomicWrite(mcpStatePath(), JSON.stringify({ disabled }, null, 2) + '\n')
}

// ---------------------------------------------------------------------------
// Project MCP: reconcile engine (ctx-bound, defined in apply)
// ---------------------------------------------------------------------------

export const name = 'dsh-skill-mcp'
export const inject = ['connection', 'loader', 'tools']

export function apply(ctx) {
  // ---- MCP engine state ----
  let lastCwd = null
  let desired = new Map() // serverName -> { config, source, disabled }
  let fileStates = { user: null, projectDsh: null, projectClaude: null }
  const watchers = new Map() // watched dir -> { watcher, timer, key }

  const userMcpPath = () => path.join(dshHome(), 'mcp.json')
  const projectDshPath = (cwd) => path.join(cwd, '.dsh', 'mcp.json')
  const projectClaudePath = (cwd) => path.join(cwd, '.mcp.json')

  /** 读三层配置并合并：用户级 → 项目 .mcp.json → 项目 .dsh/mcp.json（后者覆盖同名）。 */
  async function readDesired(cwd) {
    const disabledList = new Set(await loadMcpDisabled())
    const merged = new Map()
    const layers = [
      ['user', userMcpPath()],
      ['project-mcp-json', projectClaudePath(cwd)],
      ['project-dsh-json', projectDshPath(cwd)],
    ]
    const files = {}
    for (const [source, filePath] of layers) {
      files[source] = { path: filePath, exists: await pathExists(filePath) }
      const parsed = await readMcpConfigFile(filePath, cwd)
      if (parsed.error) return { error: parsed.error, files }
      for (const [serverName, config] of Object.entries(parsed.servers)) {
        merged.set(serverName, { config, source, disabled: disabledList.has(serverName) })
      }
    }
    return { merged, files }
  }

  /** 与 ctx.loader 对账：只增删改 id 前缀 pmcp- 的条目。 */
  async function reconcile() {
    const entries = ctx.loader.entries().filter((e) => String(e.id).startsWith(MCP_ENTRY_PREFIX))
    const byId = new Map(entries.map((e) => [e.id, e]))
    for (const [serverName, item] of desired) {
      const id = MCP_ENTRY_PREFIX + serverName
      const existing = byId.get(id)
      if (existing === undefined) {
        await ctx.loader.create({ id, name: MCP_CLIENT_NAME, config: item.config })
        if (item.disabled) await ctx.loader.update(id, { disabled: true })
        continue
      }
      const sameConfig = JSON.stringify(existing.options?.config ?? null) === JSON.stringify(item.config)
      if (!sameConfig) await ctx.loader.update(id, { config: item.config })
      const wantDisabled = item.disabled === true
      if (Boolean(existing.disabled) !== wantDisabled) {
        await ctx.loader.update(id, { disabled: wantDisabled ? true : null })
      }
    }
    for (const [id] of byId) {
      if (!desired.has(id.slice(MCP_ENTRY_PREFIX.length))) await ctx.loader.remove(id)
    }
  }

  /** 关掉不再属于当前配置集的监听；为存在的配置文件所在目录开新监听。 */
  function rewatchFiles() {
    for (const [dir, entry] of watchers) {
      if (fileStatesBelong(dir)) continue
      entry.close()
      watchers.delete(dir)
    }
    for (const source of ['user', 'project-mcp-json', 'project-dsh-json']) {
      const info = fileStates[source]
      if (!info?.exists) continue
      const dir = path.dirname(info.path)
      if (watchers.has(dir)) continue
      let timer = null
      let watcher = null
      try {
        watcher = fsWatch(dir, (event, filename) => {
          if (filename !== null && path.basename(info.path) !== filename) return
          if (timer !== null) clearTimeout(timer)
          timer = setTimeout(() => {
            timer = null
            void sync(lastCwd, true).catch((e) => console.warn('[dsh-skill-mcp] mcp file-watch sync failed:', e2str(e)))
          }, 500)
        })
      } catch { /* dir may vanish; sync() re-establishes */ }
      watchers.set(dir, {
        close: () => {
          try { watcher?.close() } catch { /* already closed */ }
          if (timer !== null) { clearTimeout(timer); timer = null }
        },
      })
    }
  }

  function fileStatesBelong(dir) {
    for (const source of ['user', 'project-mcp-json', 'project-dsh-json']) {
      const info = fileStates[source]
      if (info?.exists && path.dirname(info.path) === dir) return true
    }
    return false
  }

  /** sync 主体：cwd 变化或 force 时重读配置并 reconcile。 */
  async function sync(cwd, force = false) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw new Error('mcp/sync: cwd must be an absolute path')
    }
    let st
    try { st = await lstat(cwd) } catch { throw new Error(`mcp/sync: cwd not found: ${cwd}`) }
    if (!st.isDirectory()) throw new Error(`mcp/sync: not a directory: ${cwd}`)
    if (!force && cwd === lastCwd) return { changed: false, cwd: lastCwd, names: [...desired.keys()] }
    const parsed = await readDesired(cwd)
    if (parsed.error) throw new Error(parsed.error)
    lastCwd = cwd
    desired = parsed.merged
    fileStates = parsed.files
    await reconcile()
    rewatchFiles()
    return { changed: true, cwd, names: [...desired.keys()], sources: Object.fromEntries([...desired].map(([n, it]) => [n, it.source])) }
  }

  /** 运行状态：fiber 阶段 + 工具计数（seam 优先，ctx.tools 派生回退）。 */
  async function mcpStatus() {
    const servers = []
    const entries = ctx.loader.entries().filter((e) => String(e.id).startsWith(MCP_ENTRY_PREFIX))
    const byId = new Map(entries.map((e) => [e.id, e]))
    const seam = ctx.get?.('mcpStatus')
    const toolNames = (seam === undefined && typeof ctx.tools?.schemas === 'function')
      ? ctx.tools.schemas().map((s) => s.name)
      : []
    for (const [serverName, item] of desired) {
      const entry = byId.get(MCP_ENTRY_PREFIX + serverName)
      const fiberState = entry?.fiber?.state
      const fiberPhase = fiberState === undefined || fiberState === null ? null
        : ({ 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: null, 5: 'unloading' })[fiberState] ?? null
      let toolCount = 0
      let connected = false
      if (seam !== undefined && typeof seam?.list === 'function') {
        const st = seam.list().find((s) => s.serverName === serverName)
        toolCount = st?.toolCount ?? 0
        connected = st?.phase === 'connected'
      } else {
        const prefix = `mcp__${serverName}__`
        toolCount = toolNames.filter((n) => n.startsWith(prefix)).length
        connected = !item.disabled && fiberPhase === 'active' && toolCount > 0
      }
      servers.push({
        name: serverName,
        source: item.source,
        disabled: item.disabled,
        transport: item.config.transport,
        command: item.config.command ?? null,
        args: item.config.args ?? null,
        cwd: item.config.cwd ?? null,
        url: item.config.url ?? null,
        fiberPhase,
        toolCount,
        connected,
      })
    }
    servers.sort((a, b) => a.name.localeCompare(b.name))
    const files = {}
    for (const [source, info] of Object.entries(fileStates)) {
      files[source] = { path: info?.path ?? null, exists: info?.exists === true }
    }
    return { cwd: lastCwd, servers, files }
  }

  /** 热启停并持久化（名字只认当前 desired 集合里的 server）。 */
  async function setMcpEnabled(serverName, enabled) {
    const item = desired.get(String(serverName ?? ''))
    if (item === undefined) return fail(`Unknown project MCP server '${serverName}'.`)
    item.disabled = !enabled
    const disabledList = [...desired.entries()].filter(([, it]) => it.disabled).map(([n]) => n)
    await saveMcpDisabled(disabledList)
    await reconcile()
    return ok(enabled ? `MCP server '${serverName}' enabled.` : `MCP server '${serverName}' disabled.`)
  }

  // ---- connection RPC surface（官方推荐的 Client→Host 私有通道） ----

  const endpoints = {
    'skills/list': { run: async () => listSkills() },
    'skills/link': { run: async (p) => linkAllSkills(String(p.sourceDirectory || '')) },
    'skills/unlink': { run: async (p) => unlinkSkill(String(p.name || '')) },
    'skills/delete': { run: async (p) => deleteSkill(String(p.name || '')) },
    'skills/disable': { run: async (p) => setSkillEnabled(String(p.name || ''), false) },
    'skills/enable': { run: async (p) => setSkillEnabled(String(p.name || ''), true) },
    'mcp/sync': { run: async (p) => sync(p.cwd, p.force === true) },
    'mcp/status': { run: async () => mcpStatus() },
    'mcp/setEnabled': { run: async (p) => setMcpEnabled(p.name, p.enabled === true) },
    'mcp/reload': {
      run: async () => {
        if (lastCwd === null) return ok('No project synced yet — nothing to reload.')
        return sync(lastCwd, true)
      },
    },
  }

  ctx.connection.rpc.handle(RPC_CHANNEL, async (endpoint, payload) => {
    try {
      const action = endpoints[endpoint]
      if (action === undefined) return rpcFail(`unknown endpoint "${endpoint}"`)
      return rpcOk(await action.run(payload ?? {}))
    } catch (e) {
      return rpcFail(e?.message || String(e))
    }
  }, { authority: 'loopback' })

  // 文件监听随插件卸载关闭。
  ctx.effect(() => () => {
    for (const [, entry] of watchers) entry.close()
    watchers.clear()
  })

  console.log(`[dsh-skill-mcp] host ready: connection RPC channel '${RPC_CHANNEL}' (skills + project MCP)`)
}
