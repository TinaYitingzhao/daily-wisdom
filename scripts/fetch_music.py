#!/usr/bin/env python3
"""读取 docs/music/playlist.txt 里的 B 站收藏夹，生成 docs/music/bilibili.json。

浏览器不能直接读 B 站接口（跨域限制），所以在部署网页时由 GitHub 的服务器读取，
把每个收藏夹里的视频（BV 号、标题、时长）写进 JSON，网页再按顺序播放。

收藏夹必须是“公开”的。读取失败只打印警告、不影响网页部署；
这时如果仓库里已有旧的 bilibili.json，会继续使用旧的。
"""

import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLAYLIST = ROOT / "docs" / "music" / "playlist.txt"
OUT = ROOT / "docs" / "music" / "bilibili.json"
API = "https://api.bilibili.com/x/v3/fav/resource/list?media_id={mid}&pn={pn}&ps=20&platform=web"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
MAX_PAGES = 50


def warn(msg):
    print(f"::warning::{msg}", flush=True)


def list_ids(text):
    ids = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = (re.search(r"bilibili\.com/list/ml(\d+)", line)
             or re.search(r"bilibili\.com/medialist/(?:detail|play)/ml(\d+)", line)
             or re.search(r"bilibili\.com/\d+/favlist\?[^ ]*fid=(\d+)", line))
        if m and m.group(1) not in ids:
            ids.append(m.group(1))
    return ids


def get(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": "https://www.bilibili.com/",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read())


def fetch_list(mid):
    items, title = [], ""
    for pn in range(1, MAX_PAGES + 1):
        data = get(API.format(mid=mid, pn=pn))
        if data.get("code") != 0:
            raise RuntimeError(f"接口返回 code={data.get('code')} {data.get('message', '')}"
                               "（收藏夹需要设为公开）")
        d = data.get("data") or {}
        title = title or (d.get("info") or {}).get("title", "")
        for m in d.get("medias") or []:
            if not m.get("bvid") or m.get("title") == "已失效视频":
                continue
            items.append({"bvid": m["bvid"], "title": m.get("title", ""), "duration": m.get("duration") or 0})
        if not d.get("has_more"):
            break
        time.sleep(0.5)
    return title, items


def main():
    if not PLAYLIST.exists():
        return 0
    ids = list_ids(PLAYLIST.read_text("utf-8"))
    if not ids:
        print("清单里没有 B 站收藏夹。")
        return 0
    old = json.loads(OUT.read_text("utf-8")) if OUT.exists() else {"lists": {}}
    lists = {}
    for mid in ids:
        try:
            title, items = fetch_list(mid)
            lists[mid] = {"title": title, "items": items}
            print(f"B 站收藏夹 ml{mid}「{title}」：{len(items)} 个视频")
        except (urllib.error.URLError, TimeoutError, ValueError, RuntimeError) as e:
            warn(f"读取 B 站收藏夹 ml{mid} 失败：{e}")
            if mid in old.get("lists", {}):
                lists[mid] = old["lists"][mid]
                warn(f"继续使用上次保存的 ml{mid} 列表")
    OUT.write_text(json.dumps({
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "lists": lists,
    }, ensure_ascii=False, indent=1) + "\n", "utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
