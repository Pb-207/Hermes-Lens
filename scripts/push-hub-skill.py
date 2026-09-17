"""把最新 skill 推送到 Hermes 社区 hub 的 PR 分支(Pb-207/hermes-community-hub: skill/even-hermes)。

不新建 PR —— 更新已有 PR #3("Add skill: hermes-lens")的分支,PR 会自动刷新。
"""
import base64
import io
import json
import os
import subprocess
import urllib.error
import urllib.request

FORK = "Pb-207/hermes-community-hub"
BRANCH = "skill/even-hermes"
SKILL_SRC = r"D:\Hermes\!Proj\TsProjs\even-hermes\hermes-lens-skill"
DEST_PREFIX = "skills/devops/hermes-lens"
API = "https://api.github.com"


def token() -> str:
    p = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n",
                       capture_output=True, text=True)
    return next(l.split("=", 1)[1].strip() for l in p.stdout.splitlines() if l.startswith("password="))


TOK = token()
# 同 push-release.py:绕开本机可能失效的系统代理,否则 API 调用会 TLS 失败
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(url, data=None, method="GET"):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOK)
    req.add_header("Accept", "application/vnd.github+json")
    try:
        with OPENER.open(req, timeout=60) as r:
            body = r.read().decode()
            return json.loads(body) if body.strip() else {}
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code} {method} {url}\n{e.read().decode()[:400]}")


def norm(b: bytes) -> bytes:
    return b.replace(b"\r\n", b"\n")


def main() -> None:
    ref = api(f"{API}/repos/{FORK}/git/ref/heads/{BRANCH}")
    head = ref["object"]["sha"]
    base_tree = api(f"{API}/repos/{FORK}/git/commits/{head}")["tree"]["sha"]
    print(f"分支 {BRANCH} 当前 {head[:7]} (tree {base_tree[:7]})")

    files = []
    for root, dirs, fs in os.walk(SKILL_SRC):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        rel = os.path.relpath(root, SKILL_SRC)
        for f in fs:
            if f.endswith(".pyc"):
                continue
            full = os.path.join(root, f)
            dest = f"{DEST_PREFIX}/{f}" if rel == "." else f"{DEST_PREFIX}/{rel.replace(os.sep, '/')}/{f}"
            files.append((dest, norm(io.open(full, "rb").read())))
    files.sort()
    print("待上传:", len(files), "个文件")

    tree = []
    for dest, content in files:
        blob = api(f"{API}/repos/{FORK}/git/blobs",
                   json.dumps({"content": base64.b64encode(content).decode(), "encoding": "base64"}).encode(),
                   "POST")
        tree.append({"path": dest, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print(f"  blob {dest}  {len(content)}B  {blob['sha'][:7]}")

    new_tree = api(f"{API}/repos/{FORK}/git/trees",
                   json.dumps({"base_tree": base_tree, "tree": tree}).encode(), "POST")
    msg = ("Update hermes-lens skill to 1.1.0\n\n"
           "- document live-partial streaming (WebSocket) and the REST fallback\n"
           "- note -ModelDir so an existing model cache is reused instead of re-downloaded\n"
           "- correct the gesture description: double-press while recording cancels back to the conversation\n"
           "- fix start-stt.ps1 (PowerShell escaping) and refresh server.py\n")
    commit = api(f"{API}/repos/{FORK}/git/commits",
                 json.dumps({"message": msg, "tree": new_tree["sha"], "parents": [head]}).encode(), "POST")
    print("新提交:", commit["sha"][:7])
    api(f"{API}/repos/{FORK}/git/refs/heads/{BRANCH}",
        json.dumps({"sha": commit["sha"]}).encode(), "PATCH")
    print("已更新分支", BRANCH)

    pr = api(f"{API}/repos/nous-hermeshub/hermes-community-hub/pulls/3")
    print("PR #3:", pr["state"], "| commits:", pr["commits"], "| changed_files:", pr["changed_files"],
          "| head:", pr["head"]["sha"][:7], "| mergeable_state:", pr.get("mergeable_state"))


if __name__ == "__main__":
    main()
