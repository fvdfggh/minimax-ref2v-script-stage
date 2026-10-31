"""账号与会话的单测。

跑法：
    python server/test_auth.py

这里只测 ``auth`` 模块本身（哈希、令牌、限速），不启动 HTTP ——
``app.py`` 一 import 就会去读真实的 ``~/.scriptstage`` 配置，
测试不该碰用户的账号库。HTTP 那层靠起真服务冒烟验证。
"""

from __future__ import annotations

import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import auth  # noqa: E402


class AuthTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="ss-auth-")
        root = Path(self._tmp.name)
        # 把持久化位置整体挪到临时目录：这些用例绝不能碰到真账号库
        self._saved = (auth.CONFIG_DIR, auth.USERS_PATH, auth.INITIAL_ACCOUNT_PATH)
        auth.CONFIG_DIR = root
        auth.USERS_PATH = root / "users.json"
        auth.INITIAL_ACCOUNT_PATH = root / "初始账号.txt"
        auth._fails.clear()

    def tearDown(self) -> None:
        auth.CONFIG_DIR, auth.USERS_PATH, auth.INITIAL_ACCOUNT_PATH = self._saved
        auth._fails.clear()
        self._tmp.cleanup()

    # ------------------------------ 账号 ------------------------------

    def test_create_and_login(self) -> None:
        user, plain = auth.create_user("alice", "secret123", "爱丽丝")
        self.assertEqual(user["username"], "alice")
        self.assertEqual(user["displayName"], "爱丽丝")
        self.assertEqual(plain, "secret123")

        ok, token = auth.login("alice", "secret123", "127.0.0.1")
        self.assertEqual(ok["username"], "alice")
        self.assertTrue(token.startswith("v1."))
        self.assertEqual(auth.verify_token(token), "alice")

    def test_duplicate_username_rejected(self) -> None:
        auth.create_user("bob", "secret123")
        with self.assertRaises(auth.AuthError) as ctx:
            auth.create_user("BOB", "other123")
        self.assertEqual(ctx.exception.status, 409)

    def test_short_password_rejected(self) -> None:
        with self.assertRaises(auth.AuthError) as ctx:
            auth.create_user("carol", "123")
        self.assertEqual(ctx.exception.status, 400)

    def test_random_password_is_usable(self) -> None:
        user, plain = auth.create_user("dave")
        self.assertGreaterEqual(len(plain), 16)
        auth.login("dave", plain, "127.0.0.1")

    def test_password_is_not_stored_in_plain(self) -> None:
        auth.create_user("erin", "plaintext1")
        raw = auth.USERS_PATH.read_text(encoding="utf-8")
        self.assertNotIn("plaintext1", raw)

    def test_cannot_delete_last_account(self) -> None:
        auth.create_user("frank", "secret123")
        with self.assertRaises(auth.AuthError) as ctx:
            auth.delete_user("frank")
        self.assertEqual(ctx.exception.status, 400)

    def test_delete_account_kills_its_token(self) -> None:
        auth.create_user("grace", "secret123")
        auth.create_user("heidi", "secret123")
        _, token = auth.login("grace", "secret123", "127.0.0.1")
        self.assertEqual(auth.verify_token(token), "grace")
        auth.delete_user("grace")
        self.assertIsNone(auth.verify_token(token))

    # ------------------------------ 令牌 ------------------------------

    def test_wrong_password_rejected(self) -> None:
        auth.create_user("ivan", "secret123")
        with self.assertRaises(auth.AuthError) as ctx:
            auth.login("ivan", "wrong-one", "127.0.0.1")
        self.assertEqual(ctx.exception.status, 401)

    def test_unknown_user_gets_same_message(self) -> None:
        """不告诉对方"这个账号存在" —— 措辞必须和密码错完全一样。"""
        auth.create_user("judy", "secret123")
        with self.assertRaises(auth.AuthError) as missing:
            auth.login("nobody", "secret123", "127.0.0.1")
        with self.assertRaises(auth.AuthError) as wrong:
            auth.login("judy", "bad-password", "127.0.0.1")
        self.assertEqual(missing.exception.message, wrong.exception.message)

    def test_token_is_tamper_proof(self) -> None:
        auth.create_user("ken", "secret123")
        _, token = auth.login("ken", "secret123", "127.0.0.1")
        head, body, mac = token.split(".")
        # 换个用户名重新签 —— 没有密钥就签不出来，改哪一段都得废
        forged = f"{head}.{body[:-2]}AA.{mac}"
        self.assertIsNone(auth.verify_token(forged))
        self.assertIsNone(auth.verify_token(token.replace(mac, "0" * len(mac))))
        self.assertIsNone(auth.verify_token("garbage"))

    def test_expired_token_rejected(self) -> None:
        auth.create_user("laura", "secret123")
        _, token = auth.login("laura", "secret123", "127.0.0.1")
        saved = auth.TOKEN_TTL
        auth.TOKEN_TTL = -1  # 立刻过期
        try:
            _, stale = auth.login("laura", "secret123", "127.0.0.1")
        finally:
            auth.TOKEN_TTL = saved
        self.assertIsNone(auth.verify_token(stale))
        self.assertEqual(auth.verify_token(token), "laura")

    def test_change_password_invalidates_old_token(self) -> None:
        auth.create_user("mallory", "old-pass1")
        _, old_token = auth.login("mallory", "old-pass1", "127.0.0.1")
        new_token = auth.change_password("mallory", "old-pass1", "new-pass2", "127.0.0.1")
        # 密码指纹是令牌的一部分：改密后旧 cookie 立即作废（否则被盗的会话
        # 改密码也赶不走）
        self.assertIsNone(auth.verify_token(old_token))
        self.assertEqual(auth.verify_token(new_token), "mallory")
        auth.login("mallory", "new-pass2", "127.0.0.1")

    def test_change_password_needs_old_one(self) -> None:
        auth.create_user("niaj", "secret123")
        with self.assertRaises(auth.AuthError) as ctx:
            auth.change_password("niaj", "wrong", "new-pass2", "127.0.0.1")
        self.assertEqual(ctx.exception.status, 401)

    # ------------------------------ 限速 ------------------------------

    def test_lockout_after_repeated_failures(self) -> None:
        auth.create_user("olivia", "secret123")
        for _ in range(auth.MAX_FAILS):
            with self.assertRaises(auth.AuthError):
                auth.login("olivia", "wrong", "10.0.0.1")
        # 第 6 次连正确密码都不放行，直到锁定时间过去
        with self.assertRaises(auth.AuthError) as ctx:
            auth.login("olivia", "secret123", "10.0.0.1")
        self.assertEqual(ctx.exception.status, 429)
        # 换个 IP 不受影响（锁的是 IP+账号，不是账号）
        auth.login("olivia", "secret123", "10.0.0.2")

    def test_lockout_expires(self) -> None:
        auth.create_user("peggy", "secret123")
        for _ in range(auth.MAX_FAILS):
            with self.assertRaises(auth.AuthError):
                auth.login("peggy", "wrong", "10.0.0.3")
        saved = auth.LOCK_SECONDS
        auth.LOCK_SECONDS = 0
        try:
            auth.login("peggy", "secret123", "10.0.0.3")
        finally:
            auth.LOCK_SECONDS = saved

    # ---------------------------- 初始账号 ----------------------------

    def test_initial_account_created_once(self) -> None:
        first = auth.ensure_initial_account()
        self.assertIsNotNone(first)
        user, plain = first  # type: ignore[misc]
        self.assertEqual(user["username"], "admin")
        self.assertTrue(auth.INITIAL_ACCOUNT_PATH.is_file())
        self.assertIn(plain, auth.INITIAL_ACCOUNT_PATH.read_text(encoding="utf-8"))
        # 第二次不该再建（否则每次重启都多一个 admin 并重置密码）
        self.assertIsNone(auth.ensure_initial_account())
        auth.login("admin", plain, "127.0.0.1")

    def test_corrupt_store_falls_back_to_empty(self) -> None:
        auth.USERS_PATH.parent.mkdir(parents=True, exist_ok=True)
        auth.USERS_PATH.write_text("{ 不是 json", encoding="utf-8")
        # 坏文件不能让服务起不来：退回空库，下一个请求重新建 admin
        self.assertEqual(auth.list_users(), [])
        self.assertIsNotNone(auth.ensure_initial_account())

    def test_secret_persists_across_loads(self) -> None:
        auth.create_user("quinn", "secret123")
        _, token = auth.login("quinn", "secret123", "127.0.0.1")
        # 模拟重启：重新读文件，密钥必须还是同一个，否则每次重启都掉线
        self.assertEqual(auth.verify_token(token), "quinn")
        time.sleep(0.01)
        self.assertEqual(auth.verify_token(token), "quinn")


if __name__ == "__main__":
    unittest.main(verbosity=2)
