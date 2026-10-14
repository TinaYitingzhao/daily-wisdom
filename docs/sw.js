// 离线缓存
// - 页面、脚本、文字数据、曲目清单：网络优先，断网时用缓存（有网就能拿到最新内容）
// - 图片、音乐文件：缓存优先（文件名不会变内容，下载过一次就一直可用）
// 媒体单独放一个缓存，网站代码更新时不会把已经存好的图片和音乐清掉。

const SHELL_CACHE = "dw-shell-v5";
const MEDIA_CACHE = "dw-media-v1";
const SHELL = [
  "./", "index.html", "style.css", "app.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
  "data/posts.json",
];
const OPTIONAL = ["data/profile.json", "music/playlist.txt"];
const NETWORK_TIMEOUT_MS = 5000;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    await c.addAll(SHELL);
    await Promise.all(OPTIONAL.map((u) => c.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keep = [SHELL_CACHE, MEDIA_CACHE];
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET") return;

  // 网页字体（Google Fonts）：缓存起来，离线时也用同样的字体
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(staleWhileRevalidate(req));
    return;
  }
  if (url.origin !== location.origin) return;

  if (url.pathname.includes("/images/")) {
    e.respondWith(cacheFirst(req));
  } else if (url.pathname.includes("/music/") && /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm)$/i.test(url.pathname)) {
    e.respondWith(audio(req));
  } else {
    e.respondWith(networkFirst(req));
  }
});

// 页面让 SW 在后台把配图存起来（逐个下载，已经存过的跳过）
self.addEventListener("message", (e) => {
  if (!e.data || e.data.type !== "cache-media") return;
  e.waitUntil((async () => {
    const c = await caches.open(MEDIA_CACHE);
    for (const u of e.data.urls) {
      const abs = new URL(u, self.registration.scope).href;
      if (await c.match(abs)) continue;
      try {
        const res = await fetch(abs);
        if (res.ok) await c.put(abs, res);
      } catch { return; } // 断网了就停，下次再继续
    }
  })());
});

async function networkFirst(req) {
  const c = await caches.open(SHELL_CACHE);
  try {
    // cache: "no-cache"：绕过浏览器的 HTTP 缓存（GitHub Pages 默认让浏览器缓存 10 分钟），
    // 每次都向服务器确认是否有新版本；文件没变时服务器只回一个很小的 304
    const res = await withTimeout(fetch(req.url, { cache: "no-cache", credentials: "same-origin" }), NETWORK_TIMEOUT_MS);
    if (res.ok) await c.put(stripQuery(req), res.clone());
    return res;
  } catch {
    const hit = await c.match(req, { ignoreSearch: true })
      || (req.mode === "navigate" ? await c.match("./") : null);
    return hit || Response.error();
  }
}

async function cacheFirst(req) {
  const c = await caches.open(MEDIA_CACHE);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await c.put(req, res.clone());
  return res;
}

// 音频会用 Range 请求分段读取，而缓存只能存完整文件：
// 第一次播放时下载整个文件存入缓存，再按 Range 切片返回。
async function audio(req) {
  const c = await caches.open(MEDIA_CACHE);
  const key = req.url.split("#")[0];
  let res = await c.match(key);
  if (!res) {
    const full = await fetch(key);
    if (!full.ok) return full;
    await c.put(key, full.clone());
    res = full;
  }
  const range = req.headers.get("range");
  if (!range) return res;

  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = 0;
  let end = size - 1;
  if (m && m[1]) {
    start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), size - 1);
  } else if (m && m[2]) {
    start = Math.max(0, size - Number(m[2])); // bytes=-500：最后 500 字节
  }
  if (start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "audio/mpeg",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}

async function staleWhileRevalidate(req) {
  const c = await caches.open(MEDIA_CACHE);
  const hit = await c.match(req);
  const update = fetch(req).then((res) => {
    if (res.ok || res.type === "opaque") c.put(req, res.clone());
    return res;
  }).catch(() => null);
  return hit || (await update) || Response.error();
}

function stripQuery(req) {
  const u = new URL(req.url);
  u.search = "";
  return u.href;
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
