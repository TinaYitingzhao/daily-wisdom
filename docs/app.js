(() => {
  "use strict";

  // 速度 1–10 档。滚动模式：像素/秒；幻灯片模式：每条停留秒数（长文会自动延长）
  const SCROLL_PX = [6, 9, 12, 16, 21, 27, 35, 45, 58, 75];
  const SLIDE_SEC = [60, 45, 35, 28, 22, 17, 13, 10, 8, 6];
  const REFRESH_MS = 60 * 60 * 1000;
  const HIDE_MS = 3500;
  const BG_CACHE_POSTS = 200;
  const svg = (d) => '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">' + d + "</svg>";
  const ICON_PAUSE = svg('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>');
  const ICON_PLAY = svg('<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>');

  const $ = (id) => document.getElementById(id);
  const feed = $("feed");
  const slides = $("slides");
  const stage = $("stage");
  const progress = $("progress");
  const statusEl = $("status");
  const controls = $("controls");
  const playBtn = $("play");
  const speed = $("speed");
  const speedValue = $("speedValue");
  const root = document.documentElement;

  // ---------------------------------------------------------------- 设置

  const settings = Object.assign(
    { mode: "slides", scrollSpeed: 3, slideSpeed: 5, theme: "auto", volume: 60, clock: true, night: true, musicSource: "auto" },
    load()
  );
  // 新版默认幻灯片：旧版本保存的“滚动”设置迁移一次
  if (settings.v !== 2) { settings.mode = "slides"; settings.v = 2; }

  function load() {
    try { return JSON.parse(localStorage.getItem("dw-settings")) || {}; } catch { return {}; }
  }
  function save() {
    try { localStorage.setItem("dw-settings", JSON.stringify(settings)); } catch { /* 隐私模式 */ }
  }

  // ---------------------------------------------------------------- 数据

  let posts = [];
  let pending = null; // 后台刷新得到的新数据，在下一轮开始时替换
  let profile = null; // { name, avatar }，由抓取脚本写入 data/profile.json

  async function fetchPosts() {
    const res = await fetch("data/posts.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const list = await res.json();
    return list.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  async function fetchProfile() {
    const res = await fetch("data/profile.json", { cache: "no-cache" });
    if (!res.ok) return null;
    return res.json();
  }

  function renderProfile() {
    const mast = $("masthead");
    if (!profile || !profile.avatar) { mast.hidden = true; return; }
    $("mastAvatar").src = profile.avatar;
    $("mastName").textContent = profile.name || "";
    mast.hidden = false;
  }

  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });

  function postEl(p, eager) {
    const art = document.createElement("article");
    art.className = "post";

    const meta = document.createElement("div");
    meta.className = "meta";
    if (profile && profile.avatar) {
      const av = document.createElement("img");
      av.className = "avatar-sm";
      av.src = profile.avatar;
      av.alt = "";
      av.width = av.height = 32;
      meta.appendChild(av);
      const nm = document.createElement("span");
      nm.className = "name";
      nm.textContent = profile.name || "";
      meta.appendChild(nm);
    }
    const t = document.createElement("time");
    t.dateTime = p.created_at;
    t.textContent = fmt.format(new Date(p.created_at));
    meta.appendChild(t);
    art.appendChild(meta);

    if (p.text) {
      const txt = document.createElement("p");
      txt.className = "text";
      txt.textContent = p.text;
      art.appendChild(txt);
    }

    const imgs = p.images || [];
    if (imgs.length) {
      const box = document.createElement("div");
      box.className = "pics " + (imgs.length <= 4 ? "n" + imgs.length : "many");
      for (const src of imgs) {
        const img = document.createElement("img");
        img.src = src;
        img.alt = "";
        img.decoding = "async";
        if (!eager) img.loading = "lazy";
        img.onerror = () => img.remove();
        box.appendChild(img);
      }
      art.appendChild(box);
    }
    return art;
  }

  function renderFeed() {
    feed.replaceChildren(...posts.map((p, i) => postEl(p, i < 3)));
  }

  function applyPending() {
    if (!pending) return false;
    posts = pending;
    pending = null;
    return true;
  }

  // ---------------------------------------------------------------- 播放状态

  let playing = true;
  let lastTs = 0;

  function setPlaying(v) {
    playing = v;
    playBtn.innerHTML = v ? ICON_PAUSE : ICON_PLAY;
    playBtn.setAttribute("aria-label", v ? "暂停" : "播放");
    slides.classList.toggle("paused", !v);
    wakeLock(v);
    if (v) scheduleHide(); else showControls(false);
  }

  function setMode(mode) {
    settings.mode = mode;
    save();
    document.body.classList.toggle("mode-slides", mode === "slides");
    for (const b of document.querySelectorAll("[data-mode]")) {
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    }
    if (mode === "slides") {
      feed.hidden = true;
      slides.hidden = false;
      // 从当前屏幕上看到的那条开始
      slideIndex = Math.max(0, visiblePostIndex());
      showSlide(slideIndex, false);
    } else {
      slides.hidden = true;
      feed.hidden = false;
      if (applyPending()) renderFeed();
      const target = feed.children[slideIndex];
      if (target && slideIndex > 0) target.scrollIntoView();
      scrollPos = window.scrollY;
    }
    syncSpeed();
  }

  function syncSpeed() {
    const slidesMode = settings.mode === "slides";
    const level = slidesMode ? settings.slideSpeed : settings.scrollSpeed;
    speed.value = level;
    speedValue.textContent = slidesMode ? SLIDE_SEC[level - 1] + " 秒" : level + " 档";
  }

  // ---------------------------------------------------------------- 滚动模式

  let scrollPos = 0;
  let lastSet = 0;
  let wrapping = false;

  function scrollStep(dt) {
    if (wrapping) return;
    // 用户手动拖动过，就从新的位置继续
    if (Math.abs(window.scrollY - lastSet) > 3) scrollPos = window.scrollY;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (scrollPos >= max - 1) { wrapToTop(); return; }
    scrollPos = Math.min(max, scrollPos + SCROLL_PX[settings.scrollSpeed - 1] * dt);
    window.scrollTo(0, scrollPos);
    lastSet = window.scrollY;
  }

  function wrapToTop() {
    wrapping = true;
    setTimeout(() => {
      feed.style.transition = "opacity 1.2s";
      feed.style.opacity = "0";
      setTimeout(() => {
        if (applyPending()) renderFeed();
        window.scrollTo(0, 0);
        scrollPos = lastSet = 0;
        feed.style.opacity = "1";
        setTimeout(() => { wrapping = false; }, 3000);
      }, 1300);
    }, 4000);
  }

  function visiblePostIndex() {
    if (feed.hidden) return slideIndex;
    const mid = window.innerHeight / 3;
    const kids = feed.children;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].getBoundingClientRect().bottom > mid) return i;
    }
    return 0;
  }

  // ---------------------------------------------------------------- 幻灯片模式

  let slideIndex = 0;
  let slideElapsed = 0;
  let slideDuration = 20;

  const MIN_PER_IMAGE = 7; // 多图微博里每张图至少停留的秒数

  const READ_CHARS_PER_SEC = 5; // 安静阅读的速度，长文按字数多给时间

  // 停留时间：每页至少“基础秒数”，字多的页按阅读速度加时间；多图时每张图至少 7 秒；夜间放慢一半
  function durationFor(p, pages) {
    const base = SLIDE_SEC[settings.slideSpeed - 1];
    const list = pages && pages.length ? pages : [p.text || ""];
    const text = list.reduce((t, pg) => t + Math.max(base, pg.length / READ_CHARS_PER_SEC), 0);
    const n = (p.images || []).length;
    return Math.max(text, n * Math.max(MIN_PER_IMAGE, base * 0.6)) * (isNight ? 1.5 : 1);
  }

  const dayFmt = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", day: "numeric" });
  const ymFmt = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long" });
  const wdFmt = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "long" });
  const hmFmt = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // 一页幻灯片：左边（竖屏时上边）是图片，右边是日期、正文和署名
  function slideEl(p) {
    const imgs = p.images || [];
    const sl = el("article", "sl" + (imgs.length ? "" : " text-only"));
    if (!imgs.length && (p.text || "").length <= 60) sl.classList.add("short");

    if (imgs.length) {
      const media = el("div", "media");
      const bd = el("img", "backdrop");
      bd.alt = "";
      bd.src = imgs[0];
      media.appendChild(bd);
      imgs.forEach((src, k) => {
        const im = el("img", "photo" + (k === 0 ? " on" : ""));
        im.alt = "";
        im.src = src;
        im.decoding = "async";
        im.onerror = () => im.remove();
        media.appendChild(im);
      });
      if (imgs.length > 1) media.appendChild(el("div", "count", "1 / " + imgs.length));
      sl.appendChild(media);
    }

    const copy = el("div", "copy");
    // 文字区左上角：头像 + 昵称（固定在角上，不随长文滚动）
    if (profile && profile.name) {
      const who = el("div", "who");
      if (profile.avatar) { const av = el("img"); av.src = profile.avatar; av.alt = ""; who.appendChild(av); }
      who.appendChild(el("span", "", profile.name));
      copy.appendChild(who);
    }
    const inner = el("div", "copy-inner");
    const d = new Date(p.created_at);
    const date = el("div", "date");
    date.append(el("span", "day", dayFmt.format(d).replace(/\D/g, "")));
    const dm = el("span", "dmeta");
    dm.append(ymFmt.format(d), document.createElement("br"), wdFmt.format(d) + " · " + hmFmt.format(d));
    date.appendChild(dm);
    inner.appendChild(date);
    if (p.text) inner.appendChild(el("p", "text", p.text));
    copy.appendChild(inner);
    // 右下角很淡的进度：第几条 / 共几条，长文再加页码（参考 Apple 照片）
    copy.appendChild(el("div", "foot"));
    sl.appendChild(copy);
    return sl;
  }

  function updateFoot(sl) {
    const foot = sl.querySelector(".foot");
    if (!foot) return;
    const pages = sl._pages || [];
    foot.textContent = (sl._index + 1) + " / " + posts.length
      + (pages.length > 1 ? "　·　" + (sl._page + 1) + " / " + pages.length + " 页" : "");
  }

  // 从图片里取一个主色调，用来给文字区染一层很淡的同色（参考 Apple Music 播放页）
  const tintCanvas = document.createElement("canvas");
  tintCanvas.width = tintCanvas.height = 20;
  function tintFrom(img, sl) {
    try {
      const g = tintCanvas.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, 0, 0, 20, 20);
      const d = g.getImageData(0, 0, 20, 20).data;
      let r = 0, gg = 0, b = 0, w = 0;
      for (let k = 0; k < d.length; k += 4) {
        const mx = Math.max(d[k], d[k + 1], d[k + 2]), mn = Math.min(d[k], d[k + 1], d[k + 2]);
        const wt = 1 + (mx - mn) / 32; // 越鲜艳的像素权重越大，避免取成一片灰
        r += d[k] * wt; gg += d[k + 1] * wt; b += d[k + 2] * wt; w += wt;
      }
      sl.style.setProperty("--tint", `rgb(${Math.round(r / w)}, ${Math.round(gg / w)}, ${Math.round(b / w)})`);
    } catch { /* 图片还没加载或跨域时保持默认底色 */ }
  }

  // 排版：字号随文字长短自适应，从大往小试，放得下就停；
  // 缩到“舒适阅读的最小字号”仍放不下，就像 Apple Books 一样分页，而不是缩成小字再滚动
  function layoutText(sl) {
    const inner = sl.querySelector(".copy-inner");
    const textEl = sl.querySelector(".text");
    sl._pages = [];
    sl._page = 0;
    if (!inner || !textEl) { updateFoot(sl); return; }
    const full = sl._text;
    const fits = () => inner.scrollHeight <= inner.clientHeight + 1;
    const vmin = Math.min(innerWidth, innerHeight);
    const textOnly = sl.classList.contains("text-only");
    const lo = Math.max(16, Math.min(20, vmin * 0.042));
    const hi = Math.max(lo, Math.min(textOnly ? 46 : 34, vmin * (textOnly ? 0.065 : 0.05)));
    const readable = Math.max(lo, Math.round(hi * 0.7));

    textEl.textContent = full;
    for (let size = hi; size >= readable; size -= 1) {
      sl.style.setProperty("--fs", size + "px");
      if (fits()) { sl._pages = [full]; updateFoot(sl); return; }
    }

    // 分页：每页尽量装满，再退回到最近的句号/换行处断开
    sl.style.setProperty("--fs", readable + "px");
    const pages = [];
    let start = 0;
    while (start < full.length) {
      let a = start + 1, b = full.length, best = start + 1;
      while (a <= b) {
        const mid = (a + b) >> 1;
        textEl.textContent = full.slice(start, mid);
        if (fits()) { best = mid; a = mid + 1; } else { b = mid - 1; }
      }
      let end = best;
      if (end < full.length) {
        const seg = full.slice(start, end);
        const minCut = Math.floor(seg.length * 0.55);
        for (const marks of ["\n", "。！？!?…", "；;，,、：:"]) {
          let cut = -1;
          for (const m of marks) cut = Math.max(cut, seg.lastIndexOf(m));
          if (cut >= minCut) { end = start + cut + 1; break; }
        }
      }
      pages.push(full.slice(start, end).trim());
      start = end;
      while (start < full.length && /\s/.test(full[start])) start++;
    }
    sl._pages = pages.filter(Boolean);
    textEl.textContent = sl._pages[0] || "";
    updateFoot(sl);
  }

  function turnPage(sl, k) {
    const textEl = sl.querySelector(".text");
    sl._page = k;
    textEl.classList.add("turning");
    setTimeout(() => {
      textEl.textContent = sl._pages[k];
      textEl.classList.remove("turning");
      updateFoot(sl);
    }, 600);
  }

  let current = null;      // 当前显示的 .sl
  let slideToken = 0;      // 快速连按时只保留最后一次切换
  let photoIdx = 0;

  async function showSlide(i, fade = true) {
    if (!posts.length) return;
    if (i >= posts.length || i < 0) {
      if (applyPending()) renderFeed();
      i = (i + posts.length) % posts.length;
    }
    const token = ++slideToken;
    slideIndex = i;
    slideElapsed = 0;
    photoIdx = 0;
    progress.style.width = "0";

    const next = slideEl(posts[i]);
    next._index = i;
    next._text = posts[i].text || "";
    const n = (posts[i].images || []).length;
    // 等第一张图解码好再切换，避免淡入时闪一下空白
    const first = next.querySelector(".photo");
    if (first && first.decode) await Promise.race([first.decode().catch(() => {}), sleep(2500)]);
    if (token !== slideToken) return;
    if (first && first.complete) tintFrom(first, next);

    stage.appendChild(next);
    layoutText(next);
    slideDuration = durationFor(posts[i], next._pages);
    next.style.setProperty("--kb", (n ? slideDuration / n : slideDuration) + 2 + "s");
    document.body.classList.toggle("img-top", n > 0);
    const old = current;
    current = next;
    if (!fade) next.style.transition = "none";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      next.classList.add("in");
      if (!fade) requestAnimationFrame(() => { next.style.transition = ""; });
    }));
    if (old) {
      old.classList.add("out");
      setTimeout(() => old.remove(), fade ? 1300 : 0);
    }
    // 预加载下一条的图片
    const following = posts[(i + 1) % posts.length];
    for (const src of following.images || []) { const im = new Image(); im.src = src; }
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function slideStep(dt) {
    if (!current) return;
    slideElapsed += dt;
    const p = Math.min(1, slideElapsed / slideDuration);
    progress.style.width = p * 100 + "%";

    // 多张图：在停留时间里依次淡入切换
    const photos = current.querySelectorAll(".photo");
    if (photos.length > 1) {
      const k = Math.min(photos.length - 1, Math.floor(p * photos.length));
      if (k !== photoIdx) {
        photos[photoIdx].classList.remove("on");
        photos[k].classList.add("on");
        current.querySelector(".backdrop").src = photos[k].src;
        current.querySelector(".count").textContent = (k + 1) + " / " + photos.length;
        tintFrom(photos[k], current);
        photoIdx = k;
      }
    }

    // 长文分页：按停留时间平均翻页
    const pages = current._pages || [];
    if (pages.length > 1) {
      const k = Math.min(pages.length - 1, Math.floor(p * pages.length));
      if (k !== current._page) turnPage(current, k);
    }
    if (slideElapsed >= slideDuration) showSlide(slideIndex + 1);
  }

  function relayout() {
    if (!current) return;
    layoutText(current);
    slideDuration = durationFor(posts[slideIndex], current._pages);
  }
  window.addEventListener("resize", relayout);
  // 网页字体加载完后字宽会变，重新排一次
  if (document.fonts) document.fonts.ready.then(relayout);

  // ---------------------------------------------------------------- 主循环

  function frame(ts) {
    const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    if (playing && posts.length && !document.hidden) {
      if (settings.mode === "slides") slideStep(dt); else scrollStep(dt);
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- 控制栏显示/隐藏

  let hideTimer = 0;
  function showControls(autoHide = true) {
    controls.classList.remove("hide");
    document.body.style.cursor = "";
    if (autoHide) scheduleHide(); else clearTimeout(hideTimer);
  }
  function scheduleHide() {
    clearTimeout(hideTimer);
    if (!playing || sheetOpen) return;
    hideTimer = setTimeout(() => {
      controls.classList.add("hide");
      document.body.style.cursor = "none";
    }, HIDE_MS);
  }

  // ---------------------------------------------------------------- 设置面板

  const sheet = $("sheet");
  const settingsBtn = $("settingsBtn");
  let sheetOpen = false;
  function setSheet(open) {
    sheetOpen = open;
    sheet.hidden = !open;
    settingsBtn.setAttribute("aria-expanded", String(open));
    if (open) showControls(false); else scheduleHide();
  }

  // ---------------------------------------------------------------- 时钟与夜间模式（参考 iPhone 待机显示）

  const clockFmt = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const clockDateFmt = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" });
  let isNight = false;

  function tickClock() {
    const now = new Date();
    $("clockTime").textContent = clockFmt.format(now);
    $("clockDate").textContent = clockDateFmt.format(now);
    $("clock").hidden = !settings.clock;
    document.body.classList.toggle("has-clock", settings.clock);
    const h = now.getHours();
    const night = settings.night && (h >= 22 || h < 6);
    if (night !== isNight) {
      isNight = night;
      document.body.classList.toggle("is-night", night);
      if (current) slideDuration = durationFor(posts[slideIndex], current._pages);
    }
  }

  // ---------------------------------------------------------------- 防止熄屏

  let lock = null;
  async function wakeLock(on) {
    if (!("wakeLock" in navigator)) return;
    try {
      if (on && !lock) {
        lock = await navigator.wakeLock.request("screen");
        lock.addEventListener("release", () => { lock = null; });
      } else if (!on && lock) {
        await lock.release();
        lock = null;
      }
    } catch { lock = null; /* 省电模式等情况下会被拒绝，忽略 */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && playing) wakeLock(true);
    lastTs = 0;
  });

  // ---------------------------------------------------------------- 全屏 / 主题

  const fsEl = root;
  const canFs = !!(fsEl.requestFullscreen || fsEl.webkitRequestFullscreen);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (!canFs || standalone) $("fullscreen").hidden = true;

  function toggleFullscreen() {
    const cur = document.fullscreenElement || document.webkitFullscreenElement;
    if (cur) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen).call(fsEl);
  }
  const onFsChange = () => {
    $("fullscreen").textContent = (document.fullscreenElement || document.webkitFullscreenElement) ? "退出全屏" : "进入全屏";
  };
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);

  function applyTheme() {
    if (settings.theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
    for (const b of document.querySelectorAll("[data-theme-opt]")) {
      b.setAttribute("aria-pressed", String(b.dataset.themeOpt === settings.theme));
    }
  }

  // ---------------------------------------------------------------- 背景音乐
  //
  // 曲目清单在 music/playlist.txt：每行一项，可以是 music/ 文件夹里的音频文件名、
  // YouTube 视频或播放列表、B 站视频或收藏夹。音乐和滚动/幻灯片完全独立。
  // 来源可在设置里选：自动（先 YouTube，打不开时改用 B 站）/ YouTube / B 站。

  const music = {
    on: false,
    all: [],      // 清单里的全部条目
    bili: {},     // B 站收藏夹展开后的视频（部署时由 scripts/fetch_music.py 生成）
    tracks: [],   // 当前来源下实际要播放的曲目
    source: "yt", // 当前实际使用的来源
    ytFailed: false,
    biliTimer: 0,
    watchdog: 0,
    idx: 0,
    fails: 0,     // 连续播放失败的次数，全部失败时停下来，避免无限跳曲
    audio: null,  // 本地文件用 <audio>
    ctx: null,    // 通过 Web Audio 调音量：iPad 上 audio.volume 是只读的
    gain: null,
    attempt: 0,   // 每次切歌加一，同一次失败只处理一次（play() 报错和 error 事件会同时触发）
    yt: null,     // YouTube 播放器
    ytReady: false,
    current: null,
  };
  const musicBtn = $("music");
  const volume = $("volume");
  const ytBox = $("yt");
  const biliBox = $("bili");

  function parseYouTube(u) {
    try {
      const url = new URL(u);
      if (!/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(url.hostname)) return null;
      const list = url.searchParams.get("list");
      let id = url.searchParams.get("v");
      if (!id && url.hostname.endsWith("youtu.be")) id = url.pathname.slice(1);
      if (!id) { const m = url.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{6,})/); if (m) id = m[1]; }
      if (!id && !list) return null;
      // 同时带 v= 和 list= 时：先播整个列表，列表打不开再只播这一个视频
      return { type: "yt", id, list };
    } catch { return null; }
  }

  function parseBili(u) {
    try {
      const url = new URL(u);
      if (!/(^|\.)bilibili\.com$/.test(url.hostname)) return null;
      const ml = url.pathname.match(/\/(?:list|medialist\/(?:detail|play))\/ml(\d+)/);
      if (ml) return { type: "bililist", mlid: ml[1] };
      const fid = url.searchParams.get("fid");
      if (fid && /favlist/.test(url.pathname)) return { type: "bililist", mlid: fid };
      const bv = url.pathname.match(/\/video\/(BV\w+)/i);
      if (bv) return { type: "bili", bvid: bv[1] };
      return null;
    } catch { return null; }
  }

  function parsePlaylist(txt) {
    const out = [];
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      // 文件名里可以有空格：以音频扩展名为界，后面的是曲名
      const file = line.match(/^(.+?\.(?:mp3|m4a|aac|wav|ogg|oga|opus|flac|webm))(?:\s+(.*))?$/i);
      let [first, ...rest] = file ? [file[1], file[2] || ""] : line.split(/\s+/);
      const title = rest.join(" ").trim();
      // 允许省略 https://（例如直接粘贴 bilibili.com/list/ml123）
      if (/^(www\.|m\.)?(bilibili\.com|youtube\.com|youtu\.be)\//i.test(first)) first = "https://" + first;
      if (/^https?:/i.test(first)) {
        const item = parseYouTube(first) || parseBili(first);
        if (item) out.push({ ...item, title: title || (item.type === "yt" ? "YouTube" : "B 站") });
        else console.warn("只支持 YouTube、B 站链接或 music/ 里的文件：", first);
      } else {
        const name = first.replace(/^\.?\/?(docs\/)?(music\/)?/, "");
        out.push({ type: "file", src: "music/" + name.split("/").map(encodeURIComponent).join("/"), title: title || name });
      }
    }
    return out;
  }

  async function loadPlaylist() {
    try {
      const res = await fetch("music/playlist.txt", { cache: "no-cache" });
      if (res.ok) music.all = parsePlaylist(await res.text());
    } catch { /* 离线且没有缓存 */ }
    if (music.all.some((t) => t.type === "bililist")) {
      try {
        const res = await fetch("music/bilibili.json", { cache: "no-cache" });
        if (res.ok) music.bili = (await res.json()).lists || {};
      } catch { /* 还没生成或离线 */ }
    }
    if (music.all.some((t) => t.type === "yt")) loadYouTubeApi();
  }

  const ytTracks = () => music.all.filter((t) => t.type === "yt" || t.type === "file");
  function biliTracks() {
    const out = [];
    for (const t of music.all) {
      if (t.type === "file" || t.type === "bili") out.push(t);
      else if (t.type === "bililist") {
        for (const v of (music.bili[t.mlid] || {}).items || []) {
          out.push({ type: "bili", bvid: v.bvid, duration: v.duration, title: v.title || t.title });
        }
      }
    }
    return out;
  }

  // 按设置选来源；“自动”时 YouTube 可用就用 YouTube，否则用 B 站
  function chooseTracks() {
    const want = settings.musicSource || "auto";
    const yt = ytTracks(), bili = biliTracks();
    let src = want;
    if (want === "auto") {
      const ytUsable = yt.some((t) => t.type === "yt") && !music.ytFailed && navigator.onLine;
      src = ytUsable || !bili.length ? "yt" : "bili";
    }
    if (src !== music.source || music.tracks.length === 0) music.idx = 0;
    music.source = src;
    music.tracks = src === "yt" ? yt : bili;
  }

  // 提前加载 YouTube 播放器：iPad 要求“点按钮”的那一刻就开始播放，等脚本加载完再播会被拦截
  function loadYouTubeApi() {
    if (window.YT || document.getElementById("yt-api") || !navigator.onLine) return;
    window.onYouTubeIframeAPIReady = () => {
      music.yt = new YT.Player("ytPlayer", {
        width: "100%", height: "100%",
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, controls: 0, disablekb: 1, iv_load_policy: 3 },
        events: {
          onReady: () => { music.ytReady = true; applyVolume(); },
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.PLAYING) {
              music.fails = 0;
              clearTimeout(music.watchdog);
              const t = music.current;
              if (t && t.type === "yt" && t._mode === "list" && !t._listPlayed) {
                t._listPlayed = true;
                // 清单里只有这一个 YouTube 列表时，让列表自己从头循环，按顺序一直播下去
                try { music.yt.setLoop(music.tracks.length === 1); } catch { /* 旧版播放器 */ }
              }
            }
            if (e.data !== YT.PlayerState.ENDED || !music.on || music.current?.type !== "yt") return;
            // YouTube 播放列表：播完最后一首才切到清单里的下一项
            const list = music.current._mode === "list" && music.yt.getPlaylist && music.yt.getPlaylist();
            if (list && list.length && music.yt.getPlaylistIndex() < list.length - 1) return;
            nextTrack();
          },
          onError: () => {
            if (!music.on || music.current?.type !== "yt") return;
            const t = music.current;
            // 列表已经开始播了：只是其中某个视频放不了（禁止嵌入、已删除、地区限制），跳过它
            if (t._mode === "list" && t._listPlayed) {
              const list = music.yt.getPlaylist ? music.yt.getPlaylist() || [] : [];
              const i = music.yt.getPlaylistIndex ? music.yt.getPlaylistIndex() : -1;
              if (i >= 0 && i < list.length - 1) music.yt.nextVideo();
              else if (music.tracks.length === 1) music.yt.playVideoAt(0);
              else nextTrack();
              return;
            }
            ytFallback();
          },
        },
      });
    };
    const s = document.createElement("script");
    s.id = "yt-api";
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => { s.remove(); music.ytFailed = true; };
    document.head.appendChild(s);
  }

  function ensureAudio() {
    if (music.audio) return;
    const a = new Audio();
    a.preload = "auto";
    a.addEventListener("ended", () => { if (music.on) nextTrack(); });
    a.addEventListener("playing", () => { music.fails = 0; });
    a.addEventListener("error", () => { if (music.on && music.current?.type === "file") trackFailed(); });
    music.audio = a;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      try {
        music.ctx = new AC();
        music.gain = music.ctx.createGain();
        music.ctx.createMediaElementSource(a).connect(music.gain).connect(music.ctx.destination);
      } catch { music.ctx = music.gain = null; }
    }
  }

  function applyVolume() {
    const v = settings.volume;
    if (music.gain) music.gain.gain.value = (v / 100) ** 2; // 平方让滑块听感更均匀
    else if (music.audio) music.audio.volume = v / 100;
    if (music.ytReady) music.yt.setVolume(v); // iPad 上 YouTube 不允许网页调音量，只能用实体按键
  }

  function stopCurrent() {
    if (music.audio) music.audio.pause();
    if (music.ytReady) { try { music.yt.pauseVideo(); } catch { /* 播放器尚未就绪 */ } }
    ytBox.classList.add("off");
    clearTimeout(music.watchdog);
    clearTimeout(music.biliTimer);
    biliBox.replaceChildren();
    biliBox.classList.add("off");
  }

  // YouTube：列表打不开就只播链接里的那个视频；都不行才算失败
  function ytFallback() {
    const t = music.current;
    clearTimeout(music.watchdog);
    if (t && t._mode === "list" && t.id) {
      t._mode = "video";
      toast("YouTube 播放列表打不开（请检查链接里的列表 ID，以及列表是否公开），先只播放链接里的这一首");
      music.yt.loadVideoById(t.id);
      armWatchdog();
    } else {
      trackFailed();
    }
  }
  // 15 秒还没开始播放（比如列表 ID 无效、网络被拦）就当作失败
  function armWatchdog() {
    const attempt = music.attempt;
    clearTimeout(music.watchdog);
    music.watchdog = setTimeout(() => {
      if (attempt !== music.attempt || !music.on) return;
      const st = music.yt && music.yt.getPlayerState ? music.yt.getPlayerState() : -1;
      if (st !== 1 && st !== 3) ytFallback();
    }, 15000);
  }

  function playTrack(i) {
    const n = music.tracks.length;
    if (!n) return;
    music.idx = ((i % n) + n) % n;
    const t = music.tracks[music.idx];
    music.current = t;
    music.attempt += 1;
    stopCurrent();
    if (t.type === "file") {
      ensureAudio();
      if (music.ctx && music.ctx.state !== "running") music.ctx.resume();
      music.audio.src = t.src;
      applyVolume();
      music.audio.play().catch((err) => {
        if (err && err.name === "NotAllowedError") { setMusic(false); toast("浏览器拦截了播放，请再点一次音乐按钮"); }
        else trackFailed();
      });
    } else if (t.type === "bili") {
      // B 站没有网页播放接口：嵌入官方播放器，按视频时长切到下一首；音量请用设备按键
      if (!navigator.onLine) { trackFailed(); return; }
      const f = document.createElement("iframe");
      f.src = "https://player.bilibili.com/player.html?isOutside=true&autoplay=1&danmaku=0&high_quality=1&bvid=" + encodeURIComponent(t.bvid);
      f.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
      f.referrerPolicy = "no-referrer-when-downgrade";
      biliBox.replaceChildren(f);
      biliBox.classList.remove("off");
      const secs = t.duration > 0 ? t.duration + 3 : 300;
      music.biliTimer = setTimeout(() => { if (music.on) nextTrack(); }, secs * 1000);
      music.fails = 0;
    } else {
      if (!music.ytReady || !navigator.onLine) { trackFailed(); return; }
      ytBox.classList.remove("off");
      applyVolume();
      t._mode = t.list ? "list" : "video";
      t._listPlayed = false;
      if (t.list) music.yt.loadPlaylist({ list: t.list, listType: "playlist", index: 0 });
      else music.yt.loadVideoById(t.id);
      armWatchdog();
    }
    musicBtn.title = "正在播放：" + t.title;
    $("nowPlaying").textContent = t.title;
  }

  function nextTrack() { playTrack(music.idx + 1); }

  let failedAttempt = -1;
  function trackFailed() {
    if (failedAttempt === music.attempt) return;
    failedAttempt = music.attempt;
    music.fails += 1;
    if (music.fails >= music.tracks.length) {
      // 自动模式：YouTube 全部播不了（比如在内地打不开），改用 B 站
      if ((settings.musicSource || "auto") === "auto" && music.source === "yt" && biliTracks().length) {
        music.ytFailed = true;
        chooseTracks();
        music.fails = 0;
        toast("YouTube 无法播放，已改用 B 站");
        setTimeout(() => playTrack(0), 300);
        return;
      }
      setMusic(false);
      toast(!navigator.onLine
        ? "离线时只能播放 music/ 文件夹里的音频文件"
        : music.source === "yt" && biliTracks().length
          ? "YouTube 无法播放，可在设置里把音乐来源改成 B站"
          : "曲子都无法播放，请检查 music/playlist.txt");
      return;
    }
    setTimeout(nextTrack, 300);
  }

  function setMusic(on) {
    if (on) chooseTracks();
    if (on && !music.tracks.length) {
      toast(music.all.length
        ? (music.source === "bili" ? "B 站曲目还没准备好（收藏夹需要公开），请稍后再试" : "这个来源下没有曲子，请在设置里换一个来源")
        : "还没有曲子：请在 music/playlist.txt 里添加（见 README）");
      on = false;
    }
    music.on = on;
    musicBtn.setAttribute("aria-pressed", String(on));
    musicBtn.setAttribute("aria-label", on ? "背景音乐：开" : "背景音乐：关");
    $("musicToggle").checked = on;
    $("musicExtra").hidden = !on;
    if (!on) $("nowPlaying").textContent = "";
    if (on) { music.fails = 0; playTrack(music.idx); }
    else { stopCurrent(); musicBtn.title = ""; }
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
  }

  // ---------------------------------------------------------------- 事件

  for (const b of document.querySelectorAll("[data-mode]")) {
    b.addEventListener("click", () => setMode(b.dataset.mode));
  }
  playBtn.addEventListener("click", () => setPlaying(!playing));
  $("prev").addEventListener("click", () => showSlide(slideIndex - 1));
  $("next").addEventListener("click", () => showSlide(slideIndex + 1));
  $("fullscreen").addEventListener("click", toggleFullscreen);
  for (const b of document.querySelectorAll("[data-theme-opt]")) {
    b.addEventListener("click", () => { settings.theme = b.dataset.themeOpt; save(); applyTheme(); });
  }
  settingsBtn.addEventListener("click", () => setSheet(!sheetOpen));
  $("clockToggle").addEventListener("change", (e) => { settings.clock = e.target.checked; save(); tickClock(); relayout(); });
  $("nightToggle").addEventListener("change", (e) => { settings.night = e.target.checked; save(); tickClock(); });
  musicBtn.addEventListener("click", () => setMusic(!music.on));
  function applyMusicSource() {
    for (const b of document.querySelectorAll("[data-src]")) {
      b.setAttribute("aria-pressed", String(b.dataset.src === (settings.musicSource || "auto")));
    }
  }
  for (const b of document.querySelectorAll("[data-src]")) {
    b.addEventListener("click", () => {
      settings.musicSource = b.dataset.src;
      save();
      applyMusicSource();
      music.ytFailed = false; // 用户手动换来源时重新尝试
      if (music.on) { stopCurrent(); music.idx = 0; setMusic(true); }
    });
  }
  $("musicToggle").addEventListener("change", (e) => setMusic(e.target.checked));
  $("musicNext").addEventListener("click", () => { music.fails = 0; nextTrack(); });
  volume.addEventListener("input", () => {
    settings.volume = Number(volume.value);
    save();
    applyVolume();
  });

  speed.addEventListener("input", () => {
    const v = Number(speed.value);
    if (settings.mode === "slides") {
      settings.slideSpeed = v;
      if (current) slideDuration = durationFor(posts[slideIndex], current._pages);
    } else {
      settings.scrollSpeed = v;
    }
    save();
    syncSpeed();
  });

  controls.addEventListener("pointerdown", () => showControls(false));
  controls.addEventListener("pointerup", () => scheduleHide());
  document.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") showControls(); });
  document.addEventListener("click", (e) => {
    if (controls.contains(e.target) || sheet.contains(e.target)) return;
    if (sheetOpen) { setSheet(false); return; } // 点面板外面先关面板
    if (controls.classList.contains("hide")) showControls();
    else if (playing) { controls.classList.add("hide"); }
  });

  // 幻灯片左右滑动切换
  let touchX = null;
  slides.addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  slides.addEventListener("touchend", (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 60) showSlide(slideIndex + (dx < 0 ? 1 : -1));
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" && e.key !== " ") return;
    if (e.key === " ") { e.preventDefault(); setPlaying(!playing); }
    else if (e.key === "ArrowRight" && settings.mode === "slides") showSlide(slideIndex + 1);
    else if (e.key === "ArrowLeft" && settings.mode === "slides") showSlide(slideIndex - 1);
    else if (e.key === "f" || e.key === "F") toggleFullscreen();
    else if (e.key === "Escape" && sheetOpen) setSheet(false);
    else if (e.key === "m" || e.key === "M") setMusic(!music.on);
    else return;
    showControls();
  });

  // ---------------------------------------------------------------- 启动

  async function start() {
    applyTheme();
    $("clockToggle").checked = settings.clock;
    applyMusicSource();
    $("nightToggle").checked = settings.night;
    tickClock();
    setInterval(tickClock, 15000);
    volume.value = settings.volume;
    try { profile = await fetchProfile(); } catch { profile = null; }
    renderProfile();
    try {
      posts = await fetchPosts();
    } catch (err) {
      statusEl.textContent = "内容加载失败，请检查网络后刷新。";
      console.error(err);
    }
    if (posts.length) {
      statusEl.hidden = true;
      renderFeed();
    } else if (!statusEl.textContent.includes("失败")) {
      statusEl.textContent = "还没有内容，等待第一次抓取完成。";
    }
    setMode(settings.mode);
    setPlaying(true);
    showControls();
    requestAnimationFrame(frame);

    loadPlaylist();

    setInterval(refresh, REFRESH_MS);
    // 恢复联网、或者从后台切回来超过 10 分钟时，立刻拉一次新内容
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && Date.now() - lastRefresh > 10 * 60 * 1000) refresh();
    });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").then(() => cacheImagesInBackground()).catch(() => {});
    }
    // 请求浏览器不要在空间紧张时清掉离线缓存（不保证一定答应）
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  let lastRefresh = Date.now();
  async function refresh() {
    lastRefresh = Date.now();
    try {
      const fresh = await fetchPosts();
      if (fresh.length && (fresh.length !== posts.length || fresh[0].id !== posts[0]?.id)) {
        if (!posts.length) { posts = fresh; statusEl.hidden = true; renderFeed(); setMode(settings.mode); }
        else pending = fresh;
      }
      const prof = await fetchProfile().catch(() => null);
      if (prof && (!profile || prof.avatar !== profile.avatar || prof.name !== profile.name)) {
        profile = prof;
        renderProfile();
        pending = pending || posts.slice(); // 下一轮重新渲染卡片上的小头像
      }
      if (!music.on) loadPlaylist();
      cacheImagesInBackground(fresh);
    } catch { /* 离线时忽略 */ }
  }

  // 有网络时在后台把所有配图存进离线缓存，这样断网后也能看到还没滚动到的图片
  async function cacheImagesInBackground(list = posts) {
    if (!navigator.onLine || !("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    // 只预存最新的 200 条；更早的图片播放到时再下载并缓存，避免一次占用太多 iPad 空间
    const urls = list.slice(0, BG_CACHE_POSTS).flatMap((p) => p.images || []);
    if (profile && profile.avatar) urls.push(profile.avatar);
    if (reg.active && urls.length) reg.active.postMessage({ type: "cache-media", urls });
  }

  start();
})();
