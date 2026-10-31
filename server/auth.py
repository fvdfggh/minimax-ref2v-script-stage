"""剧本台账号与会话。

设计口径（和用户确认过的）：**没有注册，只有登录**。
账号只能由管理员在命令行创建 —— 这台机器上的剧本台是一个工作台，不是一个
对外的网站，任何人点一下就能注册的入口本身就是漏洞。

存储只用一个文件 ``~/.scriptstage/users.json``：

    {
      "version": 1,
      "secret": "<hex>",                       # 会话令牌签名密钥
      "users": [{username, displayName, salt, hash, iterations, ...}]
    }

放在配置目录而不是数据目录，理由很实际：数据目录可以在「存储」对话框里随时
切换（换盘、换项目库），账号绝不能跟着数据目录走 —— 否则换一次目录就得重新
建账号，旧账号还留在旧目录里。

密码用 PBKDF2-SHA256（标准库 hashlib），不引第三方依赖，和 app.py 的取舍一致。
会话令牌是无状态签名令牌（``v1.<payload>.<hmac>``），服务重启不掉线；payload
里带了密码指纹，改密码即刻让所有旧令牌失效。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import string
import threading
import time
from pathlib import Path

CONFIG_DIR = Path(
    os.environ.get("SCRIPTSTAGE_HOME") or (Path.home() / ".scriptstage")
)
USERS_PATH = CONFIG_DIR / "users.json"
INITIAL_ACCOUNT_PATH = CONFIG_DIR / "初始账号.txt"

#: PBKDF2 迭代次数。2026 年的机器上单次约 60ms —— 登录感觉不到，
#: 但拿字典爆破的成本上来了。
ITERATIONS = 210_000
#: 会话有效期：14 天
TOKEN_TTL = 14 * 24 * 3600

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.@-]{2,32}$")
MIN_PASSWORD = 6

#: 登录失败限速：同一 IP + 用户名，连续失败 5 次锁 60 秒。
#: 进程内计数即可 —— 后端是单机常驻服务，重启丢计数也不亏。
MAX_FAILS = 5
LOCK_SECONDS = 60

_lock = threading.RLock()
_fails: dict[tuple[str, str], tuple[int, float]] = {}


class AuthError(Exception):
    """带 HTTP 状态码的业务错误，由 app.py 直接转成响应。"""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


# ------------------------------ 存储 ------------------------------


def _new_store() -> dict:
    return {"version": 1, "secret": secrets.token_hex(32), "users": []}


def _load() -> dict:
    """读 users.json；文件不存在/损坏都退回空库（下次写回时重建）。"""
    try:
        raw = json.loads(USERS_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return _new_store()
    if not isinstance(raw, dict):
        return _new_store()
    if not raw.get("secret"):
        raw["secret"] = secrets.token_hex(32)
    if not isinstance(raw.get("users"), list):
        raw["users"] = []
    return raw


def _save(data: dict) -> None:
    """原子写：先写临时文件再 replace。

    直接覆写的话，写一半断电会得到一个坏 JSON —— 那等于全部账号消失，
    而这是唯一一份账号库，没有别的备份。
    """
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = USERS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, USERS_PATH)
    try:
        # POSIX 上收紧权限；Windows 上 chmod 基本无效，忽略即可
        os.chmod(USERS_PATH, 0o600)
    except OSError:
        pass


# --------------------------- 密码哈希 ---------------------------


def _digest(password: str, salt: str, iterations: int = ITERATIONS) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), iterations
    ).hex()


def _fingerprint(user: dict) -> str:
    """密码指纹，进令牌。改密码 → 指纹变 → 旧令牌全废。"""
    return hashlib.sha256(f"{user['salt']}:{user['hash']}".encode()).hexdigest()[:16]


def hash_password(password: str) -> dict:
    salt = secrets.token_hex(16)
    return {"salt": salt, "hash": _digest(password, salt), "iterations": ITERATIONS}


def random_password(length: int = 16) -> str:
    """给初始账号用的可读随机密码：分成 4 组，方便手抄进登录框。"""
    alphabet = string.ascii_letters + string.digits
    raw = "".join(secrets.choice(alphabet) for _ in range(length))
    return "-".join(raw[i : i + 4] for i in range(0, len(raw), 4))


def _check_username(username: str) -> str:
    name = (username or "").strip()
    if not USERNAME_RE.match(name):
        raise AuthError(400, "用户名只能是 2-32 位字母、数字、下划线、点、@ 或短横线")
    return name


def _check_password(password: str) -> str:
    if not isinstance(password, str) or len(password) < MIN_PASSWORD:
        raise AuthError(400, f"密码至少 {MIN_PASSWORD} 位")
    return password


def _public(user: dict) -> dict:
    return {
        "username": user["username"],
        "displayName": user.get("displayName") or user["username"],
        "createdAt": user.get("createdAt", 0),
        "lastLoginAt": user.get("lastLoginAt", 0),
    }


def _find(data: dict, username: str) -> dict | None:
    key = (username or "").strip().casefold()
    for user in data["users"]:
        if str(user.get("username", "")).casefold() == key:
            return user
    return None


# ---------------------------- 账号操作 ----------------------------


def list_users() -> list[dict]:
    with _lock:
        return [_public(u) for u in _load()["users"]]


def create_user(username: str, password: str | None = None, display: str = "") -> tuple[dict, str]:
    """建账号。密码留空则随机生成，第二个返回值是明文（只在此刻存在一次）。"""
    name = _check_username(username)
    plain = _check_password(password) if password else random_password()
    with _lock:
        data = _load()
        if _find(data, name):
            raise AuthError(409, f"账号 {name} 已存在")
        now = int(time.time())
        user = {
            "username": name,
            "displayName": (display or name).strip()[:32],
            **hash_password(plain),
            "createdAt": now,
            "updatedAt": now,
            "lastLoginAt": 0,
        }
        data["users"].append(user)
        _save(data)
        return _public(user), plain


def delete_user(username: str) -> None:
    with _lock:
        data = _load()
        user = _find(data, username)
        if not user:
            raise AuthError(404, f"没有账号 {username}")
        if len(data["users"]) <= 1:
            # 删掉最后一个账号 = 把自己永久锁在门外（没有注册入口可以补救）
            raise AuthError(400, "这是最后一个账号，删了就没人能登录了")
        data["users"].remove(user)
        _save(data)


def set_password(username: str, password: str | None = None) -> tuple[dict, str]:
    plain = _check_password(password) if password else random_password()
    with _lock:
        data = _load()
        user = _find(data, username)
        if not user:
            raise AuthError(404, f"没有账号 {username}")
        user.update(hash_password(plain))
        user["updatedAt"] = int(time.time())
        _save(data)
        return _public(user), plain


def ensure_initial_account() -> tuple[dict, str] | None:
    """账号库为空时建一个 admin，返回 (用户, 明文密码)；否则 None。

    密码写到 ``~/.scriptstage/初始账号.txt``，同时由 app.py 打在控制台上 ——
    随机密码只在创建这一刻存在，丢了就只能用命令行重置。
    """
    with _lock:
        data = _load()
        if data["users"]:
            if not USERS_PATH.exists():
                _save(data)  # 补上缺失的 secret
            return None
        plain = random_password()
        now = int(time.time())
        user = {
            "username": "admin",
            "displayName": "管理员",
            **hash_password(plain),
            "createdAt": now,
            "updatedAt": now,
            "lastLoginAt": 0,
        }
        data["users"].append(user)
        _save(data)
        try:
            INITIAL_ACCOUNT_PATH.write_text(
                "剧本台初始账号\n"
                "================\n\n"
                f"用户名：admin\n"
                f"密码：{plain}\n\n"
                "这个系统没有注册入口，账号只能由管理员在命令行创建：\n"
                "  python server/app.py user add <用户名>\n"
                "  python server/app.py user passwd <用户名>\n\n"
                "登录后可以在右上角用户菜单里改掉这个密码，改完本文件即失效，"
                "建议直接删掉它。\n",
                encoding="utf-8",
            )
        except OSError:
            pass
        return _public(user), plain


# ---------------------------- 会话令牌 ----------------------------


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def _sign(secret: str, payload: str) -> str:
    mac = hmac.new(bytes.fromhex(secret), payload.encode(), hashlib.sha256).digest()
    return _b64(mac)


def issue_token(username: str) -> str:
    with _lock:
        data = _load()
        user = _find(data, username)
        if not user:
            raise AuthError(401, "账号不存在")
        payload = json.dumps(
            {
                "u": user["username"],
                "p": _fingerprint(user),
                "exp": int(time.time()) + TOKEN_TTL,
            },
            separators=(",", ":"),
        )
        body = _b64(payload.encode())
        return f"v1.{body}.{_sign(data['secret'], body)}"


def verify_token(token: str) -> str | None:
    """令牌有效则返回用户名，否则 None（签名不对/过期/账号被删/密码改过）。"""
    if not token or not token.startswith("v1."):
        return None
    parts = token.split(".")
    if len(parts) != 3:
        return None
    _, body, mac = parts
    with _lock:
        data = _load()
        expect = _sign(data["secret"], body)
        if not hmac.compare_digest(mac, expect):
            return None
        try:
            payload = json.loads(_unb64(body))
        except (ValueError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict):
            return None
        if int(payload.get("exp") or 0) < int(time.time()):
            return None
        user = _find(data, str(payload.get("u") or ""))
        if not user:
            return None
        if payload.get("p") != _fingerprint(user):
            return None
        return user["username"]


# ---------------------------- 登录与限速 ----------------------------


def _rate_key(ip: str, username: str) -> tuple[str, str]:
    return (ip or "", (username or "").strip().casefold())


def check_rate(ip: str, username: str) -> None:
    with _lock:
        count, last = _fails.get(_rate_key(ip, username), (0, 0.0))
        if count >= MAX_FAILS:
            wait = LOCK_SECONDS - (time.time() - last)
            if wait > 0:
                raise AuthError(429, f"密码错误次数过多，请 {int(wait) + 1} 秒后再试")
            _fails.pop(_rate_key(ip, username), None)


def note_fail(ip: str, username: str) -> None:
    with _lock:
        key = _rate_key(ip, username)
        count, _ = _fails.get(key, (0, 0.0))
        _fails[key] = (count + 1, time.time())


def note_ok(ip: str, username: str) -> None:
    with _lock:
        _fails.pop(_rate_key(ip, username), None)


def login(username: str, password: str, ip: str = "") -> tuple[dict, str]:
    """校验账号密码，返回 (公开用户, 令牌)。

    用户名不存在与密码错误返回同一句提示，不告诉对方"这个账号存在"。
    """
    check_rate(ip, username)
    with _lock:
        data = _load()
        user = _find(data, username)
        if not user or not hmac.compare_digest(
            _digest(password, user["salt"], int(user.get("iterations") or ITERATIONS)),
            user["hash"],
        ):
            note_fail(ip, username)
            raise AuthError(401, "用户名或密码不对")
        user["lastLoginAt"] = int(time.time())
        _save(data)
        note_ok(ip, username)
        return _public(user), issue_token(user["username"])


def change_password(username: str, old_password: str, new_password: str, ip: str = "") -> str:
    """改自己的密码，返回新令牌（旧令牌因为指纹变化自动作废）。"""
    check_rate(ip, username)
    _check_password(new_password)
    with _lock:
        data = _load()
        user = _find(data, username)
        if not user:
            raise AuthError(401, "账号不存在")
        if not hmac.compare_digest(
            _digest(old_password, user["salt"], int(user.get("iterations") or ITERATIONS)),
            user["hash"],
        ):
            note_fail(ip, username)
            raise AuthError(401, "原密码不对")
        user.update(hash_password(new_password))
        user["updatedAt"] = int(time.time())
        _save(data)
        note_ok(ip, username)
        return issue_token(user["username"])


def get_user(username: str) -> dict | None:
    with _lock:
        user = _find(_load(), username)
        return _public(user) if user else None
