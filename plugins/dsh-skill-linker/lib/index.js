/**
 * dsh-skill-linker host half.
 *
 * Skill management surface for the sidebar panel, modeled after
 * dsh-skill-manage's guard rules, plus this plugin's own signature feature:
 * junction-linking every skill under a source directory into the user
 * skills root (the in-process version of scripts/link-skills.ps1).
 *
 * HTTP surface (the same pattern dsh-tokenledger uses for its panel):
 *   GET  /api/cc-skills/list     user-scope skills with link/status flags
 *   POST /api/cc-skills/link     { sourceDirectory } — junction each skill
 *                                subdirectory into ~/.dsh/skills; an existing
 *                                junction is replaced, a real dir/file aborts
 *   POST /api/cc-skills/unlink   { name } — remove one junction (links only)
 *   POST /api/cc-skills/delete   { name } — delete a skill behind guards:
 *                                `created_by: agent` marker, `pinned: true`,
 *                                no symlinked/junctioned skill dirs, path
 *                                confined to the skills root
 *   POST /api/cc-skills/disable  { name } — set `disable-model-invocation: true`
 *                                plus `user-invocable: false` (hides the skill
 *                                from both the model catalog and the chat picker)
 *   POST /api/cc-skills/enable   { name } — remove both flags
 *
 * Exact registrations sit outside the RPC trust boundary, so every handler
 * screens the caller on the loopback peer address before touching disk.
 */

import { execFile } from 'node:child_process'
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
  }
  try {
    await powershellWrite(target, content)
  } catch (e) {
    throw new Error(`write denied under the skills root (watcher lock); retry in a moment — ${String(e?.message || e).slice(0, 160)}`)
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_PATH = '/api/cc-skills'
const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024
const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/
const AGENT_MARKER = 'created_by: agent'
const DISABLE_KEY = 'disable-model-invocation'
/** 聊天框选择器的可见性开关：false 时聊天框不再列出该技能。 */
const USER_INVOCABLE_KEY = 'user-invocable'
const PIN_KEY = 'pinned'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skillsRoot() {
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh')
  return path.join(home, 'skills')
}

function fail(error) {
  return { ok: false, error }
}

function ok(message, extra = {}) {
  return { ok: true, message, ...extra }
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
// List
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
// Link / unlink (the plugin's own feature)
// ---------------------------------------------------------------------------

/**
 * Create a junction. Defender and the skills watcher can transiently lock
 * the skills root while it hot-loads the previously linked skill, so each
 * attempt first clears a possible half-created reparse point, then tries
 * symlink 'junction' and `mklink /J` (no privilege needed either).
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
// Delete guards (from dsh-skill-manage)
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
// Frontmatter flags (disable / enable, from dsh-skill-manage)
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
// HTTP surface
// ---------------------------------------------------------------------------

/** Loopback screen: the peer socket address cannot be forged, the Host header can. */
function isLoopback(address) {
  if (typeof address !== 'string' || address === '') return false
  const bare = address.startsWith('::ffff:') ? address.slice(7) : address
  if (bare === '::1' || bare === 'localhost') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
}

function screenRequest(req, method) {
  if (req?.method !== method) return { status: 405, body: fail('method-not-allowed') }
  const peerOk = isLoopback(req.socket?.remoteAddress)
  const hostOk = isLoopback((req.headers?.host || '').replace(/:\d+$/, ''))
  if (peerOk && hostOk) return undefined
  return { status: 403, body: fail('forbidden') }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

const ACTIONS = {
  link: { method: 'POST', run: (args) => linkAllSkills(String(args.sourceDirectory || '')) },
  unlink: { method: 'POST', run: (args) => unlinkSkill(String(args.name || '')) },
  delete: { method: 'POST', run: (args) => deleteSkill(String(args.name || '')) },
  disable: { method: 'POST', run: (args) => setSkillEnabled(String(args.name || ''), false) },
  enable: { method: 'POST', run: (args) => setSkillEnabled(String(args.name || ''), true) },
}

export function apply(ctx) {
  // WAITED FOR, not sampled: `ctx.get("webServer")` at mount time answers
  // undefined when the server mounts later, and the routes would silently
  // 404 forever (the mistake tokenledger documents in its own http.js).
  ctx.inject(["webServer"], (scoped) => {
    const webServer = scoped.webServer
    const route = (name) => {
      const pathSpec = name === 'list' ? `${BASE_PATH}/list` : `${BASE_PATH}/${name}`
      const method = name === 'list' ? 'GET' : 'POST'
      ctx.effect(
        () =>
          webServer.register({
            kind: 'exact',
            path: pathSpec,
            handler: async (req, res) => {
              const send = (status, body) => {
                res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
                res.end(JSON.stringify(body))
              }
              const refused = screenRequest(req, method)
              if (refused !== undefined) return send(refused.status, refused.body)
              try {
                send(200, name === 'list' ? await listSkills() : await ACTIONS[name].run(await readBody(req)))
              } catch (e) {
                send(500, fail(e?.message || String(e)))
              }
            },
          }),
        `dsh-skill-linker: ${name} route`
      )
    }

    route('list')
    for (const name of Object.keys(ACTIONS)) route(name)
    console.log('[dsh-skill-linker] host ready: /api/cc-skills/* routes registered')
  })
}
