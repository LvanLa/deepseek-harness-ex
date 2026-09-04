# dsh-model-headers

[dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) 插件：按模型名给 LLM 请求注入自定义请求头。

典型场景 —— Grok 中转的会话级缓存路由：让同一会话的所有请求携带恒定的 `X-Grok-Conv-Id` 头，与 body 里的 `prompt_cache_key` 恒等，从而命中中转的会话亲和缓存。

```json
{
  "rules": [
    {
      "id": "r-grok",
      "enabled": true,
      "model": "grok-*",
      "headers": { "X-Grok-Conv-Id": "${sessionId}" }
    }
  ]
}
```

## 工作原理

- **注入点**：包装 `globalThis.fetch`（幂等，插件卸载时恢复）。规则引擎在模块导入时即安装 —— 不依赖插件 `apply` 时机，headless 首批请求也不会漏拦截。
- **模型匹配**：通配符 `*`（大小写不敏感），匹配请求 body 的 `model` 字段。命中的启用规则按数组顺序应用，同名头后者覆盖。
- **值变量**：`${sessionId}` 运行时解析为当前 dsh 会话 ID（取 `x-client-request-id` → `session_id` 头 → body `prompt_cache_key`，兜底空串）。

## 管理 UI

dsh 设置页 →「模型请求头」：

- 规则的添加 / 编辑 / 删除 / 启停，改动实时生效（`fs.watch` 热加载）
- 模型下拉按供应商分组展示 settings.yaml 里已配置的模型，并自动推导通配符项（`*`、`grok-*`、`gpt-5.6-*` …），支持手输任意通配符与输入过滤
- 头值一键插入 `${sessionId}`

规则持久化在 `~/.dsh/model-headers.json`。

## 附带能力：settings.yaml 自愈

启动及 settings.yaml 变动时，自动给 `llm-pi-ai.providers` 下缺 `cacheRetention` 的 provider 补写 `cacheRetention: long`（已有值一律尊重）。缺省时 dsh 退回 short 保留策略、不发 `prompt_cache_retention`，中转缓存容易未命中 —— 本插件确保 24h 保留策略就位。

## 核验

每次实际注入追加一行到 `~/.dsh/model-headers.log`（超 5MB 截断；主目录不可写自动落临时目录）。设 `DSH_MH_DEBUG=1` 可额外记录每个请求的 cacheKey / retention。

## License

BSD-3-Clause
