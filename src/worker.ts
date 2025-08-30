// cf-gemini-proxy / src/worker.ts
// - KV 多 Key 池 (KEYPOOL) + Secret 兜底 (GEMINI_KEYS)
// - 代理层口令 (PROXY_KEY) 鉴权：Authorization: Bearer <PROXY_KEY>
// - CORS (上线请改白名单)
// - 流式/非流式透传
// - 429 冷却 / 401-403 熔断 / 加权随机选择 Key
// - 不把客户端 Authorization 传给 Google；真正的认证用 ?key=<GeminiKey>

export interface Env {
  KEYPOOL?: KVNamespace; // KV 命名空间（热更新钥池，推荐）
  GEMINI_KEYS?: string;  // 兜底：逗号分隔 Keys（非必需）
  PROXY_KEY?: string;    // 代理层口令（必配）
}

type PoolItem = { key: string; weight?: number; cooldownUntil?: number; bad?: boolean };

const UPSTREAM = "https://generativelanguage.googleapis.com";
const CORS_ALLOW = ["*"]; // ← 上线改成你的前端域名，如 "https://yourapp.com"

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const u = new URL(req.url);

    // CORS 预检
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(u, req) });

    // /healthz：查看池子状态（不暴露 key）
    if (u.pathname === "/healthz") {
      const { pool } = await loadPool(env);
      const usable = pool.filter(canUse).length;
      return json({ ok: usable > 0, size: pool.length, usable, ts: Date.now() }, 200, u, req);
    }

    // 仅处理 /gemini/*
    if (!u.pathname.startsWith("/v1beta/")) {
      return json({ error: "Not Found" }, 404, u, req);
    }

    // 代理层口令鉴权（不传给上游）
    if (!checkProxyAuth(req, env.PROXY_KEY)) {
      return json({ error: "Unauthorized" }, 401, u, req);
    }

    // 透传路径：/gemini/v1beta/... -> /v1beta/...
    // const targetPath = u.pathname.replace(/^\/gemini/, "");
    // const targetBase = new URL(targetPath + u.search, UPSTREAM);
    // 透传路径：保持和官方一致
    const targetBase = new URL(u.pathname + u.search, UPSTREAM);

    const hasBody = !["GET", "HEAD"].includes(req.method);
    const body = hasBody ? await req.arrayBuffer() : undefined;

    // 加载钥池（KV 优先，Secret 兜底），并做“粘性分配”
    const { pool, stickyIndex } = await loadPool(env, u, req);
    if (pool.length === 0) return json({ error: "No API keys configured" }, 500, u, req);

    let lastErr: any = null;
    const triedIdx: number[] = [];

    // 依次尝试池子里的 key（加权随机 + 粘性；失败自动切换）
    for (let attempt = 0; attempt < pool.length; attempt++) {
      const idx = pickIndex(pool, stickyIndex, triedIdx);
      if (idx === -1) break;
      triedIdx.push(idx);

      const it = pool[idx];
      if (!canUse(it)) continue;

      const target = new URL(targetBase);
      // 上游真正认证：?key=<GeminiKey>
      target.searchParams.set("key", it.key);

      try {
        const upstream = await fetch(target.toString(), {
          method: req.method,
          headers: forwardHeaders(req), // 会剥离 authorization 等不该上传的头
          body: body ? new Uint8Array(body) : undefined,
        });

        // 速率/配额：短暂冷却，换下一把重试
        if (upstream.status === 429) {
          markCooldown(it, 30_000);
          lastErr = await safeClone(upstream);
          continue;
        }

        // 凭证无效/被禁：标记坏 key
        if (upstream.status === 401 || upstream.status === 403) {
          it.bad = true;
          lastErr = await safeClone(upstream);
          continue;
        }

        // 其他情况：直接透传（包含流式）
        const respHeaders = new Headers(upstream.headers);
        applyCors(respHeaders, u, req);
        respHeaders.delete("transfer-encoding");
        return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
      } catch (e: any) {
        lastErr = e;
        markCooldown(it, 5_000); // 网络异常：轻微冷却，换下一把
        continue;
      }
    }

    // 全部失败
    return json({ error: "All keys failed", detail: serializeErr(lastErr) }, 502, u, req);
  },
} satisfies ExportedHandler<Env>;

/* -------------------- 鉴权 / CORS -------------------- */

function checkProxyAuth(req: Request, proxyKey?: string): boolean {
  if (!proxyKey) return false;

  // 1) Authorization: Bearer <PROXY_KEY>
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  // 2) x-goog-api-key: <PROXY_KEY>   // Cherry Gemini 默认用这个
  const xg = (req.headers.get("x-goog-api-key") || "").trim();

  // 3) x-api-key: <PROXY_KEY>        // 兼容其他客户端
  const xk = (req.headers.get("x-api-key") || "").trim();

  return token === proxyKey || xg === proxyKey || xk === proxyKey;
}

function cors(u: URL, req: Request) {
  const o = req.headers.get("Origin");
  const allow =
    CORS_ALLOW.includes("*") || (o && CORS_ALLOW.includes(o)) ? (o ?? "*") : CORS_ALLOW[0] ?? "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function applyCors(h: Headers, u: URL, req: Request) {
  const c = cors(u, req);
  for (const [k, v] of Object.entries(c)) h.set(k, v);
}

/* -------------------- 钥池管理 -------------------- */

async function loadPool(env: Env, u?: URL, req?: Request) {
  let pool: PoolItem[] = [];

  // KV 优先
  if (env.KEYPOOL) {
    const raw = await env.KEYPOOL.get("pool");
    if (raw) {
      try {
        const obj = JSON.parse(raw) as { keys: PoolItem[] };
        pool = normalizePool(obj.keys);
      } catch (e) {
        console.error("KV pool JSON parse error:", e);
      }
    }
  }

  // Secret 兜底（GEMINI_KEYS="k1,k2,k3"）
  if (pool.length === 0 && env.GEMINI_KEYS) {
    pool = normalizePool(
      env.GEMINI_KEYS.split(",").map((s) => ({ key: s.trim(), weight: 1 }))
    );
  }

  // 粘性分配：同一来源尽量落同一把 key，降低抖动
  let stickyIndex: number | undefined;
  if (pool.length > 0 && u && req) {
    const stickySeed =
      req.headers.get("x-forwarded-for") ||
      req.headers.get("cf-connecting-ip") ||
      req.headers.get("authorization") ||
      u.hostname;
    if (stickySeed) {
      const h = hashStr(stickySeed);
      stickyIndex = h % pool.length;
    }
  }

  // 清理过期冷却
  const now = Date.now();
  for (const it of pool) {
    if (it.cooldownUntil && it.cooldownUntil < now) it.cooldownUntil = undefined;
  }

  return { pool, stickyIndex };
}

function normalizePool(list: PoolItem[]): PoolItem[] {
  const seen = new Set<string>();
  const out: PoolItem[] = [];
  for (const it of list) {
    const k = (it.key || "").trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ key: k, weight: it.weight ?? 1 });
  }
  return out;
}

function canUse(it: PoolItem): boolean {
  if (it.bad) return false;
  if (it.cooldownUntil && it.cooldownUntil > Date.now()) return false;
  return true;
}

function pickIndex(pool: PoolItem[], sticky?: number, tried: number[] = []): number {
  const usable = pool
    .map((it, i) => ({ it, i }))
    .filter(({ it, i }) => canUse(it) && !tried.includes(i));
  if (usable.length === 0) return -1;

  // 粘性优先
  if (sticky !== undefined && !tried.includes(sticky) && canUse(pool[sticky])) return sticky;

  // 加权随机
  const total = usable.reduce((s, x) => s + (x.it.weight ?? 1), 0);
  let r = Math.random() * total;
  for (const x of usable) {
    r -= x.it.weight ?? 1;
    if (r <= 0) return x.i;
  }
  return usable[usable.length - 1].i;
}

function markCooldown(it: PoolItem, ms: number) {
  it.cooldownUntil = Date.now() + ms;
}

/* -------------------- 辅助函数 -------------------- */

function forwardHeaders(req: Request): Headers {
  const h = new Headers(req.headers);

  // 统一强制 JSON
  h.set("Content-Type", "application/json");

  // 不要把客户端的 Authorization 传给 Google（否则上游 401）
  h.delete("authorization");

  // 清理无关/干扰头（交给平台管理）
  h.delete("host");
  h.delete("cf-connecting-ip");
  h.delete("cf-ipcountry");
  h.delete("cf-ray");
  h.delete("cf-visitor");
  h.delete("connection");
  h.delete("keep-alive");
  return h;
}

function json(data: unknown, status = 200, u?: URL, req?: Request) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (u && req) Object.assign(h, cors(u, req));
  return new Response(JSON.stringify(data), { status, headers: h });
}

async function safeClone(resp: Response) {
  try {
    const t = await resp.clone().text();
    return { status: resp.status, body: t.slice(0, 2048) };
  } catch {
    return { status: resp.status };
  }
}

function serializeErr(e: any) {
  if (!e) return null;
  if (typeof e === "string") return e;
  if (e.status) return e;
  return { message: e.message || String(e) };
}

function hashStr(s: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
