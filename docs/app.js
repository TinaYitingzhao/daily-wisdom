(() => {
  "use strict";

  // 速度 1–10 档。滚动模式：像素/秒；幻灯片模式：每条停留秒数（长文会自动延长）
  const SCROLL_PX = [6, 9, 12, 16, 21, 27, 35, 45, 58, 75];
  const SLIDE_SEC = [60, 45, 35, 28, 22, 17, 13, 10, 8, 6];
  const REFRESH_MS = 60 * 60 * 1000;
  const HIDE_MS = 3500;
  const svg = (d) => '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">' + d + "</svg>";
  const ICON_PAUSE = svg('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>');
  const ICON_PLAY = svg('<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>');

  const $ = (id) => document.getElementById(id);
  const feed = $("feed");
  const slides = $("slides");
  const slide = $("slide");
  const progress = $("progress");
  const statusEl = $("status");
  const controls = $("controls");
  const playBtn = $("play");
  const speed = $("speed");
  const speedValue = $("speedValue");
  const root = document.documentElement;

  // ---------------------------------------------------------------- 设置

  const settings = Object.assign(
    { mode: "scroll", scrollSpeed: 3, slideSpeed: 5, theme: "auto" },
    load()
  );

  function load() {
    try { return JSON.parse(localStorage.getItem("dw-settings")) || {}; } catch { return {}; }
  }
  function save() {
    try { localStorage.setItem("dw-settings", JSON.stringify(settings)); } catch { /* 隐私模式 */ }
  }

  // ---------------------------------------------------------------- 数据

  let posts = [];
  let pending = null; // 后台刷新得到的新数据，在下一轮开始时替换

  async function fetchPosts() {
    const res = await fetch("data/posts.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const list = await res.json();
    return list.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });

  function postEl(p, eager) {
    const art = document.createElement("article");
    art.className = "post";

    const t = document.createElement("time");
    t.dateTime = p.created_at;
    t.textContent = fmt.format(new Date(p.created_at));
    art.appendChild(t);

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

  function durationFor(p) {
    const base = SLIDE_SEC[settings.slideSpeed - 1];
    const chars = (p.text || "").length;
    const factor = Math.min(3, Math.max(1, chars / 140));
    return base * factor + Math.min(2, (p.images || []).length) * base * 0.15;
  }

  function showSlide(i, fade = true) {
    if (!posts.length) return;
    if (i >= posts.length || i < 0) {
      if (applyPending()) renderFeed();
      i = (i + posts.length) % posts.length;
    }
    slideIndex = i;
    slideElapsed = 0;
    slideDuration = durationFor(posts[i]);
    const swap = () => {
      slide.replaceChildren(postEl(posts[i], true));
      slide.scrollTop = 0;
      slide.classList.remove("fading");
      // 预加载下一条的图片
      const n = posts[(i + 1) % posts.length];
      for (const src of n.images || []) { const im = new Image(); im.src = src; }
    };
    if (fade) {
      slide.classList.add("fading");
      setTimeout(swap, 900);
    } else {
      swap();
    }
  }

  function slideStep(dt) {
    slideElapsed += dt;
    const p = Math.min(1, slideElapsed / slideDuration);
    progress.style.width = p * 100 + "%";
    // 内容超出一屏时，在停留时间里缓慢滚完（开头和结尾各停一会）
    const over = slide.scrollHeight - slide.clientHeight;
    if (over > 4) {
      const q = Math.min(1, Math.max(0, (p - 0.15) / 0.7));
      slide.scrollTop = q * over;
    }
    if (slideElapsed >= slideDuration) showSlide(slideIndex + 1);
  }

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
    if (!playing) return;
    hideTimer = setTimeout(() => {
      controls.classList.add("hide");
      document.body.style.cursor = "none";
    }, HIDE_MS);
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

  const THEMES = ["auto", "light", "dark"];
  const THEME_LABEL = { auto: "跟随系统", light: "浅色", dark: "深色" };
  function applyTheme() {
    if (settings.theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
    $("theme").setAttribute("aria-label", "配色：" + THEME_LABEL[settings.theme]);
    $("theme").title = "配色：" + THEME_LABEL[settings.theme];
  }

  // ---------------------------------------------------------------- 事件

  for (const b of document.querySelectorAll("[data-mode]")) {
    b.addEventListener("click", () => setMode(b.dataset.mode));
  }
  playBtn.addEventListener("click", () => setPlaying(!playing));
  $("prev").addEventListener("click", () => showSlide(slideIndex - 1));
  $("next").addEventListener("click", () => showSlide(slideIndex + 1));
  $("fullscreen").addEventListener("click", toggleFullscreen);
  $("theme").addEventListener("click", () => {
    settings.theme = THEMES[(THEMES.indexOf(settings.theme) + 1) % THEMES.length];
    save();
    applyTheme();
  });
  speed.addEventListener("input", () => {
    const v = Number(speed.value);
    if (settings.mode === "slides") {
      settings.slideSpeed = v;
      slideDuration = durationFor(posts[slideIndex] || {});
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
    if (controls.contains(e.target)) return;
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
    else return;
    showControls();
  });

  // ---------------------------------------------------------------- 启动

  async function start() {
    applyTheme();
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

    setInterval(async () => {
      try {
        const fresh = await fetchPosts();
        if (fresh.length && (fresh.length !== posts.length || fresh[0].id !== posts[0]?.id)) {
          if (!posts.length) { posts = fresh; statusEl.hidden = true; renderFeed(); setMode(settings.mode); }
          else pending = fresh;
        }
      } catch { /* 离线时忽略 */ }
    }, REFRESH_MS);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  start();
})();
