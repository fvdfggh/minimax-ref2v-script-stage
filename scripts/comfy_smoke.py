"""向 ComfyUI 提交一次导演图并轮询结果（走剧本台后端代理，绕开本机代理）。

用法：
  python scripts/comfy_smoke.py submit   # 提交最小图（1 段）
  python scripts/comfy_smoke.py poll <prompt_id>
  python scripts/comfy_smoke.py raw      # 原样提交（19 段，别用，太慢）

最小图 = 导出工作流的时间线只保留第 1 段（107 帧），用来验证
"模型能加载 / 显存够 / 能出片"，把 ComfyUI 侧风险和剧本台链路风险分开。
"""
import json
import sys
import time
import urllib.request

PROXY = "http://127.0.0.1:8787/api/comfy/proxy"
COMFY = "http://127.0.0.1:8188"
API_PATH = "C:/Users/于玉宇/Desktop/minimax-ref2v-script-stage/scripts/_exported_api_fixed.json"
for _a in sys.argv[1:]:
    if _a.startswith("--api="):
        API_PATH = _a.split("=", 1)[1]
    if _a.startswith("--frames="):
        globals()["FORCE_FRAMES"] = int(_a.split("=", 1)[1])
FORCE_FRAMES = 0
CLIENT = "scriptbench-smoke"

# 用 noproxy 的 opener，避免本机 HTTPS_PROXY 把 127.0.0.1 打成 502
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(path, method="GET", body=None, timeout=120):
    payload = json.dumps(
        {"base": COMFY, "method": method, "path": path, "body": body, "timeout": timeout},
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        PROXY, data=payload, headers={"Content-Type": "application/json"}, method="POST"
    )
    with OPENER.open(req, timeout=timeout + 60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_api():
    with open(API_PATH, encoding="utf-8") as f:
        return json.load(f)


def minimize(api):
    """把时间线砍到只剩第 1 段。"""
    api = json.loads(json.dumps(api))
    director = None
    for node in api.values():
        if node["class_type"] == "ComfyMiniMaxH3DirectorOpt":
            director = node
            break
    if not director:
        raise SystemExit("图里没有 Director 节点")

    tl = json.loads(director["inputs"]["timeline_data"])
    seg = tl["segments"][0]
    total = int(seg.get("frameCount") or seg.get("length") or 107)

    seg = json.loads(json.dumps(seg))
    seg["start"] = 0
    seg["length"] = total
    seg["frameCount"] = total
    seg["durationSec"] = round(total / 24, 3)
    seg["continuityFromPrev"] = False
    seg["continuityToNext"] = False

    tl["segments"] = [seg]
    tl["totalFrames"] = total
    tl["durationSec"] = round(total / 24, 3)
    tl["video"]["sourceFrameCount"] = total
    tl["video"]["frames"] = []
    tl["video"]["frameMap"] = []
    tl["video"]["deletedSourceRanges"] = []
    tl["gen"]["defaultFrameCount"] = total
    if tl.get("keyframes"):
        kf = json.loads(json.dumps(tl["keyframes"][0]))
        kf["start"] = 0
        kf["length"] = total
        kf["frameCount"] = total
        kf["durationSec"] = round(total / 24, 3)
        tl["keyframes"] = [kf]
    if tl.get("shots"):
        sh = json.loads(json.dumps(tl["shots"][0]))
        sh["durationSec"] = round(total / 24, 3)
        tl["shots"] = [sh]

    director["inputs"]["timeline_data"] = json.dumps(tl, ensure_ascii=False)
    director["inputs"]["total_frames"] = total
    return api, total


def submit(mini=True):
    api = load_api()
    total = None
    if mini:
        api, total = minimize(api)
    else:
        for node in api.values():
            if node["class_type"] == "ComfyMiniMaxH3DirectorOpt":
                total = node["inputs"].get("total_frames")
    print(f"提交：节点 {len(api)} 个，总帧 {total}")

    res = call("/prompt", "POST", {"prompt": api, "client_id": CLIENT}, timeout=120)
    body = res.get("json") or {}
    if not res.get("ok"):
        print("提交失败：", res.get("status"))
        print(json.dumps(body, ensure_ascii=False, indent=1))
        return
    if body.get("node_errors"):
        print("节点校验错误：")
        print(json.dumps(body["node_errors"], ensure_ascii=False, indent=1))
        return
    pid = body.get("prompt_id")
    print("prompt_id =", pid)
    print("queue number =", body.get("number"))
    # 注意别用字符串 replace 从 API_PATH 推这个路径 —— 那样会把 API 文件自己覆盖掉
    with open("C:/Users/于玉宇/Desktop/minimax-ref2v-script-stage/scripts/_last_prompt_id.txt", "w") as f:
        f.write(pid)
    return pid


def poll(pid, wait=3600, every=10):
    t0 = time.time()
    last = ""
    while time.time() - t0 < wait:
        res = call(f"/history/{pid}", timeout=60)
        body = res.get("json") or {}
        entry = body.get(pid)
        if entry:
            status = entry.get("status", {})
            print()
            print("完成。status =", json.dumps(status, ensure_ascii=False)[:400])
            for node_id, out in (entry.get("outputs") or {}).items():
                for kind, items in out.items():
                    for it in items if isinstance(items, list) else [items]:
                        print(f"  产物 {node_id}/{kind}: {json.dumps(it, ensure_ascii=False)[:200]}")
            return entry
        # 队列状态
        q = call("/queue", timeout=30).get("json") or {}
        running = len(q.get("queue_running") or [])
        pending = len(q.get("queue_pending") or [])
        line = f"等待中 {int(time.time() - t0)}s · 运行 {running} · 排队 {pending}"
        if line != last:
            print(line, flush=True)
            last = line
        time.sleep(every)
    print("超时未出片")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "submit"
    if cmd == "submit":
        submit(mini=True)
    elif cmd == "raw":
        submit(mini=False)
    elif cmd == "poll":
        poll(sys.argv[2])
    elif cmd == "auto":
        pid = submit(mini=True)
        if pid:
            poll(pid)
