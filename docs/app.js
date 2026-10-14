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
    { mode: "scroll", scrollSpeed: 3, slideSpeed: 5, theme: "auto", volume: 60 },
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

  // ---------------------------------------------------------------- 背景音乐
  //
  // 曲目清单在 music/playlist.txt：每行一首，可以是 music/ 文件夹里的音频文件名，
  // 也可以是 YouTube 链接。音乐和滚动/幻灯片完全独立，暂停播放不影响音乐。

  const music = {
    on: false,
    tracks: [],
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

  function parseYouTube(u) {
    try {
      const url = new URL(u);
      if (!/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(url.hostname)) return null;
      const list = url.searchParams.get("list");
      let id = url.searchParams.get("v");
      if (!id && url.hostname.endsWith("youtu.be")) id = url.pathname.slice(1);
      if (!id) { const m = url.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{6,})/); if (m) id = m[1]; }
      if (!id && !list) return null;
      // 带 v= 的链接（即使后面跟着 &list=）按单个视频播放；只有纯播放列表链接才整列播放
      return { type: "yt", id, list: id ? null : list };
    } catch { return null; }
  }

  function parsePlaylist(txt) {
    const out = [];
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      // 文件名里可以有空格：以音频扩展名为界，后面的是曲名
      const file = line.match(/^(.+?\.(?:mp3|m4a|aac|wav|ogg|oga|opus|flac|webm))(?:\s+(.*))?$/i);
      const [first, ...rest] = file ? [file[1], file[2] || ""] : line.split(/\s+/);
      const title = rest.join(" ").trim();
      if (/^https?:/i.test(first)) {
        const yt = parseYouTube(first);
        if (yt) out.push({ ...yt, title: title || "YouTube" });
        else console.warn("只支持 YouTube 链接或 music/ 里的文件：", first);
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
      if (res.ok) music.tracks = parsePlaylist(await res.text());
    } catch { /* 离线且没有缓存 */ }
    if (music.idx >= music.tracks.length) music.idx = 0;
    if (music.tracks.some((t) => t.type === "yt")) loadYouTubeApi();
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
            if (e.data === YT.PlayerState.PLAYING) music.fails = 0;
            if (e.data !== YT.PlayerState.ENDED || !music.on || music.current?.type !== "yt") return;
            // YouTube 播放列表：播完最后一首才切到清单里的下一项
            const list = music.yt.getPlaylist && music.yt.getPlaylist();
            if (list && list.length && music.yt.getPlaylistIndex() < list.length - 1) return;
            nextTrack();
          },
          onError: () => { if (music.on && music.current?.type === "yt") trackFailed(); },
        },
      });
    };
    const s = document.createElement("script");
    s.id = "yt-api";
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => s.remove();
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
    } else {
      if (!music.ytReady || !navigator.onLine) { trackFailed(); return; }
      ytBox.classList.remove("off");
      applyVolume();
      if (t.list) music.yt.loadPlaylist({ list: t.list, listType: "playlist", index: 0 });
      else music.yt.loadVideoById(t.id);
    }
    musicBtn.title = "正在播放：" + t.title;
  }

  function nextTrack() { playTrack(music.idx + 1); }

  let failedAttempt = -1;
  function trackFailed() {
    if (failedAttempt === music.attempt) return;
    failedAttempt = music.attempt;
    music.fails += 1;
    if (music.fails >= music.tracks.length) {
      setMusic(false);
      toast(navigator.onLine
        ? "曲子都无法播放，请检查 music/playlist.txt"
        : "离线时只能播放 music/ 文件夹里的音频文件");
      return;
    }
    setTimeout(nextTrack, 300);
  }

  function setMusic(on) {
    if (on && !music.tracks.length) {
      toast("还没有曲子：请在 music/playlist.txt 里添加（见 README）");
      on = false;
    }
    music.on = on;
    musicBtn.setAttribute("aria-pressed", String(on));
    musicBtn.setAttribute("aria-label", on ? "背景音乐：开" : "背景音乐：关");
    $("musicExtra").hidden = !on;
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
  $("theme").addEventListener("click", () => {
    settings.theme = THEMES[(THEMES.indexOf(settings.theme) + 1) % THEMES.length];
    save();
    applyTheme();
  });
  musicBtn.addEventListener("click", () => setMusic(!music.on));
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
    else if (e.key === "m" || e.key === "M") setMusic(!music.on);
    else return;
    showControls();
  });

  // ---------------------------------------------------------------- 启动

  async function start() {
    applyTheme();
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
    const urls = list.flatMap((p) => p.images || []);
    if (profile && profile.avatar) urls.push(profile.avatar);
    if (reg.active && urls.length) reg.active.postMessage({ type: "cache-media", urls });
  }

  start();
})();
