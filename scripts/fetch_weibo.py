#!/usr/bin/env python3
"""抓取指定微博账号的公开微博，保存文字和原图到 docs/ 目录。

只用 Python 标准库，GitHub Actions 里不需要安装依赖。

用法:
    WEIBO_COOKIE='...' python3 scripts/fetch_weibo.py [--initial 100]

退出码:
    0  成功（包括“没有新内容”）
    1  出错（cookie 失效、接口异常、图片下载失败等），错误信息会打印在日志里
"""

import argparse
import hashlib
import html
import io
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path

UID = "1769787285"  # 索达吉堪布
ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
POSTS_FILE = DOCS / "data" / "posts.json"
PROFILE_FILE = DOCS / "data" / "profile.json"
IMAGES_DIR = DOCS / "images"

API = "https://m.weibo.cn/api/container/getIndex"
LONGTEXT_API = "https://m.weibo.cn/statuses/extend?id={id}"
UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)
MAX_PAGES = 40  # 安全上限，防止无限翻页
BACKFILL_MAX_PAGES = 1000  # 补抓历史时要从最新一路翻到很早，上限放宽
MAX_SIDE = 1800  # 新下载的照片长边超过这个像素就缩小（iPad 全屏看不出区别，能省一半以上空间）
JPEG_QUALITY = 85
IMG_REFERER = "https://weibo.com/"  # 图床防盗链只认 weibo.com，m.weibo.cn 会被 403
MAX_IMG_FAILS_IN_A_ROW = 5  # 连续这么多张图失败就整体中止，避免大量无效请求


class FetchError(Exception):
    """需要让 Action 失败的错误。"""


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------- HTTP

def http_get(url, cookie, referer, accept="application/json", retries=3):
    headers = {
        "User-Agent": UA,
        "Referer": referer,
        "Accept": accept,
    }
    if cookie:
        headers["Cookie"] = cookie
    if accept == "application/json":
        headers["X-Requested-With"] = "XMLHttpRequest"
        headers["MWeibo-Pwa"] = "1"
    last = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code in (403, 418, 432):  # 被风控，重试意义不大
                break
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = str(e)
        time.sleep(2 * attempt)
    raise FetchError(f"请求失败（{last}）：{url}")


def get_json(url, cookie):
    raw = http_get(url, cookie, referer=f"https://m.weibo.cn/u/{UID}")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        snippet = raw[:200].decode("utf-8", "replace")
        raise FetchError(f"接口没有返回 JSON，可能被风控或 cookie 失效。返回开头：{snippet}")


def check_ok(data):
    ok = data.get("ok")
    if ok == 1:
        return
    if ok == -100:
        raise FetchError(
            "微博要求登录：WEIBO_COOKIE 无效或已过期。请按 README 的步骤重新获取 cookie 并更新 GitHub Secret。"
        )
    raise FetchError(f"微博接口返回异常：{json.dumps(data, ensure_ascii=False)[:300]}")


# ---------------------------------------------------------------- 正文处理

class _TextExtractor(HTMLParser):
    """把微博正文 HTML 转成纯文本：<br> 变换行，表情图片取 alt，链接保留文字。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "br":
            self.parts.append("\n")
        elif tag == "img":
            alt = dict(attrs).get("alt")
            if alt:
                self.parts.append(alt)

    def handle_data(self, data):
        self.parts.append(data)


def html_to_text(s):
    p = _TextExtractor()
    p.feed(s or "")
    p.close()
    text = html.unescape("".join(p.parts))
    text = text.replace("​", "")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    # 去掉“网页链接”“查看图片”这类无意义尾巴
    text = re.sub(r"\s*(网页链接|查看图片|全文|\S{1,20}的微博视频)\s*$", "", text.strip())
    return text.strip()


def parse_time(s):
    # 例：Sat Oct 10 08:00:00 +0800 2026
    return datetime.strptime(s, "%a %b %d %H:%M:%S %z %Y").isoformat()


def full_text(mblog, cookie):
    if not mblog.get("isLongText"):
        return mblog.get("text", "")
    try:
        data = get_json(LONGTEXT_API.format(id=mblog["id"]), cookie)
        if data.get("ok") == 1 and data.get("data", {}).get("longTextContent"):
            return data["data"]["longTextContent"]
    except FetchError as e:
        log(f"  ! 长文获取失败，使用摘要：{e}")
    return mblog.get("text", "")


def pic_urls(mblog):
    urls = []
    for pic in mblog.get("pics") or []:
        large = pic.get("large") or {}
        url = large.get("url") or pic.get("url")
        if url:
            urls.append(url)
    # 视频微博没有配图，保存视频封面
    page = mblog.get("page_info") or {}
    if not urls and page.get("type") == "video":
        cover = (page.get("page_pic") or {}).get("url")
        if cover:
            urls.append(cover)
    return urls


# ---------------------------------------------------------------- 图片

def shrink(data):
    """长边超过 MAX_SIDE 或文件较大的 JPEG 重新压缩；GIF/PNG 和没装 Pillow 时原样返回。"""
    try:
        from PIL import Image
    except ImportError:
        return data
    try:
        im = Image.open(io.BytesIO(data))
        if im.format != "JPEG" or (max(im.size) <= MAX_SIDE and len(data) <= 400_000):
            return data
        im = im.convert("RGB")
        im.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
        out = io.BytesIO()
        im.save(out, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
        return out.getvalue() if out.tell() < len(data) else data
    except Exception:  # 图片异常时保留原文件，不影响抓取
        return data


def download_image(url, dest):
    if dest.exists() and dest.stat().st_size > 0:
        return
    data = http_get(url, None, referer=IMG_REFERER, accept="image/*")
    if len(data) < 100:
        raise FetchError(f"图片内容异常（{len(data)} 字节）：{url}")
    data = shrink(data)
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(data)
    tmp.replace(dest)


def ext_of(url):
    m = re.search(r"\.(jpe?g|png|gif|webp)(?:\?|$)", url, re.I)
    return "." + (m.group(1).lower().replace("jpeg", "jpg") if m else "jpg")


# ---------------------------------------------------------------- 头像与昵称

def find_user(mblogs, cookie):
    """优先用微博自带的作者信息；拿不到再单独请求一次用户资料。"""
    for m in mblogs:
        u = m.get("user") or {}
        if str(u.get("id")) == UID and (u.get("avatar_hd") or u.get("profile_image_url")):
            return u
    data = get_json(f"{API}?type=uid&value={UID}", cookie)
    check_ok(data)
    u = data.get("data", {}).get("userInfo") or {}
    if not (u.get("avatar_hd") or u.get("profile_image_url")):
        raise FetchError("没有拿到账号的头像信息，接口结构可能变化。")
    return u


def update_profile(user):
    """下载头像，和上次保存的比较；头像或昵称变了才写文件，避免每天产生无意义的提交。

    头像文件名带内容哈希，换头像后浏览器和离线缓存会拿到新文件，而不是继续显示旧图。
    """
    url = user.get("avatar_hd") or user.get("profile_image_url")
    name = user.get("screen_name") or ""
    data = http_get(url, None, referer=IMG_REFERER, accept="image/*")
    if len(data) < 100:
        raise FetchError(f"头像内容异常（{len(data)} 字节）：{url}")
    digest = hashlib.sha1(data).hexdigest()[:10]
    filename = f"avatar_{digest}{ext_of(url)}"

    old = json.loads(PROFILE_FILE.read_text("utf-8")) if PROFILE_FILE.exists() else {}
    if old.get("avatar") == f"images/{filename}" and old.get("name") == name:
        log("头像和昵称没有变化。")
        return

    (IMAGES_DIR / filename).write_bytes(data)
    for f in IMAGES_DIR.glob("avatar_*"):
        if f.name != filename:
            f.unlink()
    profile = {
        "name": name,
        "avatar": f"images/{filename}",
        "url": f"https://m.weibo.cn/u/{UID}",
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    PROFILE_FILE.parent.mkdir(parents=True, exist_ok=True)
    PROFILE_FILE.write_text(json.dumps(profile, ensure_ascii=False, indent=1) + "\n", "utf-8")
    log(f"{'更新' if old else '保存'}了头像和昵称：{name}")


# ---------------------------------------------------------------- 主流程

def build_post(mblog, cookie):
    """把一条 mblog 转成要保存的结构，并下载图片。图片失败会抛 FetchError。"""
    mid = str(mblog["id"])
    text = html_to_text(full_text(mblog, cookie))
    urls = pic_urls(mblog)

    rt = mblog.get("retweeted_status")
    if rt:
        rt_user = (rt.get("user") or {}).get("screen_name", "")
        rt_text = html_to_text(full_text(rt, cookie)) if rt.get("id") else ""
        if rt_text:
            text = f"{text}\n\n【转发 @{rt_user}】{rt_text}" if rt_user else f"{text}\n\n【转发】{rt_text}"
        urls += pic_urls(rt)

    images = []
    for i, url in enumerate(urls, 1):
        name = f"{mid}_{i}{ext_of(url)}"
        download_image(url, IMAGES_DIR / name)
        images.append(f"images/{name}")
        time.sleep(0.3)

    return {
        "id": mid,
        "created_at": parse_time(mblog["created_at"]),
        "text": text,
        "images": images,
        "url": f"https://m.weibo.cn/detail/{mid}",
    }


def is_pinned(mblog):
    title = (mblog.get("title") or {}).get("text", "")
    return bool(mblog.get("isTop")) or "置顶" in title


def load_posts():
    if POSTS_FILE.exists():
        return json.loads(POSTS_FILE.read_text("utf-8"))
    return []


def save_posts(posts):
    posts.sort(key=lambda p: p["created_at"], reverse=True)
    POSTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = POSTS_FILE.with_suffix(".json.part")
    tmp.write_text(json.dumps(posts, ensure_ascii=False, indent=1) + "\n", "utf-8")
    tmp.replace(POSTS_FILE)


def run(cookie, initial, backfill_until=None, max_new=300):
    """backfill_until：补抓历史模式，从最新一路往回翻，补齐这个日期之后所有还没保存的微博，
    每次最多新增 max_new 条（分几次跑，会自动接着上次的进度）。"""
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    posts = load_posts()
    known = {p["id"] for p in posts}
    first_run = not posts
    backfill = backfill_until is not None
    target = max_new if backfill else (initial if first_run else None)
    if backfill:
        log(f"已有 {len(posts)} 条。补抓 {backfill_until} 之后的历史微博，本次最多新增 {max_new} 条")
    else:
        log(f"已有 {len(posts)} 条。{'首次运行，目标约 ' + str(initial) + ' 条' if first_run else '增量更新'}")
    oldest_seen = None
    reached_end = False

    containerid = f"107603{UID}"
    since_id = None
    new_posts, errors = [], []
    seen_this_run = set()
    fails_in_a_row = 0

    for page in range(1, (BACKFILL_MAX_PAGES if backfill else MAX_PAGES) + 1):
        url = f"{API}?type=uid&value={UID}&containerid={containerid}"
        if since_id:
            url += f"&since_id={since_id}"
        data = get_json(url, cookie)
        check_ok(data)
        cards = data.get("data", {}).get("cards") or []
        mblogs = [c["mblog"] for c in cards if c.get("card_type") == 9 and c.get("mblog")]
        if page == 1 and not mblogs:
            raise FetchError("第一页没有任何微博，接口结构可能变化或被限制。")
        if page == 1:
            try:
                update_profile(find_user(mblogs, cookie))
            except FetchError as e:
                errors.append(f"头像：{e}")
                log(f"  ✗ 头像更新失败：{e}")

        page_new = 0
        for mblog in mblogs:
            mid = str(mblog.get("id"))
            if not is_pinned(mblog):
                try:
                    t = parse_time(mblog["created_at"])
                    oldest_seen = min(oldest_seen or t, t)
                except (KeyError, ValueError):
                    t = None
                if backfill and t and t[:10] < backfill_until:
                    continue
            if mid in known or mid in seen_this_run:
                continue
            seen_this_run.add(mid)
            try:
                post = build_post(mblog, cookie)
            except (FetchError, KeyError, ValueError) as e:
                errors.append(f"微博 {mid}：{e}")
                log(f"  ✗ {mid} 保存失败：{e}")
                fails_in_a_row += 1
                if fails_in_a_row >= MAX_IMG_FAILS_IN_A_ROW:
                    if new_posts:
                        save_posts(posts + new_posts)
                    raise FetchError(
                        f"连续 {fails_in_a_row} 条微博保存失败，已中止（可能是图床防盗链或网络问题）。"
                        f"最后一个错误：{e}"
                    )
                continue
            if post["images"]:  # 只有真正下载成功过图片才清零
                fails_in_a_row = 0
            new_posts.append(post)
            if not is_pinned(mblog):
                page_new += 1
            log(f"  ✓ {post['created_at'][:16]}  {len(post['images'])} 张图  {post['text'][:30]!r}")

        # 存盘，中途失败也不会丢掉已下载的内容
        if new_posts:
            save_posts(posts + new_posts)

        unpinned = [m for m in mblogs if not is_pinned(m)]
        if backfill:
            if len(seen_this_run) >= target:
                log(f"本次已新增到上限 {target} 条，剩下的请再运行一次（会接着往下补）。")
                break
            if oldest_seen and oldest_seen[:10] < backfill_until:
                reached_end = True
                break
            if page % 20 == 0:
                log(f"  …已翻到 {oldest_seen[:10] if oldest_seen else '?'}")
        elif target is not None:
            # 按“处理过的条数”计，失败的也算，避免图片全失败时一直往后翻页
            if len(seen_this_run) >= target:
                break
        elif unpinned and page_new == 0:
            # 增量模式：这一页全是已经抓过的，说明后面也都抓过了
            break

        since_id = data.get("data", {}).get("cardlistInfo", {}).get("since_id")
        if not since_id:
            reached_end = True
            break
        time.sleep(random.uniform(1.5, 3) if backfill and page_new == 0 else random.uniform(2, 4))

    log(f"本次新增 {len(new_posts)} 条，共 {len(posts) + len(new_posts)} 条。")
    if backfill:
        log(f"这次最远翻到：{oldest_seen[:10] if oldest_seen else '未知'}")
        if reached_end:
            log(f"历史补抓已完成：{backfill_until} 之后能翻到的微博都已保存"
                + ("" if oldest_seen and oldest_seen[:10] < backfill_until else
                   f"（微博只能往回翻到 {oldest_seen[:10] if oldest_seen else '未知'}）"))
    if errors:
        shown = "\n".join(errors[:20]) + (f"\n……另外 {len(errors) - 20} 条省略" if len(errors) > 20 else "")
        raise FetchError(f"{len(errors)} 条微博保存失败（下次运行会自动重试）：\n" + shown)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--initial", type=int, default=100, help="首次运行抓取的条数（默认 100）")
    ap.add_argument("--backfill-until", metavar="YYYY-MM-DD", help="补抓这个日期之后的历史微博")
    ap.add_argument("--max-new", type=int, default=300, help="补抓模式每次最多新增的条数（默认 300）")
    args = ap.parse_args()
    if args.backfill_until and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.backfill_until):
        log("::error::--backfill-until 的格式应为 YYYY-MM-DD，例如 2014-01-01")
        return 1

    cookie = os.environ.get("WEIBO_COOKIE", "").strip()
    if not cookie:
        log("::error::没有找到 WEIBO_COOKIE。请在仓库 Settings → Secrets and variables → Actions 里添加。")
        return 1
    try:
        run(cookie, args.initial, args.backfill_until, args.max_new)
    except FetchError as e:
        for line in str(e).splitlines():
            log(f"::error::{line}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
