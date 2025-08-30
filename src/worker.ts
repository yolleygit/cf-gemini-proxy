export interface Env {
  GEMINI_KEYS?: string;      // 兜底方案：逗号分隔的 Keys
  KEYPOOL?: KVNamespace;     // KV 命名空间（推荐）
}

type PoolItem = { key: string; weight?: number; cooldownUntil?: number; bad?: boolean };

const UPSTREAM = "https://generativelanguage.googleapis.com";
const CORS_ALLOW = ["*"]; // 上线建议改成你的前端域名

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const u = new URL(req.url);

    // 健康检查
    if (u.pathname === "/healthz") {
      const { pool } = await loadPool(env);
      const usable = pool.filter(canUse).length;
      return json({ ok: usable > 0, size: pool.length, usable, ts: Date.now() });
    }

    // 处理 CORS 预检
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(u, req) });

    // 仅处理 /gemini/*
    if (!u.pathname.startsWith("/gemini/")) return json({ error: "Not Found" }, 404);

    const targetPath = u.pathname.replace(/^\/gemini/, "");
    const targetBase = new URL(targetPath + u.search, UPSTREAM);

    const hasBody = !["GET", "HEAD"].includes(req.method);
    const body = hasBody ? await req.arrayBuffer() : undefined;

    const { pool, stickyIndex } = await loadPool(env, u, req);
    if (pool.length === 0) return json({ error: "No API keys configured" }, 500);

    let lastErr: any = null;
    const triedIdx: number[] = [];

    // 尝试多把 key
    for (let attempt = 0; attempt < pool.length; attempt++) {
      const idx = pickIndex(pool, stickyIndex, triedIdx);
      if (idx === -1) break;
      triedIdx.push(idx);

      const it = pool[idx];
      if (!canUse(it)) continue;

      const target = new URL(targetBase);
      target.searchParams.set("key", it.key);

      try {
        const upstream = await fetch(target.toString(), {
          method: req.method,
          headers: forwardHeaders(req),
          body: body ? new Uint8Array(body) : undefined,
        });

        if (upstream.status === 429) {
          markCooldown(it, 30_000); // 冷却30秒
          lastErr = await safeClone(upstream);
          continue;
        }
        if (upstream.status === 401 || upstream.status === 403) {
          it.bad = true;
          lastErr = await safeClone(upstream);
          continue;
        }

        // 正常情况：透传响应（流式也支持）
        const respHeaders = new Headers(upstream.headers);
        applyCors(respHeaders, u, req);
        respHeaders.delete("transfer-encoding");
        return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
      } catch (e: any) {
        lastErr = e;
        markCooldown(it, 5_000);
        continue;
      }
    }

    return json({ error: "All keys failed", detail: serializeErr(lastErr) }, 502, u, req);
  },
} satisfies ExportedHandler<Env>;

/* -------------------- Pool / Key 管理 -------------------- */

async function loadPool(env: Env, u?: URL, req?: Request) {
  let pool: PoolItem[] = [];

  // 优先 KV
  if (env.KEYPOOL) {
    try {
      const raw = await env.KEYPOOL.get("pool");
      if (raw) {
        const obj = JSON.parse(raw) as { keys: PoolItem[] };
        pool = normalizePool(obj.keys);
      }
    } catch {}
  }

  // Secret 兜底
  if (pool.length === 0 && env.GEMINI_KEYS) {
    pool = normalizePool(
      env.GEMINI_KEYS.split(",").map((s) => ({ key: s.trim(), weight: 1 }))
    );
  }

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

  if (sticky !== undefined && !tried.includes(sticky) && canUse(pool[sticky])) return sticky;

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

/* -------------------- 工具函数 -------------------- */

function forwardHeaders(req: Request): Headers {
  const h = new Headers(req.headers);
  h.set("Content-Type", "application/json");
  h.delete("host");
  h.delete("cf-connecting-ip");
  h.delete("cf-ipcountry");
  h.delete("cf-ray");
  h.delete("cf-visitor");
  h.delete("connection");
  h.delete("keep-alive");
  return h;
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

function json(data: unknown, status = 200, u?: URL, req?: Request) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (u && req) Object.assign(h, cors(u, req));
  return new Response(JSON.stringify(data), { status, headers: h });
}

async function safeClone(resp: Response) {
  try {
    const t = await resp.clone().text();
    return { status: resp.status, body: t.slice(0, 1024) };
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
