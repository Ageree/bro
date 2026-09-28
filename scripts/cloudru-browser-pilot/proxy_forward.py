"""Local proxy for the pilot Chrome: 127.0.0.1:3128 → the chosen residential proxy, with its login added.

Chrome cannot send proxy credentials from the command line, so it talks to this forwarder without
auth and the forwarder adds `Proxy-Authorization` for the upstream. The upstream is line N of
/etc/bro/proxies.txt (`host:port:user:password`), N from /etc/bro/proxy-index; a change applies to new
connections. Bytes through the proxy are counted in /var/lib/bro/proxy-bytes.json (residential
traffic is billed per GB).
"""

import asyncio
import base64
import json
import time
from pathlib import Path

PROXIES = Path("/etc/bro/proxies.txt")
INDEX = Path("/etc/bro/proxy-index")
COUNTER = Path("/var/lib/bro/proxy-bytes.json")
totals = {"up": 0, "down": 0, "connections": 0}


def upstream():
    lines = [line.strip() for line in PROXIES.read_text().splitlines() if line.strip()]
    index = int(INDEX.read_text().strip()) if INDEX.exists() else 0
    host, port, user, password = lines[index % len(lines)].split(":", 3)
    return host, int(port), base64.b64encode(f"{user}:{password}".encode()).decode()


async def pipe(reader, writer, key):
    try:
        while data := await reader.read(65536):
            totals[key] += len(data)
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        writer.close()


async def handle(client_reader, client_writer):
    try:
        head = await client_reader.readuntil(b"\r\n\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        client_writer.close()
        return
    host, port, auth = upstream()
    lines = head.decode("latin-1").split("\r\n")
    # One request per connection for plain HTTP, so every request carries the upstream login.
    kept = [line for line in lines[1:] if line and not line.lower().startswith(("proxy-authorization:", "proxy-connection:", "connection:"))]
    if not lines[0].startswith("CONNECT"):
        kept.append("Connection: close")
    request = "\r\n".join([lines[0], *kept, f"Proxy-Authorization: Basic {auth}", "", ""]).encode("latin-1")
    try:
        up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(host, port), 20)
    except (OSError, asyncio.TimeoutError):
        client_writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
        client_writer.close()
        return
    totals["connections"] += 1
    totals["up"] += len(request)
    up_writer.write(request)
    await up_writer.drain()
    await asyncio.gather(pipe(client_reader, up_writer, "up"), pipe(up_reader, client_writer, "down"))


async def report():
    while True:
        COUNTER.write_text(json.dumps({**totals, "at": time.time()}))
        await asyncio.sleep(1)


async def main():
    server = await asyncio.start_server(handle, "127.0.0.1", 3128)
    asyncio.create_task(report())
    async with server:
        await server.serve_forever()


asyncio.run(main())
