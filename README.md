# cf-gemini-proxy

基于 **Cloudflare Workers** 的 Gemini API 无服务器中转层。  
支持 **多 API Key 池 (KV 热更新)**、**代理口令 (PROXY_KEY) 鉴权**、**自动熔断 & 冷却**、**流式透传** 和 **CORS 控制**。  
用于保护真实 Gemini Key、防止前端暴露，同时实现负载分摊与高可用。

---

## ✨ 功能特性

- **无服务器**：Cloudflare Workers 部署，按请求触发，无需维护服务器。
- **安全升级 (必选)**：加入 `PROXY_KEY` 作为代理口令，只有携带正确口令的客户端才能调用。
- **多 Key 支持**：
  - Secret 模式：`GEMINI_KEYS` 中配置逗号分隔的多个 Key。
  - KV 模式：`KEYPOOL` 命名空间，支持热更新，无需重新部署。
- **自动熔断**：
  - 429 → Key 冷却 30s。
  - 401/403 → 标记失效。
- **流式与非流式**：支持 `:generateContent` 和 `:streamGenerateContent`。
- **CORS 支持**：默认 `*`，建议上线改为白名单。
- **健康检查**：`/healthz` 查看池子大小与可用 Key 数。

---

## 🚀 快速使用

### 1. 部署

```bash
npm install -g wrangler
wrangler init cf-gemini-proxy
cd cf-gemini-proxy

# 创建 KV 命名空间
npx wrangler kv namespace create KEYPOOL

在 wrangler.jsonc 自动加入：

{
  "kv_namespaces": [
    { "binding": "KEYPOOL", "id": "<你的命名空间ID>" }
  ]
}

2. 配置 Secrets

# 设置代理口令（必须）
npx wrangler secret put PROXY_KEY
# 例如输入: Proxy_key_pass_123abc#

# 可选：设置兜底 Gemini Key（逗号分隔）
npx wrangler secret put GEMINI_KEYS

3. 写入 Key 池 (KV 热更新)

cat > pool.json <<'JSON'
{
  "keys": [
    { "key": "AIza...111", "weight": 1 },
    { "key": "AIza...222", "weight": 2 }
  ]
}
JSON

npx wrangler kv key put pool --binding=KEYPOOL --remote --path=pool.json

4. 部署

npx wrangler deploy


⸻

🔐 调用方式（必须带 PROXY_KEY）

curl 示例
	•	未带口令 → 401

curl -X POST "https://<你的域名>/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"测试无口令"}]}]}'
# {"error":"Unauthorized"}

	•	带口令 → 200

curl -X POST "https://<你的域名>/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer Proxy_key_pass_123abc#" \
  -d '{"contents":[{"parts":[{"text":"测试有口令"}]}]}'

Cherry Studio / 其他客户端

在 Gemini 提供商配置中：
	•	API 地址：https://<你的 workers 域名>
	•	API 密钥：填 PROXY_KEY（例如 Proxy_key_pass_123abc#）
	•	模型：选择 gemini-2.5-flash

Cherry 默认使用 x-goog-api-key 头，Worker 已兼容，直接可用。

⸻

📡 健康检查

curl https://<你的域名>/healthz
# => {"ok":true,"size":2,"usable":2,"ts":...}


⸻

📊 安全优势
	•	避免匿名滥用：没有口令直接拒绝调用。
	•	口令可控：可随时更换，立即生效。
	•	兼容多客户端：支持 Authorization、x-goog-api-key、x-api-key 三种传法。
	•	不暴露上游 Gemini Key：真实 Key 永远只存储在 KV/Secret，不下发给客户端。

⸻

⚠️ 注意事项
	•	请修改 CORS_ALLOW 为你的前端域名，避免跨站调用。
	•	PROXY_KEY 建议设置为高强度随机字符串。
	•	结合 Cloudflare Ruleset/AI Gateway，可进一步加上限流、可观测。

⸻

📂 项目结构

cf-gemini-proxy/
├── src/
│   └── worker.ts        # Worker 核心逻辑（含 PROXY_KEY 鉴权）
├── public/              # 静态资源目录
├── wrangler.jsonc       # 配置文件
└── pool.json            # KV Key 池示例

---

