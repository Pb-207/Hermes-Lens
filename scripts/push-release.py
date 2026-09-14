"""可复用发布脚本:同步发布暂存区 -> 推 main/dev 整树 -> 建 Release + 上传 ehpk。

用法:
    python push-release.py <版本号> "<commit message>" "<release 标题>" "<release 正文文件路径>"

例:
    python push-release.py v0.4.12 "fix: narrower row width" "v0.4.12" notes.md
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO = "Pb-207/Hermes-Lens"
API = "https://api.github.com"
SRC = r"D:\Hermes\!Proj\JsProjs\even-hermes"
PUB = r"D:\Hermes\!Proj\JsProjs\Hermes-Lens-publish"
DEV = os.path.join(SRC, "dev")
SKIP = {".git", "node_modules", "dist", "backup", "even hub", "hermes-lens-skill", "store", "__pycache__"}


def token() -> str:
    p = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n",
                       capture_output=True, text=True)
    return next(l.split("=", 1)[1].strip() for l in p.stdout.splitlines() if l.startswith("password="))


TOK = token()
# 显式禁用代理:本机注册表里配了系统代理(127.0.0.1:1080,时开时关),
# urllib 会读它(curl/node 不读),于是代理没开时所有 API 调用都报
# "SSL: UNEXPECTED_EOF_WHILE_READING"。这里强制直连。
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(url, data=None, method="GET", ctype="application/json"):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOK)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "lens-push")
    if data is not None:
        req.add_header("Content-Type", ctype)
    try:
        with OPENER.open(req) as r:
            b = r.read()
            return json.loads(b) if b else {}
    except urllib.error.HTTPError as e:
        print("  HTTP", e.code, e.read().decode()[:200])
        return {}


def sync_staging() -> int:
    """项目 even hub/ -> 发布暂存区(漏了这步会让 main 落后)。"""
    n = 0
    for root, dirs, files in os.walk(os.path.join(SRC, "even hub")):
        dirs[:] = [d for d in dirs if d not in {"node_modules", "dist", "__pycache__", ".git"}]
        for f in files:
            if f.endswith(".ehpk"):
                continue
            sp = os.path.join(root, f)
            rel = os.path.relpath(sp, os.path.join(SRC, "even hub"))
            dp = os.path.join(PUB, "even hub", rel)
            os.makedirs(os.path.dirname(dp), exist_ok=True)
            shutil.copy2(sp, dp)
            n += 1
    return n


def walk(base, skip):
    out = []
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in skip]
        for f in files:
            if os.path.splitext(f)[1] == ".ehpk":
                continue
            fp = os.path.join(root, f)
            out.append((os.path.relpath(fp, base).replace("\\", "/"), fp))
    return sorted(out)


TEXT_EXT = {".ts", ".js", ".mjs", ".cjs", ".json", ".md", ".html", ".txt", ".css", ".yml", ".yaml",
            ".py", ".ps1", ".sh", ".gitignore", ".example"}


def file_bytes(path: str) -> bytes:
    """读文件,并把文本文件的 CRLF 归一成 LF —— git 仓库里存的是 LF,
    而本地 `git reset --hard` 会把文本文件还原成 CRLF(autocrlf),
    不归一化就会导致"文件其实没变却每次都被判为有变化"。"""
    with open(path, "rb") as f:
        data = f.read()
    ext = os.path.splitext(path)[1].lower()
    if ext in TEXT_EXT or os.path.basename(path).startswith(".env") or os.path.basename(path) == ".gitignore":
        data = data.replace(bytes([13, 10]), bytes([10]))
    return data


def git_blob_sha(path: str) -> str:
    """算 git 的 blob 对象哈希(sha1('blob <len>\\0' + content)),用来跟远端比对差异。"""
    import hashlib
    data = file_bytes(path)
    h = hashlib.sha1()
    h.update(b"blob " + str(len(data)).encode() + b"\0")
    h.update(data)
    return h.hexdigest()


def remote_tree(branch: str) -> dict:
    """远端该分支的 path -> sha 映射(递归)。"""
    try:
        head = api(f"{API}/repos/{REPO}/git/ref/heads/{branch}")["object"]["sha"]
        tree = api(f"{API}/repos/{REPO}/git/commits/{head}")["tree"]["sha"]
        data = api(f"{API}/repos/{REPO}/git/trees/{tree}?recursive=1")
        return {e["path"]: e["sha"] for e in data.get("tree", []) if e.get("type") == "blob"}
    except Exception as e:
        print("  (读取远端树失败,改为全量推送)", e)
        return {}


def push(branch, files, msg, remove=()):
    known = remote_tree(branch)
    changed = [(rel, fp) for rel, fp in files if known.get(rel) != git_blob_sha(fp)]
    removals = [p for p in remove if p in known]
    skipped = len(files) - len(changed)
    if not changed and not removals:
        print(f"  {branch} 无变化,跳过推送(共 {len(files)} 个文件)")
        return None
    print(f"  {branch}: {len(changed)} 个文件有变化(其余 {skipped} 个未改动,跳过上传)"
          + (f",删除 {len(removals)} 个" if removals else ""))
    ents = []
    for rel, fp in changed:
        blob = base64.b64encode(file_bytes(fp)).decode()
        b = api(f"{API}/repos/{REPO}/git/blobs",
                json.dumps({"content": blob, "encoding": "base64"}).encode(), "POST")
        ents.append({"path": rel, "mode": "100644", "type": "blob", "sha": b["sha"]})
    for rel in removals:  # sha=null 即从树里删掉该路径
        ents.append({"path": rel, "mode": "100644", "type": "blob", "sha": None})
    base = api(f"{API}/repos/{REPO}/git/ref/heads/{branch}")["object"]["sha"]
    bt = api(f"{API}/repos/{REPO}/git/commits/{base}")["tree"]["sha"]
    tree = api(f"{API}/repos/{REPO}/git/trees", json.dumps({"base_tree": bt, "tree": ents}).encode(), "POST")
    c = api(f"{API}/repos/{REPO}/git/commits",
            json.dumps({"message": msg, "tree": tree["sha"], "parents": [base]}).encode(), "POST")
    api(f"{API}/repos/{REPO}/git/refs/heads/{branch}", json.dumps({"sha": c["sha"]}).encode(), "PATCH")
    print(f"  {branch} -> {c['sha'][:7]} (base {base[:7]})")
    return c["sha"]


def main() -> None:
    if len(sys.argv) < 4:
        print(__doc__)
        return
    tag, msg, title = sys.argv[1], sys.argv[2], sys.argv[3]
    body = open(sys.argv[4], encoding="utf-8").read() if len(sys.argv) > 4 else ""
    print("暂存区同步", sync_staging(), "个文件")
    push("main", walk(PUB, {".git"}), msg)
    push("dev", walk(DEV, SKIP), msg + " (dev)")
    rel = api(f"{API}/repos/{REPO}/releases",
              json.dumps({"tag_name": tag, "name": title, "body": body,
                          "target_commitish": "main", "draft": False, "prerelease": False}).encode(), "POST")
    print("  release:", rel.get("html_url"))
    a = api(f"https://uploads.github.com/repos/{REPO}/releases/{rel['id']}/assets?name=hermes-lens.ehpk",
            open(os.path.join(DEV, "hermes-lens.ehpk"), "rb").read(), "POST", "application/octet-stream")
    print("  asset:", a.get("name"), a.get("size"))
    print("  校验 main:", api(f"{API}/repos/{REPO}/git/ref/heads/main")["object"]["sha"][:7],
          "| dev:", api(f"{API}/repos/{REPO}/git/ref/heads/dev")["object"]["sha"][:7])


if __name__ == "__main__":
    main()
