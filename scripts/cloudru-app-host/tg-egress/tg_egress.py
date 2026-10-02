"""tg-egress: the way out to api.telegram.org from a Cloud.ru VM (Python 3.10 stdlib, README.md here).

From Cloud.ru the address DNS gives for api.telegram.org (149.154.166.110) takes no TCP connection at all,
and the one that does answer (149.154.167.220, the real api.telegram.org: its certificate) drops about one
SYN in six for good: a connection either opens in ~50 ms or never (probe of 02.10.2026). So the host's
/etc/hosts points api.telegram.org at 127.77.0.1, an iptables REDIRECT sends 127.77.0.1:443 here, and every
connection gets an upstream before a byte of it is read: a new attempt every STAGGER_MS (a new source port,
another chance) over the addresses in turn, the first one to open wins, the rest are closed. With
TG_EGRESS_PROXY set, an HTTP CONNECT through that proxy joins the race after PROXY_AFTER_MS. Bytes then pass
through untouched: TLS is end to end, SNI and the certificate are Telegram's, the bot token never shows here.

  python3 tg_egress.py           listen and forward (bro-tg-egress.service)
  python3 tg_egress.py --check            api.telegram.org by name, as a client would (hosts line, REDIRECT,
                                          forwarder, Telegram): exit 0 on success
  python3 tg_egress.py --check-listener   the same straight to TG_EGRESS_LISTEN, past the hosts line and REDIRECT

Settings (environment; the unit reads /etc/bro/tg-egress.env):
  TG_EGRESS_LISTEN        127.0.0.1:7443   where the REDIRECT lands (setup.sh takes the port from here too)
  TG_EGRESS_HEALTH        127.0.0.1:7444   GET /health: counters as JSON (no secrets)
  TG_EGRESS_UPSTREAMS     149.154.167.220  addresses (ip or ip:port, comma separated) tried in turn
  TG_EGRESS_ATTEMPT_MS    2000             one attempt's connect timeout
  TG_EGRESS_STAGGER_MS    300              a new attempt this often while none has opened
  TG_EGRESS_PARALLEL      3                at most this many attempts in flight for one connection
  TG_EGRESS_DEADLINE_MS   12000            no upstream by then: the client's connection is closed
  TG_EGRESS_PROXY         (unset)          http://<login>:<password>@<host>:<port> or host:port:user:pass
  TG_EGRESS_PROXY_AFTER_MS 1500            when the proxy joins the race
  TG_EGRESS_TARGET        api.telegram.org:443   what the proxy is asked to CONNECT to, and what --check calls
  TG_EGRESS_IDLE_S        180              a connection silent both ways this long is closed (long poll: 50 s)
  TG_EGRESS_LINGER_S      20               after one side closes, the other gets this long to finish
  TG_EGRESS_MAX_CONNECTIONS 256            more at once are closed straight away
  TG_EGRESS_DOWN_AFTER    5                this many searches in a row without an upstream: "down", see below

While down, a connection gets DOWN_DEADLINE_MS (4000) instead of DEADLINE_MS and the proxy, if set, joins at
once: a client learns fast that Telegram is unreachable, and every connection still tries, so the first one
to open ends the state. The change is logged once each way ("upstream down" / "upstream back").

The log has one line per connection: the path taken (an address or `proxy`), attempts, time to an upstream
and bytes. Never the proxy's credentials, never the traffic.
"""

import asyncio
import base64
import json
import os
import socket
import ssl
import sys
import time
import urllib.parse
from collections import deque

DEFAULT_UPSTREAMS = "149.154.167.220"
READ_CHUNK = 65536
REDIRECT_ADDRESS = "127.77.0.1"  # setup.sh's ADDRESS: the name api.telegram.org resolves to on the host
FIRST_RETRY = 0.05  # an attempt refused at once is retried after this, doubling up to STAGGER
DOWN_DEADLINE = 4.0


def setting(name, default):
    value = os.environ.get(name, "").strip()
    return value or default


def address(text, default_port=443):
    """'1.2.3.4' or '1.2.3.4:443' or '[::1]:443' -> (host, port)."""
    text = text.strip()
    if text.startswith("["):
        host, _, rest = text[1:].partition("]")
        return host, int(rest[1:]) if rest.startswith(":") else default_port
    host, sep, port = text.rpartition(":")
    if sep and port.isdigit() and host and ":" not in host:
        return host, int(port)
    return text, default_port


def authority(host, port):
    """(host, port) -> 'host:port', an IPv6 address in brackets: what address() reads back, and what CONNECT
    takes."""
    return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"


def proxy_from(text):
    """(host, port, authorization header value or None) from either proxy form; None when unset."""
    text = (text or "").strip()
    if not text:
        return None
    if "://" in text:
        # urllib's own errors quote the text (a password with '/', '#' or '?' becomes "the port"): never
        # let one reach the journal.
        try:
            parsed = urllib.parse.urlsplit(text)
            port = parsed.port
            valid = parsed.scheme == "http" and bool(parsed.hostname) and bool(port)
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("TG_EGRESS_PROXY must be http://<login>:<password>@<host>:<port> "
                             "(percent-encode '/', '#', '?' and '@' in the password)") from None
        user = urllib.parse.unquote(parsed.username or "")
        password = urllib.parse.unquote(parsed.password or "")
        host = parsed.hostname
    else:
        # host:port:user:pass, the form of BROWSER_VM_PROXY; the password may hold ':'.
        parts = text.split(":", 3)
        if len(parts) not in (2, 4) or not parts[1].isdigit():
            raise ValueError("TG_EGRESS_PROXY must be host:port:user:pass")
        host, port = parts[0], int(parts[1])
        user, password = (parts[2], parts[3]) if len(parts) == 4 else ("", "")
    auth = None
    if user or password:
        auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
    return host, port, auth


class Config:
    def __init__(self, environ=None):
        get = (lambda name, default: (environ or {}).get(name, default)) if environ is not None else setting
        self.listen = address(get("TG_EGRESS_LISTEN", "127.0.0.1:7443"), 7443)
        self.health = address(get("TG_EGRESS_HEALTH", "127.0.0.1:7444"), 7444)
        self.upstreams = [address(item) for item in get("TG_EGRESS_UPSTREAMS", DEFAULT_UPSTREAMS).split(",")
                          if item.strip()]
        if not self.upstreams:
            raise ValueError("TG_EGRESS_UPSTREAMS names no address")
        self.attempt = int(get("TG_EGRESS_ATTEMPT_MS", "2000")) / 1000
        self.stagger = int(get("TG_EGRESS_STAGGER_MS", "300")) / 1000
        if self.stagger <= 0:
            # Zero would send a new SYN as fast as the loop turns at an address that refuses them.
            raise ValueError("TG_EGRESS_STAGGER_MS must be a positive number of milliseconds")
        self.parallel = max(1, int(get("TG_EGRESS_PARALLEL", "3")))
        self.deadline = int(get("TG_EGRESS_DEADLINE_MS", "12000")) / 1000
        self.proxy = proxy_from(get("TG_EGRESS_PROXY", ""))
        self.proxy_after = int(get("TG_EGRESS_PROXY_AFTER_MS", "1500")) / 1000
        self.target = address(get("TG_EGRESS_TARGET", "api.telegram.org:443"))
        self.idle = float(get("TG_EGRESS_IDLE_S", "180"))
        self.linger = float(get("TG_EGRESS_LINGER_S", "20"))
        self.max_connections = max(1, int(get("TG_EGRESS_MAX_CONNECTIONS", "256")))
        self.down_after = max(1, int(get("TG_EGRESS_DOWN_AFTER", "5")))
        self.down_deadline = min(self.deadline, int(get("TG_EGRESS_DOWN_DEADLINE_MS", "4000")) / 1000)


class Stats:
    def __init__(self, upstreams):
        self.started = time.time()
        self.connections = 0
        self.failed = 0
        self.refused = 0  # over TG_EGRESS_MAX_CONNECTIONS
        self.failing = 0  # searches in a row without an upstream
        self.down = False
        self.active = 0
        self.attempts = 0
        self.recent = deque(maxlen=200)  # True/False per finished upstream search
        self.paths = {authority(h, p): {"opened": 0, "failed": 0, "won": 0} for h, p in upstreams}
        self.paths["proxy"] = {"opened": 0, "failed": 0, "won": 0}
        self.last_failure = None

    def snapshot(self, config):
        recent = list(self.recent)
        rate = sum(recent) / len(recent) if recent else None
        return {
            "ok": not self.down and (rate is None or rate >= 0.9),
            "uptimeS": round(time.time() - self.started),
            "connections": self.connections,
            "failed": self.failed,
            "refused": self.refused,
            "down": self.down,
            "active": self.active,
            "attempts": self.attempts,
            "recentSuccessRate": rate,
            "lastFailure": self.last_failure,
            "paths": self.paths,
            "proxyConfigured": config.proxy is not None,
        }


def log(message):
    print(message, flush=True)


async def open_direct(host, port, timeout):
    reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
    return reader, writer


async def open_proxy(config, timeout):
    """A tunnel to TG_EGRESS_TARGET through the HTTP proxy: CONNECT, then the bytes are the target's."""
    host, port, auth = config.proxy
    target = authority(*config.target)

    async def tunnel():
        reader, writer = await asyncio.open_connection(host, port)
        try:
            request = f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n"
            if auth:
                request += f"Proxy-Authorization: {auth}\r\n"
            writer.write((request + "\r\n").encode())
            await writer.drain()
            head = await reader.readuntil(b"\r\n\r\n")
            status = head.split(b"\r\n", 1)[0].split()
            if len(status) < 2 or status[1] != b"200":
                raise ConnectionError(f"proxy answered {status[1:2]!r}"[:80])
            return reader, writer
        except BaseException:
            writer.close()
            raise

    return await asyncio.wait_for(tunnel(), timeout)


class Forwarder:
    def __init__(self, config, stats=None):
        self.config = config
        self.stats = stats or Stats(config.upstreams)
        self.turn = 0  # where the next connection's first attempt starts

    def order(self):
        """Addresses in turn, starting from the one that won last, so a good one keeps getting the traffic."""
        ups = self.config.upstreams
        return [ups[(self.turn + i) % len(ups)] for i in range(len(ups))]

    async def upstream(self):
        """(reader, writer, path, attempts, seconds) of the first upstream to open, or None by the deadline."""
        config = self.config
        loop = asyncio.get_running_loop()
        started = loop.time()
        down = self.stats.down
        deadline = config.down_deadline if down else config.deadline
        first = self.turn  # order()'s start: another connection may move self.turn meanwhile
        order = self.order()
        pending = {}
        turns = {}  # path -> its index in config.upstreams, for the winner
        attempts = 0
        next_direct = started
        last_direct = started
        retry = FIRST_RETRY  # the wait after an attempt refused at once, doubling up to the stagger
        proxy_due = (started if down else started + config.proxy_after) if config.proxy else None
        winner = None
        try:
            while winner is None:
                now = loop.time()
                if now - started >= deadline:
                    return None
                direct_slots = config.parallel - sum(1 for path in pending.values() if path != "proxy")
                if now >= next_direct and direct_slots > 0:
                    host, port = order[attempts % len(order)]
                    path = authority(host, port)
                    turns[path] = (first + attempts) % len(order)
                    attempts += 1
                    self.stats.attempts += 1
                    pending[asyncio.ensure_future(open_direct(host, port, config.attempt))] = path
                    last_direct = now
                    next_direct = now + config.stagger
                if proxy_due is not None and now >= proxy_due:
                    proxy_due = None
                    attempts += 1
                    self.stats.attempts += 1
                    pending[asyncio.ensure_future(open_proxy(config, config.attempt * 2))] = "proxy"
                wake = [started + deadline]
                if direct_slots > 0 or not pending:
                    wake.append(next_direct)
                if proxy_due is not None:
                    wake.append(proxy_due)
                timeout = max(0.0, min(wake) - loop.time())
                if not pending:
                    await asyncio.sleep(timeout)
                    continue
                done, _ = await asyncio.wait(pending, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    path = pending.pop(task)
                    error = task.exception()
                    if error is None and winner is None:
                        winner = (task.result(), path)
                        self.stats.paths[path]["opened"] += 1
                    elif error is None:
                        task.result()[1].close()  # a second one that opened in the same tick
                        self.stats.paths[path]["opened"] += 1
                    else:
                        self.stats.paths[path]["failed"] += 1
                        if not pending and path != "proxy" and loop.time() < next_direct:
                            # Refused at once (RST, unreachable): no point waiting out the stagger, but never
                            # a tight loop of SYNs either.
                            next_direct = max(loop.time(), min(next_direct, last_direct + retry))
                            retry = min(retry * 2, config.stagger)
        finally:
            for task, path in pending.items():
                task.cancel()
            for task in list(pending):
                try:
                    reader_writer = await task
                except BaseException:
                    continue
                reader_writer[1].close()
        (reader, writer), path = winner
        self.stats.paths[path]["won"] += 1
        if path != "proxy":
            self.turn = turns[path]
        return reader, writer, path, attempts, loop.time() - started

    def searched(self, ok):
        """One upstream search's outcome: the success rate, and the down state with one log line per change."""
        stats = self.stats
        stats.recent.append(ok)
        stats.failing = 0 if ok else stats.failing + 1
        if ok and stats.down:
            stats.down = False
            log("upstream back")
        elif not ok and not stats.down and stats.failing >= self.config.down_after:
            stats.down = True
            log(f"upstream down: {stats.failing} connections in a row found no way to Telegram "
                f"(README.md, «Если адрес закрыли»)")

    async def handle(self, client_reader, client_writer):
        self.stats.connections += 1
        if self.stats.active >= self.config.max_connections:
            self.stats.refused += 1
            client_writer.close()
            return
        self.stats.active += 1
        began = time.monotonic()
        writer = None
        try:
            found = await self.upstream()
            if found is None:
                self.stats.failed += 1
                self.stats.last_failure = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                self.searched(False)
                log("conn failed: no upstream by the deadline")
                return
            self.searched(True)
            reader, writer, path, attempts, waited = found
            for w in (client_writer, writer):
                keepalive(w.get_extra_info("socket"))
            up, down = await self.splice(client_reader, client_writer, reader, writer)
            log(f"conn via={path} attempts={attempts} upstream_ms={waited * 1000:.0f} "
                f"up={up} down={down} ms={(time.monotonic() - began) * 1000:.0f}")
        except Exception as error:  # one connection's trouble is never the server's
            log(f"conn error: {type(error).__name__}")
        finally:
            self.stats.active -= 1
            for w in (writer, client_writer):
                if w is not None:
                    w.close()

    async def splice(self, client_reader, client_writer, reader, writer):
        """Both directions until both end; once one has, the other gets LINGER_S, so a flow this network lost
        silently never holds two sockets for hours."""
        idle, seen = self.config.idle, [time.monotonic()]
        tasks = [asyncio.ensure_future(pipe(client_reader, writer, idle, seen)),
                 asyncio.ensure_future(pipe(reader, client_writer, idle, seen))]
        try:
            done, rest = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            if rest:
                await asyncio.wait(rest, timeout=self.config.linger)
        finally:
            for task in tasks:
                task.cancel()
        return tuple(task.result() if task.done() and not task.cancelled() else -1 for task in tasks)

    async def health(self, reader, writer):
        try:
            await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
            body = json.dumps(self.stats.snapshot(self.config)).encode()
            status = b"200 OK" if json.loads(body)["ok"] else b"503 Service Unavailable"
            writer.write(b"HTTP/1.1 " + status + b"\r\nContent-Type: application/json\r\nConnection: close\r\n"
                         + f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
            await writer.drain()
        except Exception:
            pass
        finally:
            writer.close()

    async def serve(self):
        server = await asyncio.start_server(self.handle, *self.config.listen)
        health = await asyncio.start_server(self.health, *self.config.health)
        ups = ",".join(authority(h, p) for h, p in self.config.upstreams)
        log(f"listening on {authority(*self.config.listen)}, upstreams {ups}, "
            f"proxy {'on' if self.config.proxy else 'off'}")
        notify_ready()
        async with server, health:
            await asyncio.gather(server.serve_forever(), health.serve_forever())


def notify_ready():
    """READY=1 to systemd (Type=notify), once both listeners are bound: the services ordered after this one
    start only then. Nothing without NOTIFY_SOCKET (run by hand)."""
    path = os.environ.get("NOTIFY_SOCKET", "")
    if not path:
        return
    if path.startswith("@"):
        path = "\0" + path[1:]  # an abstract socket
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
            sock.connect(path)
            sock.sendall(b"READY=1")
    except OSError as error:  # systemd then gives up on the start after TimeoutStartSec and restarts it
        log(f"could not tell systemd it is ready: {type(error).__name__}")


def keepalive(sock):
    """No Nagle, and a dead peer noticed in ~90 s rather than the kernel's two hours."""
    if sock is None:
        return
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
    for name, value in (("TCP_KEEPIDLE", 60), ("TCP_KEEPINTVL", 10), ("TCP_KEEPCNT", 3)):
        if hasattr(socket, name):
            sock.setsockopt(socket.IPPROTO_TCP, getattr(socket, name), value)


async def pipe(reader, writer, idle=None, seen=None):
    """Copy until EOF, then half-close the other side: TLS close_notify and the rest still flow back.
    With `idle`, a connection that moved no byte either way (`seen`, shared by both directions) for that
    long is closed."""
    total = 0
    seen = seen if seen is not None else [time.monotonic()]
    try:
        while True:
            # The other direction moving bytes (a download, a long answer) keeps this one open too.
            left = None if idle is None else max(0.05, idle - (time.monotonic() - seen[0]))
            try:
                data = await asyncio.wait_for(reader.read(READ_CHUNK), left)
            except asyncio.TimeoutError:
                if time.monotonic() - seen[0] < idle:
                    continue
                raise
            seen[0] = time.monotonic()
            if not data:
                break
            total += len(data)
            writer.write(data)
            await writer.drain()
        if writer.can_write_eof():
            writer.write_eof()
    except (ConnectionError, OSError, asyncio.TimeoutError):
        writer.close()
    return total


async def check(config, by_name=True):
    """A TLS handshake and an HTTP answer from the target through the forwarder. By name (the default) the
    connection goes the way every client's does, so a lost hosts line or REDIRECT rule fails it too."""
    context = ssl.create_default_context()
    name, port = config.target
    if by_name:
        resolved = {info[4][0] for info in socket.getaddrinfo(name, port, type=socket.SOCK_STREAM)}
        if resolved != {REDIRECT_ADDRESS}:
            print(f"{name} resolves to {','.join(sorted(resolved))}, not {REDIRECT_ADDRESS}: "
                  f"the hosts line is gone (setup.sh)")
            return False
        host = name
    else:
        host, port = config.listen
    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(host, port, ssl=context, server_hostname=name), config.deadline + 5)
    writer.write(f"HEAD / HTTP/1.1\r\nHost: {config.target[0]}\r\nConnection: close\r\n\r\n".encode())
    await writer.drain()
    line = await asyncio.wait_for(reader.readline(), 10)
    writer.close()
    return line.startswith(b"HTTP/")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv not in (["--check"], ["--check-listener"]):
        print(__doc__, file=sys.stderr)
        return 2
    try:
        config = Config()
    except ValueError as error:
        # Our own messages only: int() and urllib quote the value, and a value may be a secret.
        print(f"bad setting: {error}" if "TG_EGRESS_" in str(error) else "bad setting: a TG_EGRESS_* value "
              "is not a number or address", file=sys.stderr)
        return 2
    if argv:
        try:
            ok = asyncio.run(check(config, by_name=argv == ["--check"]))
        except (OSError, asyncio.TimeoutError, ssl.SSLError) as error:
            print(f"no answer: {type(error).__name__}")
            return 1
        print("ok" if ok else "no answer")
        return 0 if ok else 1
    asyncio.run(Forwarder(config).serve())
    return 0



if __name__ == "__main__":
    sys.exit(main())
