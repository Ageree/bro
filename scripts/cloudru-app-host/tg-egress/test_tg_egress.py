"""tg-egress tests: cd scripts/cloudru-app-host/tg-egress && python3 -m unittest (stdlib only, Python 3.10).

A dropped SYN, as Cloud.ru drops it on the way to Telegram, is a listener with a full backlog: Linux drops
the SYN and the connect hangs. A refused port fails at once; an echo server stands in for Telegram.
"""

import asyncio
import base64
import contextlib
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import tg_egress  # noqa: E402

HERE = Path(__file__).parent


def blackhole():
    """A local address whose connects hang: one queued connection fills a backlog of 0."""
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(0)
    filler = socket.socket()
    filler.connect(server.getsockname())
    return server, filler, f"127.0.0.1:{server.getsockname()[1]}"


def refused():
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return f"127.0.0.1:{port}"


def config(**values):
    environ = {"TG_EGRESS_LISTEN": "127.0.0.1:0", "TG_EGRESS_HEALTH": "127.0.0.1:0",
               "TG_EGRESS_ATTEMPT_MS": "1000", "TG_EGRESS_STAGGER_MS": "100", "TG_EGRESS_DEADLINE_MS": "3000"}
    environ.update(values)
    return tg_egress.Config(environ)



def with_login(user, password, address):
    """A proxy URL with a login, built from parts so it never reads as a stored credential."""
    return "http://" + user + ":" + password + "@" + address

class Harness:
    """The forwarder on an ephemeral port, an echo upstream, a client that sends a line and reads it back."""

    def __init__(self):
        self.closers = []

    async def echo(self):
        async def handle(reader, writer):
            while data := await reader.read(65536):
                writer.write(data)
                await writer.drain()
            writer.close()

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        self.closers.append(server)
        return f"127.0.0.1:{server.sockets[0].getsockname()[1]}"

    async def forwarder(self, cfg):
        forwarder = tg_egress.Forwarder(cfg)
        server = await asyncio.start_server(forwarder.handle, "127.0.0.1", 0)
        self.closers.append(server)
        return forwarder, server.sockets[0].getsockname()[1]

    async def roundtrip(self, port, payload=b"hello telegram\n", timeout=10):
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(payload)
        await writer.drain()
        writer.write_eof()
        data = await asyncio.wait_for(reader.read(), timeout)
        writer.close()
        return data

    def close(self):
        for server in self.closers:
            server.close()


class ParseTest(unittest.TestCase):
    def test_addresses(self):
        self.assertEqual(tg_egress.address("149.154.167.220"), ("149.154.167.220", 443))
        self.assertEqual(tg_egress.address("149.154.167.220:8443"), ("149.154.167.220", 8443))
        self.assertEqual(tg_egress.address("[2001:db8::1]:443"), ("2001:db8::1", 443))
        cfg = config(TG_EGRESS_UPSTREAMS="149.154.167.220, 149.154.167.221:443")
        self.assertEqual(cfg.upstreams, [("149.154.167.220", 443), ("149.154.167.221", 443)])

    def test_a_stagger_of_zero_is_refused(self):
        # Zero would retry an address that refuses at once in a tight loop.
        for value in ("0", "-300"):
            with self.subTest(value), self.assertRaises(ValueError) as caught:
                config(TG_EGRESS_STAGGER_MS=value)
            self.assertIn("TG_EGRESS_STAGGER_MS", str(caught.exception))

    def test_an_ipv6_address_keeps_its_brackets(self):
        self.assertEqual(tg_egress.authority("2001:db8::1", 443), "[2001:db8::1]:443")
        self.assertEqual(tg_egress.authority("api.telegram.org", 443), "api.telegram.org:443")
        self.assertEqual(tg_egress.address(tg_egress.authority("2001:db8::1", 8443)), ("2001:db8::1", 8443))

    def test_default_upstream_is_the_address_that_answers_from_cloudru(self):
        self.assertEqual(tg_egress.Config({}).upstreams, [("149.154.167.220", 443)])
        self.assertIsNone(tg_egress.Config({}).proxy)

    def test_proxy_forms(self):
        host, port, auth = tg_egress.proxy_from("proxy.example:9000:user-type-x:pa:ss")
        self.assertEqual((host, port), ("proxy.example", 9000))
        self.assertEqual(base64.b64decode(auth.split()[1]).decode(), "user-type-x:pa:ss")
        host, port, auth = tg_egress.proxy_from(with_login("u%40x", "p%3Aw", "proxy.example:10000"))
        self.assertEqual((host, port), ("proxy.example", 10000))
        self.assertEqual(base64.b64decode(auth.split()[1]).decode(), "u@x:p:w")
        self.assertIsNone(tg_egress.proxy_from(""))
        with self.assertRaises(ValueError):
            tg_egress.proxy_from("socks5://proxy.example:1080")

    def test_a_malformed_proxy_never_quotes_the_password(self):
        for text in (with_login("u", "s3cr/et", "h:3128"), with_login("u", "s3cr#et", "h:3128"),
                     with_login("u", "s3cr?et", "h:3128")):
            with self.assertRaises(ValueError) as caught:
                tg_egress.proxy_from(text)
            self.assertNotIn("s3cr", str(caught.exception))
            self.assertTrue(caught.exception.__suppress_context__)
            out, err = io.StringIO(), io.StringIO()
            with mock.patch.dict(os.environ, {"TG_EGRESS_PROXY": text}), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                self.assertEqual(tg_egress.main([]), 2)
            self.assertNotIn("s3cr", out.getvalue() + err.getvalue())


class ForwardTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness()
        self.addCleanup(self.h.close)

    def hole(self):
        server, filler, address = blackhole()
        self.addCleanup(server.close)
        self.addCleanup(filler.close)
        return address

    async def test_bytes_pass_through_both_ways(self):
        good = await self.h.echo()
        forwarder, port = await self.h.forwarder(config(TG_EGRESS_UPSTREAMS=good))
        payload = os.urandom(300_000)
        self.assertEqual(await self.h.roundtrip(port, payload), payload)
        self.assertEqual(forwarder.stats.paths[good]["won"], 1)

    async def test_a_dropped_syn_is_raced_by_the_next_attempt(self):
        # The first attempt hangs as on Cloud.ru; the staggered second one opens and wins long before the
        # first one's timeout.
        hole, good = self.hole(), await self.h.echo()
        forwarder, port = await self.h.forwarder(config(TG_EGRESS_UPSTREAMS=f"{hole},{good}"))
        began = time.monotonic()
        self.assertEqual(await self.h.roundtrip(port), b"hello telegram\n")
        self.assertLess(time.monotonic() - began, 0.9)
        self.assertEqual(forwarder.stats.paths[good]["won"], 1)
        # The winner goes first next time: no wait at all.
        began = time.monotonic()
        self.assertEqual(await self.h.roundtrip(port), b"hello telegram\n")
        self.assertLess(time.monotonic() - began, 0.09)

    async def test_an_ipv6_upstream_wins_and_goes_first_next_time(self):
        # 2001:db8::7 is dialed at the echo server: not every test machine has IPv6.
        echo_port = tg_egress.address(await self.h.echo())[1]
        good = f"[2001:db8::7]:{echo_port}"
        dial = tg_egress.open_direct

        async def direct(host, port, timeout):
            return await dial("127.0.0.1" if host == "2001:db8::7" else host, port, timeout)

        forwarder, port = await self.h.forwarder(config(TG_EGRESS_UPSTREAMS=f"{refused()},{good}"))
        with mock.patch.object(tg_egress, "open_direct", direct):
            self.assertEqual(await self.h.roundtrip(port), b"hello telegram\n")
        self.assertEqual(forwarder.stats.paths[good]["won"], 1)
        self.assertEqual(forwarder.turn, 1)

    async def test_a_refused_address_moves_on_at_once(self):
        good = await self.h.echo()
        forwarder, port = await self.h.forwarder(
            config(TG_EGRESS_UPSTREAMS=f"{refused()},{good}", TG_EGRESS_STAGGER_MS="2000"))
        began = time.monotonic()
        self.assertEqual(await self.h.roundtrip(port), b"hello telegram\n")
        self.assertLess(time.monotonic() - began, 0.5)

    async def test_a_refusing_address_is_retried_at_a_bounded_rate(self):
        # RST at once (a closed port, a REJECT, a VM without network): never a tight loop of SYNs.
        forwarder, port = await self.h.forwarder(config(
            TG_EGRESS_UPSTREAMS=refused(), TG_EGRESS_DEADLINE_MS="1000", TG_EGRESS_STAGGER_MS="300"))
        self.assertEqual(await self.h.roundtrip(port), b"")
        self.assertLessEqual(forwarder.stats.attempts, 1.0 / tg_egress.FIRST_RETRY + 3)
        self.assertGreaterEqual(forwarder.stats.attempts, 3)

    async def test_down_fails_fast_and_says_so_once(self):
        cfg = config(TG_EGRESS_UPSTREAMS=self.hole(), TG_EGRESS_DEADLINE_MS="800", TG_EGRESS_ATTEMPT_MS="200",
                     TG_EGRESS_DOWN_AFTER="2", TG_EGRESS_DOWN_DEADLINE_MS="300")
        forwarder, port = await self.h.forwarder(cfg)
        lines = []
        with mock.patch.object(tg_egress, "log", lines.append):
            for _ in range(2):
                self.assertEqual(await self.h.roundtrip(port), b"")
            self.assertTrue(forwarder.stats.down)
            self.assertFalse(forwarder.stats.snapshot(cfg)["ok"])
            began = time.monotonic()
            self.assertEqual(await self.h.roundtrip(port), b"")
            self.assertLess(time.monotonic() - began, 0.7)
            # The way opens again: the next connection gets through and ends the state.
            good = await self.h.echo()
            cfg.upstreams = [tg_egress.address(good)]
            forwarder.stats.paths[good] = {"opened": 0, "failed": 0, "won": 0}
            self.assertEqual(await self.h.roundtrip(port), b"hello telegram\n")
        self.assertFalse(forwarder.stats.down)
        self.assertEqual([line for line in lines if line.startswith("upstream")][0][:13], "upstream down")
        self.assertEqual([line for line in lines if line.startswith("upstream")][1:], ["upstream back"])

    async def test_a_silent_connection_is_closed(self):
        forwarder, port = await self.h.forwarder(config(
            TG_EGRESS_UPSTREAMS=await self.h.echo(), TG_EGRESS_IDLE_S="0.3"))
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        self.addCleanup(writer.close)
        self.assertEqual(await asyncio.wait_for(reader.read(), 3), b"")
        await asyncio.sleep(0.05)
        self.assertEqual(forwarder.stats.active, 0)

    async def test_the_other_side_gets_only_the_linger_after_one_closes(self):
        # Telegram's side never answers nor closes (a flow the network lost): once the client is gone, the
        # forwarder lets go after LINGER_S instead of holding both sockets until keepalive gives up.
        async def mute(reader, writer):
            await asyncio.sleep(30)

        server = await asyncio.start_server(mute, "127.0.0.1", 0)
        self.h.closers.append(server)
        forwarder, port = await self.h.forwarder(config(
            TG_EGRESS_UPSTREAMS=f"127.0.0.1:{server.sockets[0].getsockname()[1]}", TG_EGRESS_LINGER_S="0.3"))
        self.assertEqual(await self.h.roundtrip(port, timeout=3), b"")
        await asyncio.sleep(0.05)
        self.assertEqual(forwarder.stats.active, 0)

    async def test_connections_over_the_cap_are_closed_at_once(self):
        forwarder, port = await self.h.forwarder(config(
            TG_EGRESS_UPSTREAMS=await self.h.echo(), TG_EGRESS_MAX_CONNECTIONS="1"))
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        self.addCleanup(writer.close)
        writer.write(b"x")
        self.assertEqual(await asyncio.wait_for(reader.read(1), 3), b"x")
        try:
            self.assertEqual(await self.h.roundtrip(port, timeout=3), b"")
        except ConnectionResetError:
            pass  # closed with the client's bytes unread: a reset, as good as a close
        self.assertEqual(forwarder.stats.refused, 1)

    async def test_check_by_name_fails_without_the_hosts_line(self):
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            self.assertFalse(await tg_egress.check(config(TG_EGRESS_TARGET="localhost:443")))
        self.assertIn("not 127.77.0.1", printed.getvalue())

    async def test_no_upstream_by_the_deadline_closes_the_client(self):
        forwarder, port = await self.h.forwarder(config(
            TG_EGRESS_UPSTREAMS=self.hole(), TG_EGRESS_DEADLINE_MS="600", TG_EGRESS_ATTEMPT_MS="200",
            TG_EGRESS_STAGGER_MS="100", TG_EGRESS_PARALLEL="2"))
        self.assertEqual(await self.h.roundtrip(port), b"")
        self.assertEqual(forwarder.stats.failed, 1)
        self.assertGreaterEqual(forwarder.stats.paths[forwarder.config.upstreams[0][0] + ":"
                                                     + str(forwarder.config.upstreams[0][1])]["failed"], 2)
        self.assertFalse(forwarder.stats.snapshot(forwarder.config)["ok"])

    async def test_the_proxy_joins_when_direct_attempts_hang(self):
        good = await self.h.echo()
        seen = []

        async def proxy(reader, writer):
            head = (await reader.readuntil(b"\r\n\r\n")).decode()
            seen.append(head)
            if "Proxy-Authorization: Basic " + base64.b64encode(b"user:secret").decode() not in head:
                writer.write(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                writer.close()
                return
            host, port = tg_egress.address(good)
            up_reader, up_writer = await asyncio.open_connection(host, port)
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await asyncio.gather(tg_egress.pipe(reader, up_writer), tg_egress.pipe(up_reader, writer))
            up_writer.close()
            writer.close()

        server = await asyncio.start_server(proxy, "127.0.0.1", 0)
        self.h.closers.append(server)
        proxy_port = server.sockets[0].getsockname()[1]
        forwarder, port = await self.h.forwarder(config(
            TG_EGRESS_UPSTREAMS=self.hole(), TG_EGRESS_PROXY=f"127.0.0.1:{proxy_port}:user:secret",
            TG_EGRESS_PROXY_AFTER_MS="150"))
        self.assertEqual(await self.h.roundtrip(port), b"hello telegram\n")
        self.assertTrue(seen[0].startswith("CONNECT api.telegram.org:443 HTTP/1.1\r\n"))
        self.assertEqual(forwarder.stats.paths["proxy"]["won"], 1)
        snapshot = json.dumps(forwarder.stats.snapshot(forwarder.config))
        self.assertNotIn("secret", snapshot)
        self.assertNotIn(base64.b64encode(b"user:secret").decode(), snapshot)

    async def test_the_proxy_is_asked_for_an_ipv6_target_in_brackets(self):
        seen = []

        async def proxy(reader, writer):
            seen.append((await reader.readuntil(b"\r\n\r\n")).decode())
            writer.write(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            writer.close()

        server = await asyncio.start_server(proxy, "127.0.0.1", 0)
        self.h.closers.append(server)
        cfg = config(TG_EGRESS_PROXY=f"127.0.0.1:{server.sockets[0].getsockname()[1]}",
                     TG_EGRESS_TARGET="[2001:db8::1]:443")
        with self.assertRaises(ConnectionError):
            await tg_egress.open_proxy(cfg, 3)
        self.assertTrue(seen[0].startswith("CONNECT [2001:db8::1]:443 HTTP/1.1\r\nHost: [2001:db8::1]:443\r\n"))

    async def test_tells_systemd_it_is_ready_once_it_listens(self):
        # Type=notify: bro-web and bro-eve, ordered after the unit, start only once both listeners are bound.
        name = f"bro-tg-egress-test-{os.getpid()}-{id(self)}"
        notify = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        self.addCleanup(notify.close)
        notify.bind("\0" + name)
        notify.setblocking(False)
        listen, health = refused(), refused()
        cfg = config(TG_EGRESS_UPSTREAMS=await self.h.echo(), TG_EGRESS_LISTEN=listen, TG_EGRESS_HEALTH=health)
        with mock.patch.dict(os.environ, {"NOTIFY_SOCKET": "@" + name}), mock.patch.object(tg_egress, "log"):
            serving = asyncio.ensure_future(tg_egress.Forwarder(cfg).serve())
            try:
                message = await asyncio.wait_for(asyncio.get_running_loop().sock_recv(notify, 64), 5)
                for where in (listen, health):
                    _reader, writer = await asyncio.open_connection(*tg_egress.address(where))
                    writer.close()
            finally:
                serving.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await serving
        self.assertEqual(message, b"READY=1")

    async def test_a_proxy_refusal_is_a_failed_attempt(self):
        async def proxy(reader, writer):
            await reader.readuntil(b"\r\n\r\n")
            writer.write(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            writer.close()

        server = await asyncio.start_server(proxy, "127.0.0.1", 0)
        self.h.closers.append(server)
        forwarder, port = await self.h.forwarder(config(
            TG_EGRESS_UPSTREAMS=self.hole(), TG_EGRESS_DEADLINE_MS="800",
            TG_EGRESS_PROXY=f"127.0.0.1:{server.sockets[0].getsockname()[1]}", TG_EGRESS_PROXY_AFTER_MS="50"))
        self.assertEqual(await self.h.roundtrip(port), b"")
        self.assertEqual(forwarder.stats.paths["proxy"]["failed"], 1)

    async def test_health_answers_json(self):
        cfg = config(TG_EGRESS_UPSTREAMS=await self.h.echo())
        forwarder = tg_egress.Forwarder(cfg)
        server = await asyncio.start_server(forwarder.health, "127.0.0.1", 0)
        self.h.closers.append(server)
        reader, writer = await asyncio.open_connection("127.0.0.1", server.sockets[0].getsockname()[1])
        self.addCleanup(writer.close)
        writer.write(b"GET /health HTTP/1.1\r\nHost: x\r\n\r\n")
        raw = await reader.read()
        head, body = raw.split(b"\r\n\r\n", 1)
        self.assertTrue(head.startswith(b"HTTP/1.1 200 OK"))
        self.assertEqual(json.loads(body)["connections"], 0)


class SetupTest(unittest.TestCase):
    """setup.sh against a scratch hosts file and an iptables that keeps its nat OUTPUT rules in a file."""

    FAKE_IPTABLES = r"""#!/bin/bash
rules="$(dirname "$0")/rules"; touch "$rules"
echo "$*" >> "$(dirname "$0")/calls"
shift 3  # -w -t nat
op=$1; shift 2  # the op and the chain
rule="-A OUTPUT $*"
case $op in
  -S) echo "-P OUTPUT ACCEPT"; sed 's/--dport/-m tcp --dport/' "$rules" ;;
  -C) grep -qxF -- "$rule" "$rules" ;;
  -A) echo "$rule" >> "$rules" ;;
  -D) grep -qxF -- "$rule" "$rules" || exit 1
      awk -v r="$rule" '!d && $0 == r { d = 1; next } { print }' "$rules" > "$rules.new"; mv "$rules.new" "$rules" ;;
esac
"""

    def run_setup(self, *args, hosts="127.0.0.1 localhost\n149.154.166.110 api.telegram.org\n", rules="",
                  environ=None, directory=None):
        if directory is None:
            directory = Path(tempfile.mkdtemp())
            self.addCleanup(shutil.rmtree, directory, True)
            (directory / "hosts").write_text(hosts)
            (directory / "rules").write_text(rules)
            fake = directory / "iptables"
            fake.write_text(self.FAKE_IPTABLES)
            fake.chmod(0o755)
            script = (HERE / "setup.sh").read_text().replace("/etc/hosts", str(directory / "hosts"))
            (directory / "setup.sh").write_text(script)
        env = dict(os.environ, PATH=f"{directory}:{os.environ['PATH']}")
        env.pop("TG_EGRESS_LISTEN", None)
        env.update(environ or {})
        subprocess.run(["bash", str(directory / "setup.sh"), *args], check=True, env=env, capture_output=True)
        return directory

    def read(self, directory):
        return (directory / "hosts").read_text(), (directory / "rules").read_text().splitlines()

    def rule(self, port):
        return f"-A OUTPUT -d 127.77.0.1/32 -p tcp --dport 443 -j REDIRECT --to-ports {port}"

    def test_points_the_name_at_the_redirect_once(self):
        hosts, rules = self.read(self.run_setup())
        self.assertEqual(rules, [self.rule(7443)])
        self.assertNotIn("149.154.166.110", hosts)  # an older line for the name would win over ours
        self.assertEqual(hosts.count("api.telegram.org"), 1)
        self.assertIn("127.77.0.1 api.telegram.org # bro-tg-egress\n", hosts)
        self.assertIn("127.0.0.1 localhost\n", hosts)

    def test_runs_again_without_a_second_line_or_rule(self):
        directory = self.run_setup(hosts="127.77.0.1 api.telegram.org # bro-tg-egress\n")
        self.run_setup(directory=directory)
        hosts, rules = self.read(directory)
        self.assertEqual(hosts.count("api.telegram.org"), 1)
        self.assertEqual(rules, [self.rule(7443)])

    def test_the_port_comes_from_the_listen_setting_and_an_old_rule_goes(self):
        hosts, rules = self.read(self.run_setup(rules=self.rule(7443) + "\n",
                                                environ={"TG_EGRESS_LISTEN": "127.0.0.1:7555"}))
        self.assertEqual(rules, [self.rule(7555)])

    def test_remove_takes_every_rule_and_the_line(self):
        directory = self.run_setup(rules=self.rule(7000) + "\n")
        self.run_setup("--remove", directory=directory)
        hosts, rules = self.read(directory)
        self.assertEqual(rules, [])
        self.assertNotIn("api.telegram.org", hosts)

    def test_a_shared_hosts_line_keeps_its_other_names(self):
        hosts, _ = self.read(self.run_setup(
            hosts="127.0.0.1 localhost api.telegram.org # mine\n149.154.166.110 api.telegram.org\n"
                  "# 1.2.3.4 api.telegram.org\n"))
        self.assertEqual(hosts, "127.0.0.1 localhost  # mine\n# 1.2.3.4 api.telegram.org\n"
                                "127.77.0.1 api.telegram.org # bro-tg-egress\n")

    def test_another_redirect_for_the_address_is_left_alone(self):
        other = "-A OUTPUT -d 127.77.0.1/32 -p tcp --dport 80 -j REDIRECT --to-ports 8080"
        directory = self.run_setup(rules=other + "\n" + self.rule(7000) + "\n")
        self.assertEqual(self.read(directory)[1], [other, self.rule(7443)])
        self.run_setup(directory=directory)  # nothing to change
        self.assertEqual(self.read(directory)[1], [other, self.rule(7443)])
        self.run_setup("--remove", directory=directory)
        self.assertEqual(self.read(directory)[1], [other])

    def test_a_port_out_of_range_is_refused_before_iptables(self):
        for port in ("0", "65536", "99999"):
            with self.subTest(port), self.assertRaises(subprocess.CalledProcessError) as caught:
                self.run_setup(port)
            self.assertEqual(caught.exception.returncode, 2)
        directory = self.run_setup("65535")
        self.assertEqual(self.read(directory)[1], [self.rule(65535)])

    def test_the_unit_takes_the_port_from_the_settings(self):
        unit = (HERE / "bro-tg-egress.service").read_text()
        self.assertIn("ExecStartPre=+/bin/bash /opt/bro/tg-egress/setup.sh\n", unit)
        self.assertIn("EnvironmentFile=-/etc/bro/tg-egress.env", unit)
        self.assertEqual(tg_egress.Config({}).listen, ("127.0.0.1", 7443))
        self.assertIn("DynamicUser=yes", unit)
        self.assertIn("\nType=notify\n", unit)
        self.assertIn("LimitNOFILE=", unit)


if __name__ == "__main__":
    unittest.main()
