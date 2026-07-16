#!/usr/bin/env python3
import argparse
import hashlib
import io
import json
import os
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "public" / "static" / "covers-thumbs"
MANIFEST_PATH = OUT_DIR / "manifest.json"


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=20) as res:
        return json.loads(res.read().decode("utf-8"))


def collect_urls(api_url):
    page = 1
    urls = []
    seen = set()
    while True:
        sep = "&" if "?" in api_url else "?"
        payload = fetch_json(f"{api_url}{sep}limit=96&page={page}")
        if not payload.get("ok"):
            raise RuntimeError(f"API returned ok=false on page {page}")
        for item in payload.get("items", []):
            url = item.get("preview_image_url")
            if url and url not in seen:
                seen.add(url)
                urls.append(url)
        if not payload.get("has_more"):
            break
        page += 1
    return urls


def thumb_name(url):
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:24]
    return f"{digest}.jpg"


def download(url):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "PromptVaultThumbGenerator/1.0",
            "Accept": "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=45) as res:
        return res.read()


def save_thumb(raw, out_path, width, quality):
    with Image.open(io.BytesIO(raw)) as img:
        img.seek(0)
        img = ImageOps.exif_transpose(img)
        img.thumbnail((width, width), Image.Resampling.LANCZOS)
        if img.mode in ("RGBA", "LA", "P"):
            base = Image.new("RGB", img.size, (12, 12, 16))
            if img.mode == "P":
                img = img.convert("RGBA")
            base.paste(img, mask=img.getchannel("A") if img.mode in ("RGBA", "LA") else None)
            img = base
        else:
            img = img.convert("RGB")
        img.save(out_path, "JPEG", quality=quality, optimize=True, progressive=True)


def main():
    parser = argparse.ArgumentParser(description="Generate static thumbnails for prompt card covers.")
    parser.add_argument("--api", default=os.environ.get("PROMPT_VAULT_API", "http://localhost:3131/api/prompts"))
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--quality", type=int, default=72)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {}
    if MANIFEST_PATH.exists():
        manifest = json.loads(MANIFEST_PATH.read_text("utf-8"))

    urls = collect_urls(args.api)
    print(f"found {len(urls)} preview image urls")
    ok = 0
    failed = 0
    for index, url in enumerate(urls, 1):
        name = thumb_name(url)
        rel = f"/static/covers-thumbs/{name}"
        out_path = OUT_DIR / name
        if out_path.exists() and not args.force:
            manifest[url] = rel
            ok += 1
            continue
        try:
            raw = download(url)
            save_thumb(raw, out_path, args.width, args.quality)
            manifest[url] = rel
            ok += 1
            print(f"[{index}/{len(urls)}] ok {name} {out_path.stat().st_size // 1024}KB")
        except Exception as err:
            failed += 1
            print(f"[{index}/{len(urls)}] fail {url}: {err}", file=sys.stderr)

    ordered = {k: manifest[k] for k in sorted(manifest)}
    MANIFEST_PATH.write_text(json.dumps(ordered, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(f"done: {ok} ok, {failed} failed, manifest={MANIFEST_PATH}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
