⸻


# cf-gemini-proxy

基于 **Cloudflare Workers** 的 Gemini API 无服务器中转层。  
支持 **多 API Key 池**、**KV 热更新**、**自动熔断 & 冷却**、**流式透传** 和 **CORS 控制**。  
用于保护密钥、防止前端暴露，同时实现负载分摊与高可用。

---

## ✨ 功能特性

- **无服务器**：Cloudflare Workers 部署，按请求触发，无需维护服务器。
- **多 Key 支持**：
  - Secret 模式：在 `GEMINI_KEYS` 中配置逗号分隔的多 Key。
  - KV 模式：使用 `KEYPOOL` 命名空间，热更新无需重新部署。
- **自动熔断**：
  - 429 → Key 冷却 30s。
  - 401/403 → 标记失效。
- **流式与非流式**：支持 `:generateContent` 和 `:streamGenerateContent`。
- **CORS 支持**：默认允许 `*`，建议上线改为白名单。
- **健康检查**：`/healthz` 查看池子大小与可用 Key 数。

---

## 🚀 快速使用

### 部署

```bash
# 安装依赖
npm install -g wrangler

# 初始化 Worker 项目
wrangler init cf-gemini-proxy
cd cf-gemini-proxy

# 设置 KV 命名空间
npx wrangler kv namespace create KEYPOOL
# 将生成的 id 写入 wrangler.jsonc

# 部署
npx wrangler deploy

写入 Key 池 (KV 热更新)

cat > pool.json <<'JSON'
{
  "keys": [
    { "key": "AIza...111", "weight": 1 },
    { "key": "AIza...222", "weight": 2 }
  ]
}
JSON

npx wrangler kv key put pool --binding=KEYPOOL --remote --path=pool.json

验证

# 查看 Key 池
npx wrangler kv key get pool --binding=KEYPOOL --remote

# 健康检查
curl https://cf-gemini-proxy.<subdomain>.workers.dev/healthz
# => {"ok":true,"size":2,"usable":2,...}


⸻

📡 调用示例

非流式

curl -X POST \
"https://cf-gemini-proxy.<subdomain>.workers.dev/gemini/v1beta/models/gemini-2.5-flash:generateContent" \
-H "Content-Type: application/json" \
-d '{
  "contents":[{"role":"user","parts":[{"text":"用一句话解释 Serverless"}]}]
}'

流式

curl -N -X POST \
"https://cf-gemini-proxy.<subdomain>.workers.dev/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent" \
-H "Content-Type: application/json" \
-d '{"contents":[{"parts":[{"text":"逐条输出三点优势"}]}]}'

前端调用

const r = await fetch('/gemini/v1beta/models/gemini-2.5-flash:generateContent', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: '你好' }]}]
  })
});
const data = await r.json();


⸻

🔧 KV 管理速查表

# 查看远程 Key 池
npx wrangler kv key get pool --binding=KEYPOOL --remote

# 更新 Key 池
npx wrangler kv key put pool --binding=KEYPOOL --remote --path=pool.json

# 删除 Key 池
npx wrangler kv key delete pool --binding=KEYPOOL --remote


⸻

⚠️ 注意事项
	•	密钥不要放前端，统一通过 Worker 代理。
	•	CORS 默认 *，上线时改为你的前端域名。
	•	建议结合 Cloudflare AI Gateway 做限流、可观测。
	•	Key 池 JSON 必须合法（结尾 ]} 不能漏）。

⸻

📂 项目结构

cf-gemini-proxy/
├── src/
│   └── worker.ts        # Worker 核心逻辑（多 Key 支持）
├── public/              # 静态资源目录
├── wrangler.jsonc       # 配置文件
└── pool.json            # KV Key 池示例（本地管理用）


⸻

🩺 健康检查接口

curl https://cf-gemini-proxy.<subdomain>.workers.dev/healthz
# => {"ok":true,"size":2,"usable":2,"ts":...}

	•	ok：是否有可用 Key
	•	size：Key 总数
	•	usable：当前可用 Key 数
	•	ts：时间戳

⸻


---

