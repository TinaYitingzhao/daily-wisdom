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
import html
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
IMAGES_DIR = DOCS / "images"

API = "https://m.weibo.cn/api/container/getIndex"
LONGTEXT_API = "https://m.weibo.cn/statuses/extend?id={id}"
UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)
MAX_PAGES = 40  # 安全上限，防止无限翻页
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

def download_image(url, dest):
    if dest.exists() and dest.stat().st_size > 0:
        return
    data = http_get(url, None, referer=IMG_REFERER, accept="image/*")
    if len(data) < 100:
        raise FetchError(f"图片内容异常（{len(data)} 字节）：{url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(data)
    tmp.replace(dest)


def ext_of(url):
    m = re.search(r"\.(jpe?g|png|gif|webp)(?:\?|$)", url, re.I)
    return "." + (m.group(1).lower().replace("jpeg", "jpg") if m else "jpg")


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


def run(cookie, initial):
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    posts = load_posts()
    known = {p["id"] for p in posts}
    first_run = not posts
    target = initial if first_run else None
    log(f"已有 {len(posts)} 条。{'首次运行，目标约 ' + str(initial) + ' 条' if first_run else '增量更新'}")

    containerid = f"107603{UID}"
    since_id = None
    new_posts, errors = [], []
    seen_this_run = set()
    fails_in_a_row = 0

    for page in range(1, MAX_PAGES + 1):
        url = f"{API}?type=uid&value={UID}&containerid={containerid}"
        if since_id:
            url += f"&since_id={since_id}"
        data = get_json(url, cookie)
        check_ok(data)
        cards = data.get("data", {}).get("cards") or []
        mblogs = [c["mblog"] for c in cards if c.get("card_type") == 9 and c.get("mblog")]
        if page == 1 and not mblogs:
            raise FetchError("第一页没有任何微博，接口结构可能变化或被限制。")

        page_new = 0
        for mblog in mblogs:
            mid = str(mblog.get("id"))
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
        if target is not None:
            # 按“处理过的条数”计，失败的也算，避免图片全失败时一直往后翻页
            if len(seen_this_run) >= target:
                break
        elif unpinned and page_new == 0:
            # 增量模式：这一页全是已经抓过的，说明后面也都抓过了
            break

        since_id = data.get("data", {}).get("cardlistInfo", {}).get("since_id")
        if not since_id:
            break
        time.sleep(random.uniform(2, 4))

    log(f"本次新增 {len(new_posts)} 条，共 {len(posts) + len(new_posts)} 条。")
    if errors:
        shown = "\n".join(errors[:20]) + (f"\n……另外 {len(errors) - 20} 条省略" if len(errors) > 20 else "")
        raise FetchError(f"{len(errors)} 条微博保存失败（下次运行会自动重试）：\n" + shown)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--initial", type=int, default=100, help="首次运行抓取的条数（默认 100）")
    args = ap.parse_args()

    cookie = os.environ.get("WEIBO_COOKIE", "").strip()
    if not cookie:
        log("::error::没有找到 WEIBO_COOKIE。请在仓库 Settings → Secrets and variables → Actions 里添加。")
        return 1
    try:
        run(cookie, args.initial)
    except FetchError as e:
        for line in str(e).splitlines():
            log(f"::error::{line}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
