/**
 * dsh-model-headers host half (v0.1.2).
 *
 * 按模型名给 LLM 请求注入自定义请求头：
 *   - 规则存 ~/.dsh/model-headers.json：{ rules: [{ id, enabled, model, headers }] }
 *   - model 为通配符（仅 '*'，大小写不敏感），匹配请求 body 里的 model 字段
 *   - 值支持固定字符串与 ${sessionId} 变量（运行时取 dsh 会话 ID）
 *   - 匹配的启用规则按数组顺序应用，同名头后者覆盖
 *
 * 附带自愈：settings.yaml 的 llm-pi-ai.providers 若缺 cacheRetention，启动和
 * 文件变动时补写 `cacheRetention: long`（缺省时 pi-ai 退回 short，不发
 * prompt_cache_retention，缓存保留退化易未命中）。
 *
 * 注入点：globalThis.fetch 包装（幂等，dispose 恢复）。钩子在**模块导入时**
 * 立即安装（而非 apply 时），避免 headless 启动竞态导致首批请求漏拦截。
 * dsh 原生请求头（x-client-request-id / session_id）在此之前已就位，作为
 * sessionId 取值来源。
 *
 * 管理：connection RPC 通道 '/model-headers'（loopback），配置文件 fs.watch
 * 热加载。每次实际注入追加一行到 ~/.dsh/model-headers.log 供核验（>5MB 截断）。
 */

import { watch as fsWatch } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-model-headers'
export const inject = []
export { ensureCacheRetention, listConfiguredModels }

const DSH_HOME = () => process.env.DSH_HOME || path.join(homedir(), '.dsh')
const CONFIG_FILE = () => path.join(DSH_HOME(), 'model-headers.json')
const LOG_FILE = () => path.join(DSH_HOME(), 'model-headers.log')
const SETTINGS_FILE = () => path.join(DSH_HOME(), 'settings.yaml')
const LOG_MAX_BYTES = 5 * 1024 * 1024
const RPC_CHANNEL = '/model-headers'
const GUARD = Symbol.for('dsh.model-headers.installed')

const e2str = (e) => String(e?.message || e).slice(0, 160)

// ==================== 模块级注入引擎（apply 之外也能工作） ====================

let rules = [] // apply/loadRules 填充；钩子实时读取

/** 规则通配符 → 正则（仅 '*' 语义，其余字符转义；大小写不敏感）。 */
function modelPatternToRegExp(pattern) {
  const escaped = String(pattern)
    .split('*')
    .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`, 'i')
}

async function loadRules() {
  try {
    const raw = await readFile(CONFIG_FILE(), 'utf8')
    const parsed = JSON.parse(raw)
    rules = Array.isArray(parsed?.rules) ? parsed.rules : []
  } catch (e) {
    if (e?.code !== 'ENOENT') console.warn(`[dsh-model-headers] 配置读取失败：${e2str(e)}`)
    rules = []
  }
}

async function saveRules() {
  const file = CONFIG_FILE()
  await mkdir(path.dirname(file), { recursive: true })
  const data = `${JSON.stringify({ rules }, null, 2)}\n`
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await writeFile(tmp, data, 'utf8')
    // rename 覆盖已存在目标：先清掉旧的（Windows rename 不覆盖）
    await rm(file, { force: true })
    await rename(tmp, file)
  } catch {
    // 原子写不可用（受限环境/文件占用）时退化为直接覆盖
    await rm(tmp, { force: true }).catch(() => {})
    await writeFile(file, data, 'utf8')
  }
}

/**
 * 自愈 settings.yaml：给 llm-pi-ai.providers 下缺 cacheRetention 的 provider
 * 补写 `cacheRetention: long`。缺省时 pi-ai 退回 short → 不发
 * prompt_cache_retention，缓存保留退化易未命中。纯行级插入：只补缺失键，
 * 不动已有值（用户显式配的 none/short 一律尊重）与文件其它内容。
 */
async function ensureCacheRetention() {
  const file = SETTINGS_FILE()
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (e) {
    if (e?.code !== 'ENOENT') console.warn(`[dsh-model-headers] settings.yaml 读取失败：${e2str(e)}`)
    return
  }
  const lines = raw.split(/\r?\n/)
  const start = lines.findIndex((l) => /^llm-pi-ai:\s*(?:#.*)?$/.test(l))
  if (start < 0) return
  let providersAt = -1
  for (let k = start + 1; k < lines.length; k++) {
    if (/^\S/.test(lines[k])) break // 顶层下一个键，llm-pi-ai 块结束
    if (/^ {2}providers:\s*(?:#.*)?$/.test(lines[k])) { providersAt = k; break }
  }
  if (providersAt < 0) return
  // 遍历 provider 块（4 空格缩进键），检查块内（6 空格缩进）是否已有 cacheRetention
  const insertAt = []
  for (let k = providersAt + 1; k < lines.length; k++) {
    const line = lines[k]
    if (/^\S/.test(line)) break
    if (!/^ {4}[^ #\s][^:]*:\s*(?:#.*)?$/.test(line)) continue
    let has = false
    for (let q = k + 1; q < lines.length; q++) {
      const inner = lines[q]
      if (/^\S/.test(inner) || /^ {4}[^ ]/.test(inner)) break // 下一个 provider / 顶层
      if (/^ {6}cacheRetention:/.test(inner)) { has = true; break }
    }
    if (!has) insertAt.push(k + 1)
  }
  if (insertAt.length === 0) return
  for (const at of insertAt.reverse()) lines.splice(at, 0, '      cacheRetention: long')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await writeFile(tmp, lines.join(eol), 'utf8')
    await rm(file, { force: true })
    await rename(tmp, file)
    console.log(`[dsh-model-headers] settings.yaml 补写 cacheRetention: long × ${insertAt.length}`)
  } catch (e) {
    console.warn(`[dsh-model-headers] settings.yaml 补写失败（不影响请求头注入）：${e2str(e)}`)
    await rm(tmp, { force: true }).catch(() => {})
  }
}

/**
 * 行级扫描 settings.yaml，取 llm-pi-ai.providers 下配置的模型清单
 * （[{ provider, id }]），供管理 UI 选择指定模型。零 YAML 依赖。
 */
async function listConfiguredModels() {
  let raw = ''
  try {
    raw = await readFile(SETTINGS_FILE(), 'utf8')
  } catch {
    return []
  }
  const lines = raw.split(/\r?\n/)
  const start = lines.findIndex((l) => /^llm-pi-ai:\s*(?:#.*)?$/.test(l))
  if (start < 0) return []
  const out = []
  let provider = null
  let inModels = false
  for (let k = start + 1; k < lines.length; k++) {
    const line = lines[k]
    if (/^\S/.test(line)) break // 顶层下一键，llm-pi-ai 块结束
    let m = line.match(/^ {4}([^ #\s][^:]*):\s*(?:#.*)?$/)
    if (m) {
      provider = m[1].trim()
      inModels = false
      continue
    }
    if (provider === null) continue
    m = line.match(/^ {6}([^ #\s][^:]*):\s*(?:#.*)?$/)
    if (m) {
      inModels = m[1].trim() === 'models'
      continue
    }
    if (!inModels) continue
    m = line.match(/^ {8}- id:\s*(.+?)\s*(?:#.*)?$/)
    if (m) {
      const id = m[1].replace(/^['"]|['"]$/g, '')
      if (id !== '') out.push({ provider, id })
    }
  }
  return out
}

// ---- 核验日志（追加一行；超限截断重建；主位置写失败自动落到临时目录） ----
let logFile = null
let logWarned = false
async function writeLogLine(file, line) {
  let size = 0
  try { size = (await readFile(file)).length } catch {}
  if (size > LOG_MAX_BYTES) await rm(file, { force: true })
  await writeFile(file, line, { flag: 'a' })
}
async function appendLog(entry) {
  const line = `${JSON.stringify(entry)}\n`
  try {
    const file = logFile ?? LOG_FILE()
    await writeLogLine(file, line)
    logFile = file
  } catch (e) {
    if (logFile === null) {
      // 主位置（~/.dsh）不可写（受限环境/权限），退回临时目录
      try {
        const fallback = path.join(tmpdir(), 'dsh-model-headers.log')
        await writeLogLine(fallback, line)
        logFile = fallback
        console.warn(`[dsh-model-headers] 主日志位置不可写，改用 ${fallback}：${e2str(e)}`)
        return
      } catch {}
    }
    if (!logWarned) {
      logWarned = true
      console.warn(`[dsh-model-headers] 核验日志写入失败（注入本身不受影响）：${e2str(e)}`)
    }
  }
}

// ---- 头注入核心 ----
/** sessionId 来源优先级：原生头 x-client-request-id → session_id → body prompt_cache_key。 */
function resolveSessionId(lowerHeaders, cacheKey) {
  return (
    lowerHeaders['x-client-request-id'] ??
    lowerHeaders['session_id'] ??
    cacheKey ??
    null
  )
}

function computeHeaders(lowerHeaders, bodyFields) {
  if (rules.length === 0) return null
  const model = bodyFields.model
  if (!model) return null
  const sessionId = resolveSessionId(lowerHeaders, bodyFields.prompt_cache_key)
  const merged = {}
  let touched = false
  for (const rule of rules) {
    if (!rule?.enabled) continue
    const headers = rule.headers
    if (!headers || typeof headers !== 'object') continue
    let pattern
    try { pattern = modelPatternToRegExp(rule.model) } catch { continue }
    if (!pattern.test(model)) continue
    for (const [hName, rawValue] of Object.entries(headers)) {
      if (typeof hName !== 'string' || hName === '' || typeof rawValue !== 'string') continue
      let value = rawValue
      if (value.includes('${sessionId}')) {
        if (sessionId === null) continue // 取不到会话 ID：丢弃该头，不发字面量
        value = value.split('${sessionId}').join(sessionId)
      }
      merged[hName] = value
      touched = true
    }
  }
  return touched ? merged : null
}

function toPlainHeaders(headers) {
  const out = {}
  if (!headers) return out
  try {
    if (typeof headers.forEach === 'function') {
      headers.forEach((v, k) => { out[String(k).toLowerCase()] = v })
    } else if (Array.isArray(headers)) {
      for (const [k, v] of headers) out[String(k).toLowerCase()] = v
    } else {
      for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v
    }
  } catch {}
  return out
}

function parseBody(body) {
  try {
    if (typeof body !== 'string') return null
    const json = JSON.parse(body)
    if (!json || typeof json !== 'object') return null
    return {
      model: typeof json.model === 'string' && json.model !== '' ? json.model : null,
      prompt_cache_key: typeof json.prompt_cache_key === 'string' ? json.prompt_cache_key : null,
      prompt_cache_retention: typeof json.prompt_cache_retention === 'string' ? json.prompt_cache_retention : null,
    }
  } catch { return null }
}

function setHeader(init, name, value) {
  const headers = init.headers
  if (headers && typeof headers.set === 'function') {
    headers.set(name, value)
    return
  }
  if (Array.isArray(headers)) {
    const i = headers.findIndex(([k]) => String(k).toLowerCase() === name.toLowerCase())
    if (i >= 0) headers[i][1] = value
    else headers.push([name, value])
    return
  }
  init.headers = headers || {}
  init.headers[name] = value
}

function installFetchHook() {
  if (globalThis[GUARD]) return
  const debug = process.env.DSH_MH_DEBUG === '1'
  const origFetch = globalThis.fetch
  globalThis[GUARD] = origFetch
  globalThis.fetch = async function modelHeadersFetch(input, init) {
    try {
      const url = typeof input === 'string' ? input : input?.url
      const body = init?.body
      const bodyFields = parseBody(body)
      if (debug) {
        void appendLog({ t: new Date().toISOString(), debug: 'fetch', url: String(url).slice(0, 120), bodyType: typeof body, model: bodyFields?.model ?? null, cacheKey: bodyFields?.prompt_cache_key ?? null, retention: bodyFields?.prompt_cache_retention ?? null, hasClientReqId: Boolean(toPlainHeaders(init?.headers)['x-client-request-id']) })
      }
      if (bodyFields) {
        const lower = toPlainHeaders(init?.headers)
        const extra = computeHeaders(lower, bodyFields)
        if (extra) {
          for (const [hName, value] of Object.entries(extra)) setHeader(init, hName, value)
          void appendLog({
            t: new Date().toISOString(),
            model: bodyFields.model,
            headers: extra,
          })
        }
      }
    } catch {}
    return origFetch.call(this, input, init)
  }
}

function uninstallFetchHook() {
  const orig = globalThis[GUARD]
  if (orig === undefined) return
  if (globalThis.fetch.name === 'modelHeadersFetch') globalThis.fetch = orig
  delete globalThis[GUARD]
}

// 钩子在模块导入时立即安装：任何 LLM 请求（含插件 apply 之前的）都能被拦截。
installFetchHook()

// ==================== 插件装配 ====================

export function apply(ctx) {
  let watcher = null
  let watchTimer = null

  async function watchConfig() {
    if (watcher) return
    try {
      watcher = fsWatch(path.dirname(CONFIG_FILE()), (event, filename) => {
        const name = filename == null ? '' : String(filename)
        const isRules = name === 'model-headers.json'
        const isSettings = name === 'settings.yaml'
        if (!isRules && !isSettings) return
        clearTimeout(watchTimer)
        watchTimer = setTimeout(() => {
          if (isRules) void loadRules()
          if (isSettings) void ensureCacheRetention()
        }, 300)
      })
    } catch (e) {
      console.warn(`[dsh-model-headers] 配置监听失败（外部编辑需手动刷新）：${e2str(e)}`)
    }
  }

// ---- RPC ----
  const rpcOk = (value) => ({ ok: true, value })
  // 镜像 dsh-skill-mcp 的 RpcResult 形状；协议要求 error.code 走 discriminated union，
  // 且 internal 分支 details 必须为 {}（bad-request 会要求 details.issues，不适用）
  const rpcFail = (message) => ({ ok: false, error: { code: 'internal', message: String(message).slice(0, 300), details: {} } })

  const endpoints = {
    'headers/list': { run: async () => ({ rules, configFile: CONFIG_FILE() }) },
    'models/list': { run: async () => ({ models: await listConfiguredModels() }) },
    'headers/save': {
      run: async (p = {}) => {
        const rule = p?.rule
        if (!rule || typeof rule !== 'object') throw new Error('缺少 rule')
        if (typeof rule.model !== 'string' || rule.model.trim() === '') throw new Error('模型通配符不能为空')
        if (!rule.headers || typeof rule.headers !== 'object' || Object.keys(rule.headers).length === 0) {
          throw new Error('至少需要一条请求头')
        }
        const clean = {
          id: typeof rule.id === 'string' && rule.id !== '' ? rule.id : `r-${randomUUID()}`,
          enabled: rule.enabled !== false,
          model: rule.model.trim(),
          headers: {},
        }
        for (const [k, v] of Object.entries(rule.headers)) {
          if (typeof k === 'string' && k.trim() !== '' && typeof v === 'string') clean.headers[k.trim()] = v
        }
        const i = rules.findIndex((r) => r.id === clean.id)
        if (i >= 0) rules[i] = clean
        else rules.push(clean)
        await saveRules()
        return { rule: clean }
      },
    },
    'headers/remove': {
      run: async (p = {}) => {
        const before = rules.length
        rules = rules.filter((r) => r.id !== p?.id)
        if (rules.length === before) throw new Error(`未知规则 '${p?.id}'`)
        await saveRules()
        return { removed: p?.id }
      },
    },
    'headers/toggle': {
      run: async (p = {}) => {
        const rule = rules.find((r) => r.id === p?.id)
        if (!rule) throw new Error(`未知规则 '${p?.id}'`)
        rule.enabled = p?.enabled !== false
        await saveRules()
        return { rule }
      },
    },
  }

  // ---- 装配（apply 保持同步：加载/监听异步初始化，RPC 稍后即就绪） ----
  void (async () => {
    await loadRules()
    await ensureCacheRetention()
    await watchConfig()
    console.log(`[dsh-model-headers] host ready: ${rules.length} rule(s), rpc '${RPC_CHANNEL}'`)
  })()

  // connection 是 web profile 的服务，headless 没有 → 可选获取，取不到就跳过 RPC
  //（fetch 钩子与配置文件热加载不依赖它）。ctx.get 绕过 inject 要求直读服务店。
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  void (async () => {
    let connection
    for (let attempt = 0; attempt < 10; attempt++) {
      connection = ctx.get?.('connection')
      if (connection?.rpc?.handle) break
      connection = undefined
      await sleep(1000)
    }
    if (!connection?.rpc?.handle) {
      console.log('[dsh-model-headers] 无 connection 服务（headless）：RPC 关闭，注入钩子照常工作')
      return
    }
    connection.rpc.handle(RPC_CHANNEL, async (endpoint, payload) => {
      try {
        const action = endpoints[endpoint]
        if (action === undefined) return rpcFail(`unknown endpoint "${endpoint}"`)
        return rpcOk(await action.run(payload ?? {}))
      } catch (e) {
        return rpcFail(e2str(e))
      }
    }, { authority: 'loopback' })
    console.log(`[dsh-model-headers] rpc '${RPC_CHANNEL}' ready`)
  })()

  // 文件监听随插件卸载关闭；fetch 钩子恢复原状（配合热重载）。
  ctx.effect(() => () => {
    clearTimeout(watchTimer)
    watcher?.close()
    watcher = null
    uninstallFetchHook()
  })
}
