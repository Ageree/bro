"""tg-bridge tests: cd scripts/cloudru-app-host/tg-bridge && python -m unittest (stdlib only, no network).

Telegram is a fake Bot API on loopback (getUpdates with offset, long poll, a webhook switch, a 409 mode); eve
is a fake /eve/v1/telegram that records what it took and answers per update id from a script.
"""

import http.client
import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import tg_bridge  # noqa: E402

TOKEN = "123456:test-token_x"
SECRET = "s3cret-value_1"


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass  # the bridge hung up on a long poll it interrupted


class FakeTelegram:
    def __init__(self):
        self.updates = []
        self.confirmed = 0
        self.webhook = ""
        self.conflict = False
        self.calls = []
        self.offsets = []
        self.allowed = None
        self.cond = threading.Condition()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
                prefix = f"/bot{TOKEN}/"
                if not self.path.startswith(prefix):
                    self.reply(401, {"ok": False, "error_code": 401, "description": "Unauthorized"})
                    return
                status, payload = fake.handle(self.path[len(prefix):], body)
                self.reply(status, payload)

            def reply(self, status, payload):
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = QuietServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, args=(0.05,), daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def add(self, *updates):
        with self.cond:
            self.updates.extend(updates)
            self.cond.notify_all()

    def handle(self, method, body):
        with self.cond:
            self.calls.append(method)
        if method == "getWebhookInfo":
            return 200, {"ok": True, "result": {"url": self.webhook, "pending_update_count": len(self.pending())}}
        if method == "deleteWebhook":
            self.webhook = ""
            return 200, {"ok": True, "result": True}
        if method == "setWebhook":
            self.webhook = body["url"]
            self.set_body = body
            return 200, {"ok": True, "result": True}
        if method == "getUpdates":
            if self.webhook:
                return 409, {"ok": False, "error_code": 409,
                             "description": "Conflict: can't use getUpdates method while webhook is active"}
            if self.conflict:
                return 409, {"ok": False, "error_code": 409,
                             "description": "Conflict: terminated by other getUpdates request"}
            offset = body.get("offset", 0)
            self.allowed = body.get("allowed_updates")
            with self.cond:
                self.offsets.append(offset)
                self.confirmed = max(self.confirmed, offset)
                deadline = time.monotonic() + body.get("timeout", 0)
                while not self.pending() and time.monotonic() < deadline:
                    self.cond.wait(deadline - time.monotonic())
                return 200, {"ok": True, "result": self.pending()[:100]}
        return 404, {"ok": False, "error_code": 404, "description": "Not Found"}

    def pending(self):
        return [u for u in self.updates if u["update_id"] >= self.confirmed]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class FakeEve:
    """Records (update_id, chat) it took; `script[update_id]` is a list of statuses answered first."""

    def __init__(self):
        self.taken = []
        self.seen = []
        self.script = {}
        self.secrets = []
        self.healthy = True
        self.lock = threading.Lock()
        eve = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                status = 200 if self.path == "/eve/v1/health" and eve.healthy else 503
                self.send_response(status)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")

            def do_POST(self):
                data = self.rfile.read(int(self.headers["Content-Length"]))
                status = eve.handle(data, self.headers)
                self.send_response(status)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, *args):
                pass

        self.server = QuietServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, args=(0.05,), daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/eve/v1/telegram"

    def handle(self, data, headers):
        update = json.loads(data)
        with self.lock:
            self.secrets.append((headers.get("X-Telegram-Bot-Api-Secret-Token"), headers.get("Content-Type")))
            self.seen.append(update["update_id"])
            answers = self.script.get(update["update_id"])
            status = answers.pop(0) if answers else 200
            if status == 200:
                self.taken.append(update["update_id"])
        return status

    def taken_ids(self):
        with self.lock:
            return list(self.taken)

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def message(update_id, chat, text="x"):
    return {"update_id": update_id, "message": {"message_id": update_id, "chat": {"id": chat, "type": "private"},
                                                 "from": {"id": chat}, "text": text}}


def wait_for(predicate, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class BridgeCase(unittest.TestCase):
    def setUp(self):
        self.telegram = FakeTelegram()
        self.eve = FakeEve()
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.addCleanup(self.telegram.close)
        self.addCleanup(self.eve.close)
        self.bridges = []
        self.log = []
        patcher = mock.patch.object(tg_bridge, "log", self.log.append)
        patcher.start()
        self.addCleanup(patcher.stop)

    def settings(self, **extra):
        env = {
            "TELEGRAM_BOT_TOKEN": TOKEN,
            "TELEGRAM_WEBHOOK_SECRET_TOKEN": SECRET,
            "TG_BRIDGE_EVE_URL": self.eve.url,
            "TG_BRIDGE_API": self.telegram.url,
            "TG_BRIDGE_STATE": str(Path(self.dir.name) / "state.json"),
            "TG_BRIDGE_HEALTH": "127.0.0.1:0",
            "TG_BRIDGE_POLL_TIMEOUT": "1",
            "TG_BRIDGE_CHAT_GAP_MS": "20",
            "TG_BRIDGE_ATTEMPTS": "3",
            "TG_BRIDGE_RETRY_BASE_S": "0.02",
            "TG_BRIDGE_RETRY_MAX_S": "0.1",
            "TG_BRIDGE_CONFLICT_PAUSE_S": "0.5",
            "TG_BRIDGE_BUSY_POLL_S": "0.1",
            **extra,
        }
        return tg_bridge.Settings(env)

    def start(self, settings=None, deliver=None):
        bridge = tg_bridge.Bridge(settings or self.settings(), deliver=deliver)
        thread = threading.Thread(target=bridge.run, daemon=True)
        thread.start()
        self.bridges.append((bridge, thread))
        self.addCleanup(self.stop, bridge, thread)
        return bridge

    def stop(self, bridge, thread):
        bridge.stop.set()
        bridge.telegram.interrupt()
        thread.join(10)
        self.assertFalse(thread.is_alive())

    def saved(self):
        """The state file without its bot fingerprint (checked in its own test)."""
        try:
            saved = json.loads((Path(self.dir.name) / "state.json").read_text())
        except FileNotFoundError:
            return None
        saved.pop("bot", None)
        return saved

    def logged(self):
        return "\n".join(self.log)


class Delivery(BridgeCase):
    def test_delivers_like_the_webhook_and_confirms_after_eve(self):
        self.telegram.add(message(10, 1, "привет"), {"update_id": 11, "callback_query": {
            "id": "q", "from": {"id": 1}, "message": {"message_id": 3, "chat": {"id": 1}}, "data": "eve_hitl:1"}})
        self.start()
        self.assertTrue(wait_for(lambda: self.eve.taken_ids() == [10, 11]))
        self.assertTrue(wait_for(lambda: self.saved() == {"offset": 12, "done": []}))
        self.assertEqual(self.eve.secrets[0], (SECRET, "application/json"))
        self.assertEqual(self.telegram.allowed, ["message", "callback_query"])
        self.assertNotIn(TOKEN, self.logged())
        self.assertNotIn("привет", self.logged())

    def test_keeps_order_within_a_chat(self):
        self.telegram.add(*[message(i, 7) for i in range(1, 9)])
        self.start()
        self.assertTrue(wait_for(lambda: len(self.eve.taken_ids()) == 8))
        self.assertEqual(self.eve.taken_ids(), list(range(1, 9)))

    def test_a_failing_chat_does_not_hold_up_others(self):
        # Chat 1's update fails while eve keeps answering 500 to it; chat 2 is delivered meanwhile.
        self.eve.script[1] = [500] * 15
        self.telegram.add(message(1, 1), message(2, 1), message(3, 2))
        bridge = self.start(self.settings(TG_BRIDGE_ATTEMPTS="100"))
        self.assertTrue(wait_for(lambda: 3 in self.eve.taken_ids()))
        self.assertNotIn(2, self.eve.taken_ids())
        # Nothing at or above the failing update is confirmed, to Telegram or in the state file.
        self.assertTrue(wait_for(lambda: self.saved() == {"offset": 1, "done": [3]}))
        self.assertTrue(all(o <= 1 for o in self.telegram.offsets))
        # A new chat's message still comes in while chat 1 retries.
        self.telegram.add(message(4, 3))
        self.assertTrue(wait_for(lambda: 4 in self.eve.taken_ids()))
        self.assertTrue(wait_for(lambda: sorted(self.eve.taken_ids()) == [1, 2, 3, 4]))
        taken = self.eve.taken_ids()
        self.assertLess(taken.index(1), taken.index(2))
        self.assertTrue(wait_for(lambda: self.saved() == {"offset": 5, "done": []}))
        self.assertEqual(self.eve.taken_ids().count(3), 1)
        self.assertEqual(bridge.counters["dropped"], 0)

    def test_duplicates_from_telegram_go_to_eve_once(self):
        self.eve.script[1] = [503, 503]
        self.telegram.add(message(1, 1), message(2, 2))
        self.start()
        self.assertTrue(wait_for(lambda: sorted(self.eve.taken_ids()) == [1, 2]))
        time.sleep(0.3)
        self.assertEqual(sorted(self.eve.taken_ids()), [1, 2])
        self.assertEqual(self.eve.seen.count(2), 1)

    def test_eve_down_is_retried_without_dropping(self):
        bridge = self.start(self.settings(TG_BRIDGE_EVE_URL="http://127.0.0.1:9/eve/v1/telegram"))
        self.telegram.add(message(1, 1))
        self.assertTrue(wait_for(lambda: bridge.counters["deliveryRetries"] >= 6))
        self.assertEqual(bridge.counters["dropped"], 0)
        self.assertFalse((Path(self.dir.name) / "state.json").exists())

    def test_a_poisoned_update_is_dropped_after_attempts(self):
        self.eve.script[1] = [400] * 10
        self.telegram.add(message(1, 1), message(2, 1))
        bridge = self.start()
        self.assertTrue(wait_for(lambda: self.eve.taken_ids() == [2]))
        self.assertEqual(self.eve.seen.count(1), 3)
        self.assertEqual(bridge.counters["dropped"], 1)
        self.assertIn("update 1 (message) dropped after 3 attempts, last 400", self.logged())
        self.assertTrue(wait_for(lambda: self.saved()["offset"] == 3))

    def test_errors_while_eve_is_unhealthy_drop_nothing(self):
        # eve answers 500 and 400 while its own health check fails (starting, a broken release): eve's trouble.
        self.eve.healthy = False
        self.eve.script[1] = [500] * 1000
        self.eve.script[2] = [400] * 1000
        self.telegram.add(message(1, 1), message(2, 2))
        bridge = self.start()
        self.assertTrue(wait_for(lambda: self.eve.seen.count(1) >= 6 and self.eve.seen.count(2) >= 6))
        self.assertEqual(bridge.counters["dropped"], 0)
        # eve is up again but still refuses update 1: now it is the update's fault.
        self.eve.healthy = True
        self.assertTrue(wait_for(lambda: bridge.counters["dropped"] == 2))
        self.assertTrue(wait_for(lambda: self.saved()["offset"] == 3))

    def test_eve_flapping_between_attempts_resets_the_count(self):
        bridge = tg_bridge.Bridge(self.settings())
        self.addCleanup(bridge.pool.shutdown)
        answers = iter([500, 500, 500, 500, 500, 200])
        health = iter([True, True, False, True, True])
        bridge.deliver = lambda body: next(answers)
        bridge.eve_alive = lambda: next(health)
        with bridge.lock:
            bridge.pending[1] = time.monotonic()
        self.assertTrue(bridge.deliver_one(message(1, 1)))
        self.assertEqual(bridge.counters["dropped"], 0)
        self.assertEqual(bridge.counters["delivered"], 1)

    def test_an_update_eve_cannot_be_given_does_not_stop_the_bridge(self):
        # Half an emoji (a cut name): Telegram sends a lone surrogate escape.
        update = json.loads('{"update_id": 1, "message": {"message_id": 1, "chat": {"id": 1}, "text": "a\\ud83d"}}')
        self.telegram.add(update, message(2, 2))
        bridge = self.start()
        self.assertTrue(wait_for(lambda: sorted(self.eve.taken_ids()) == [1, 2]))
        self.assertIsNone(bridge.fatal)

    def test_a_bridge_error_on_one_update_drops_it_alone(self):
        def deliver(body):
            if json.loads(body)["update_id"] == 1:
                raise ValueError("odd")
            return tg_bridge.post_to_eve(self.eve.url, SECRET, body)

        self.telegram.add(message(1, 1), message(2, 2), message(3, 1))
        bridge = self.start(deliver=deliver)
        self.assertTrue(wait_for(lambda: sorted(self.eve.taken_ids()) == [2, 3]))
        self.assertEqual(bridge.counters["dropped"], 1)
        self.assertIsNone(bridge.fatal)
        self.assertFalse(bridge.stop.is_set())

    def test_the_next_message_after_a_delivery_is_not_delayed(self):
        # A long busy pause must not hold the next message once the queue is empty again.
        bridge = self.start(self.settings(TG_BRIDGE_BUSY_POLL_S="2", TG_BRIDGE_POLL_TIMEOUT="5"))
        for update_id in range(1, 4):
            self.telegram.add(message(update_id, 1))
            self.assertTrue(wait_for(lambda: update_id in self.eve.taken_ids()))
            time.sleep(0.2)
        started = time.monotonic()
        self.telegram.add(message(4, 1))
        self.assertTrue(wait_for(lambda: 4 in self.eve.taken_ids()))
        self.assertLess(time.monotonic() - started, 1)
        self.assertTrue(wait_for(lambda: bridge.counters["delivered"] == 4))

    def test_a_state_write_failure_keeps_delivering(self):
        bridge = self.start()
        with mock.patch.object(tg_bridge.os, "replace", side_effect=OSError(28, "No space left on device")):
            self.telegram.add(message(1, 1), message(2, 2))
            self.assertTrue(wait_for(lambda: sorted(self.eve.taken_ids()) == [1, 2]))
            self.assertTrue(wait_for(lambda: bridge.counters["stateWriteErrors"] >= 2))
            time.sleep(0.3)
        self.assertEqual(self.logged().count("cannot write"), 1)
        self.assertIsNone(bridge.fatal)
        # Nothing went to eve twice, and the next write catches the file up.
        self.telegram.add(message(3, 3))
        self.assertTrue(wait_for(lambda: self.saved() == {"offset": 4, "done": []}))
        self.assertEqual(sorted(self.eve.taken_ids()), [1, 2, 3])

    def test_wrong_secret_waits_and_drops_nothing(self):
        self.eve.script[1] = [401] * 3
        self.telegram.add(message(1, 1))
        bridge = self.start(self.settings(TG_BRIDGE_ATTEMPTS="1"))
        self.assertTrue(wait_for(lambda: bridge.eve_refused == 401))
        healthy, body = bridge.health()
        self.assertFalse(healthy)
        self.assertEqual(body["eveRefused"], 401)
        self.assertTrue(wait_for(lambda: self.eve.taken_ids() == [1], timeout=5))
        self.assertEqual(bridge.counters["dropped"], 0)
        self.assertIsNone(bridge.eve_refused)
        self.assertNotIn(SECRET, self.logged())


class Restart(BridgeCase):
    def test_restart_neither_repeats_nor_loses(self):
        self.eve.script[1] = [500] * 1000
        self.telegram.add(message(1, 1), message(2, 2), message(3, 3))
        first = self.start(self.settings(TG_BRIDGE_ATTEMPTS="1000"))
        self.assertTrue(wait_for(lambda: sorted(self.eve.taken_ids()) == [2, 3]))
        self.assertTrue(wait_for(lambda: self.saved() == {"offset": 1, "done": [2, 3]}))
        bridge, thread = self.bridges.pop()
        self.stop(bridge, thread)
        self.assertIs(bridge, first)
        # eve recovers; the new process starts from the file: 1 is delivered, 2 and 3 are not again.
        self.eve.script[1] = []
        self.start()
        self.assertTrue(wait_for(lambda: self.saved() == {"offset": 4, "done": []}))
        self.assertEqual(sorted(self.eve.taken_ids()), [1, 2, 3])

    def test_unreadable_state_is_set_aside(self):
        path = Path(self.dir.name) / "state.json"
        path.write_text("{broken")
        self.telegram.add(message(1, 1))
        self.start()
        self.assertTrue(wait_for(lambda: self.eve.taken_ids() == [1]))
        self.assertEqual((Path(self.dir.name) / "state.json.bad").read_text(), "{broken")
        self.assertIn("unreadable state", self.logged())

    def test_another_bots_state_is_not_used(self):
        # A rehearsal on the test bot left its offset; the real bot's ids are lower.
        path = Path(self.dir.name) / "state.json"
        path.write_text(json.dumps({"bot": tg_bridge.bot_fingerprint("999:other"), "offset": 500, "done": [502]}))
        self.telegram.add(message(10, 1))
        self.start()
        self.assertTrue(wait_for(lambda: self.eve.taken_ids() == [10]))
        expected = {"bot": tg_bridge.bot_fingerprint(TOKEN), "offset": 11, "done": []}
        self.assertTrue(wait_for(lambda: json.loads(path.read_text()) == expected))
        self.assertNotIn(TOKEN.split(":")[1], path.read_text())
        self.assertIn("another bot", self.logged())

    def test_a_state_without_a_bot_is_taken_as_this_bots(self):
        path = Path(self.dir.name) / "state.json"
        path.write_text(json.dumps({"offset": 7, "done": []}))
        self.assertEqual(tg_bridge.Bridge(self.settings()).state.offset, 7)


class Conflicts(BridgeCase):
    def test_a_webhook_stops_polling_without_a_loop(self):
        self.telegram.webhook = "https://bro-next.vercel.app/eve/v1/telegram?x=secret"
        bridge = self.start()
        time.sleep(1.2)
        self.assertNotIn("getUpdates", self.telegram.calls)
        self.assertLessEqual(self.telegram.calls.count("getWebhookInfo"), 4)
        self.assertEqual(bridge.status, "webhook-set")
        self.assertIn("bro-next.vercel.app/eve/v1/telegram", self.logged())
        self.assertNotIn("secret", self.logged())
        # Removed by hand: polling starts on the next look.
        self.telegram.webhook = ""
        self.telegram.add(message(5, 1))
        self.assertTrue(wait_for(lambda: self.eve.taken_ids() == [5]))

    def test_409_pauses(self):
        self.telegram.conflict = True
        bridge = self.start()
        time.sleep(1.2)
        self.assertLessEqual(self.telegram.calls.count("getUpdates"), 4)
        self.assertEqual(bridge.status, "conflict")
        self.assertIn("409", self.logged())
        self.assertFalse(bridge.health()[0])
        self.telegram.conflict = False
        self.telegram.add(message(1, 1))
        self.assertTrue(wait_for(lambda: self.eve.taken_ids() == [1]))
        self.assertTrue(wait_for(lambda: bridge.health()[0]))


class Health(BridgeCase):
    def test_an_update_waiting_too_long_is_unhealthy(self):
        bridge = self.start(self.settings(TG_BRIDGE_EVE_URL="http://127.0.0.1:9/eve/v1/telegram",
                                          TG_BRIDGE_STUCK_S="0.5"))
        self.telegram.add(message(1, 1))
        self.assertTrue(wait_for(lambda: bridge.counters["deliveryRetries"] >= 1))
        self.assertTrue(wait_for(lambda: not bridge.health()[0] and bridge.health()[1]["oldestPendingAgeS"] > 0.5))
        self.assertEqual(bridge.health()[1]["status"], "polling")

    def test_backoff_never_overflows(self):
        bridge = tg_bridge.Bridge(self.settings())
        self.addCleanup(bridge.pool.shutdown)
        self.assertEqual(bridge.backoff(5000), bridge.settings.retry_max)
        self.assertEqual(bridge.backoff(1), bridge.settings.retry_base)

    def test_telegram_out_of_reach_backs_off_and_logs_little(self):
        bridge = self.start(self.settings(TG_BRIDGE_API="http://127.0.0.1:9", TG_BRIDGE_RETRY_MAX_S="0.2"))
        self.assertTrue(wait_for(lambda: bridge.telegram_failures >= 5))
        self.assertEqual(self.logged().count("getWebhookInfo failed"), 1)
        self.assertEqual(bridge.status, "telegram-unreachable")

    def test_health_endpoint(self):
        bridge = self.start()
        server = tg_bridge.serve_health(bridge, "127.0.0.1:0")
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.assertTrue(wait_for(lambda: bridge.health()[0]))
        connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
        self.addCleanup(connection.close)
        connection.request("GET", "/health")
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.read())["status"], "polling")


class Switch(BridgeCase):
    def test_switch_to_bridge_keeps_pending_and_starts(self):
        self.telegram.webhook = "https://bro-next.vercel.app/eve/v1/telegram"
        settings = self.settings()
        telegram = tg_bridge.Telegram(TOKEN, self.telegram.url)
        self.addCleanup(telegram.close)
        with mock.patch.object(tg_bridge, "systemctl", return_value=0) as systemctl, \
                mock.patch.object(tg_bridge, "command_check", return_value=0), \
                mock.patch("builtins.print"):
            self.assertEqual(tg_bridge.command_switch_to_bridge(settings, telegram), 0)
        systemctl.assert_called_once_with("enable", "--now", "bro-tg-bridge.service")
        self.assertEqual(self.telegram.webhook, "")
        self.assertIn("deleteWebhook", self.telegram.calls)

    def test_switch_to_webhook_stops_bridge_and_confirms_first(self):
        settings = self.settings()
        # The stopped bridge delivered 1 and 2; Telegram has not heard of it yet.
        self.telegram.add(message(1, 1), message(2, 1), message(3, 1))
        Path(settings.state).write_text(json.dumps({"bot": tg_bridge.bot_fingerprint(TOKEN), "offset": 3,
                                                    "done": []}))
        telegram = tg_bridge.Telegram(TOKEN, self.telegram.url)
        self.addCleanup(telegram.close)
        order = []
        self.telegram.calls = order
        with mock.patch.object(tg_bridge, "systemctl", side_effect=lambda *a: order.append(a) or 0), \
                mock.patch("builtins.print"):
            url = "https://bro-next.vercel.app/eve/v1/telegram"
            self.assertEqual(tg_bridge.command_switch_to_webhook(settings, telegram, url), 0)
        self.assertEqual(order[0], ("disable", "--now", "bro-tg-bridge.service"))
        self.assertEqual(order[1:], ["getUpdates", "setWebhook", "getWebhookInfo"])
        self.assertEqual(self.telegram.offsets, [3])
        self.assertEqual([u["update_id"] for u in self.telegram.pending()], [3])
        self.assertEqual(self.telegram.set_body, {"url": url, "secret_token": SECRET,
                                                  "allowed_updates": ["message", "callback_query"],
                                                  "drop_pending_updates": False})

    def test_switch_to_webhook_brings_the_bridge_back_when_telegram_fails(self):
        telegram = tg_bridge.Telegram(TOKEN, "http://127.0.0.1:9")
        self.addCleanup(telegram.close)
        calls = []
        with mock.patch.object(tg_bridge, "systemctl", side_effect=lambda *a: calls.append(a) or 0), \
                mock.patch("builtins.print"):
            code = tg_bridge.command_switch_to_webhook(
                self.settings(), telegram, "https://bro-next.vercel.app/eve/v1/telegram")
        self.assertEqual(code, 1)
        self.assertEqual(calls, [("disable", "--now", "bro-tg-bridge.service"),
                                 ("enable", "--now", "bro-tg-bridge.service")])

    def test_switch_to_webhook_refuses_other_paths(self):
        telegram = tg_bridge.Telegram(TOKEN, self.telegram.url)
        self.addCleanup(telegram.close)
        with mock.patch.object(tg_bridge, "systemctl") as systemctl, mock.patch("builtins.print"):
            code = tg_bridge.command_switch_to_webhook(self.settings(), telegram, "https://bro.example/api")
        self.assertEqual(code, tg_bridge.CONFIG_EXIT)
        systemctl.assert_not_called()
        self.assertEqual(self.telegram.calls, [])


class Pieces(unittest.TestCase):
    def test_settings_refuse_a_secret_telegram_would_not_take(self):
        settings = tg_bridge.Settings({"TELEGRAM_BOT_TOKEN": TOKEN, "TELEGRAM_WEBHOOK_SECRET_TOKEN": "a b\n"})
        self.assertEqual(len(settings.problems()), 1)
        self.assertEqual(settings.problems(eve=False), [])

    def test_run_refuses_without_a_usable_secret(self):
        settings = tg_bridge.Settings({"TELEGRAM_BOT_TOKEN": TOKEN})
        with mock.patch.object(tg_bridge, "log") as log, mock.patch.object(tg_bridge, "Bridge") as bridge:
            self.assertEqual(tg_bridge.command_run(settings), tg_bridge.CONFIG_EXIT)
        bridge.assert_not_called()
        self.assertIn("TELEGRAM_WEBHOOK_SECRET_TOKEN", log.call_args.args[0])

    def test_switch_commands_read_the_env_files(self):
        with tempfile.TemporaryDirectory() as directory:
            env = Path(directory) / "env"
            env.write_text(f'TELEGRAM_BOT_TOKEN="{TOKEN}"\nTG_BRIDGE_PARALLEL="3"\n')
            with mock.patch.dict("os.environ", {"TG_BRIDGE_PARALLEL": "4"}, clear=True):
                merged = tg_bridge.environment([str(env), str(Path(directory) / "missing")])
        self.assertEqual(merged["TELEGRAM_BOT_TOKEN"], TOKEN)
        self.assertEqual(merged["TG_BRIDGE_PARALLEL"], "4")

    def test_env_file(self):
        values = tg_bridge.parse_env('# c\nA="x\\"y"\nB=plain\nC=\'q\'\n')
        self.assertEqual(values, {"A": 'x"y', "B": "plain", "C": "q"})

    def test_proxy_forms(self):
        self.assertEqual(tg_bridge.proxy_from("host:1:u:p:q")[:2], ("host", 1))
        self.assertEqual(tg_bridge.proxy_from("http://" + "u" + ":" + "p" + "@h:8080")[2], "Basic dTpw")
        self.assertIsNone(tg_bridge.proxy_from(""))
        with self.assertRaises(ValueError):
            tg_bridge.proxy_from("socks5://h:1")

    def test_chat_keys(self):
        self.assertEqual(tg_bridge.chat_key(message(1, 42)), "chat:42")
        self.assertEqual(tg_bridge.chat_key({"update_id": 2, "callback_query": {"from": {"id": 5}}}), "user:5")
        self.assertEqual(tg_bridge.chat_key({"update_id": 3, "callback_query": {
            "from": {"id": 5}, "message": {"chat": {"id": 9}}}}), "chat:9")

    def test_errors_never_carry_the_token(self):
        telegram = tg_bridge.Telegram(TOKEN, "http://127.0.0.1:9")
        with self.assertRaises(tg_bridge.NetworkError) as caught:
            telegram.call("getMe", timeout=2)
        self.assertNotIn(TOKEN, str(caught.exception))


if __name__ == "__main__":
    unittest.main()
