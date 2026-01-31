# LLM 接口（OpenAI 兼容）

本项目的 LLM 能力遵循“**OpenAI 兼容 Chat Completions**”的最小公共形态，且**允许用户自行配置模型**与服务商。

重要约束：
- **禁止**把任何 API Key 写入仓库（包括文档、示例、截图）。
- API Key 支持两种注入方式（优先推荐第 1 种）：
  1) 通过环境变量注入（使用 `llm.apiKeyEnv` 指定 env var 名）
  2) 写入 `config/config.json` 的 `llm.apiKey`（该文件已被 `.gitignore` 忽略，仅用于本地）

---

## 1) 配置方式

1. 复制示例配置：
   - `config/config.example.json` → `config/config.json`
2. 按需填写 `llm` 段：

```json
{
  "llm": {
    "enabled": true,
    "baseUrl": "https://api.openai.com",
    "chatCompletionsPath": "/v1/chat/completions",
    "apiKeyEnv": "META_LLM_API_KEY",
    "model": "gpt-4o-mini",
    "timeoutMs": 30000,
    "retries": 2,
    "maxConcurrency": 1
  }
}
```

3. 两种 key 写法（二选一）：

- 方式 A：使用环境变量（推荐）
- 方式 B：直接在 `config/config.json` 填 `llm.apiKey`（仅本地；注意不要提交/截图/发日志）

PowerShell：
```powershell
$env:META_LLM_API_KEY="YOUR_API_KEY"
```

---

## 2) LLM 在本项目中的用途

目前 LLM 主要用于**生成/升级角色 `calc.js`**（伤害计算的 `details`，以及尽量贴近基线结构的 `buffs`）。

典型用法：

```powershell
node dist/cli.js calc --games gs,sr
```

与缓存有关的参数：
- `.cache/llm/`：LLM 响应磁盘缓存
- `--force-cache`：绕过 `.cache/llm/` 强制重新请求（弱模型/调 prompt 时常用）

---

## 2) 兼容性说明

默认接口路径使用 OpenAI 标准：
- `baseUrl=https://api.openai.com`
- `chatCompletionsPath=/v1/chat/completions`

部分厂商虽保持请求/响应形态兼容，但路径前缀不同；可通过 `chatCompletionsPath` 适配。

---

## 3) GLM / BigModel 示例（glm-4.7-flash）

BigModel（智谱）示例参数：
- `baseUrl=https://open.bigmodel.cn`
- `chatCompletionsPath=/api/paas/v4/chat/completions`
- `model=glm-4.7-flash`
- `maxConcurrency=1`（免费模型通常不允许并发）

```json
{
  "llm": {
    "enabled": true,
    "baseUrl": "https://open.bigmodel.cn",
    "chatCompletionsPath": "/api/paas/v4/chat/completions",
    "apiKey": "YOUR_API_KEY",
    "apiKeyEnv": "META_LLM_API_KEY",
    "model": "glm-4.7-flash",
    "timeoutMs": 60000,
    "retries": 2,
    "maxConcurrency": 1
  }
}
```

> 兼容提示：若你误把 key 粘贴到了 `apiKeyEnv` 字段，本项目会将“非 env 变量名形态”的 `apiKeyEnv` 当作 key 使用；
> 但仍建议改为填写 `apiKey`（或改为 env），避免语义混淆。

curl（仅演示形态，Key 用占位符）：

```bash
curl -X POST "https://open.bigmodel.cn/api/paas/v4/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "glm-4.7-flash",
    "messages": [
      { "role": "system", "content": "你是一个有用的AI助手。" },
      { "role": "user", "content": "你好，请介绍一下自己。" }
    ],
    "temperature": 1.0,
    "stream": false
  }'
```

---

## 4) 安全提醒（必须做）

如果你曾经把 Key 写进仓库（哪怕后来删除）：
- **立刻在服务商后台吊销/轮换**该 Key
- 新 Key 用环境变量注入，不要再落盘到 repo
