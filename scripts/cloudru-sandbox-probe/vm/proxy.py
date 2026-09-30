"""Stand-in for the residential proxy: a plain HTTP proxy on the probe host (CONNECT and absolute-URI
requests), so the worker's forwarder has an upstream. Its exit is the host's own Cloud.ru address, the
same for the sandbox and the native run. Any Proxy-Authorization is ignored.

  python3 proxy.py [PORT=3130]     listens on 0.0.0.0 (the security group lets only 80/443 in from outside)
"""

import asyncio
import sys


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        writer.close()


async def handle(reader, writer):
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 30)
        lines = head.decode("latin-1").split("\r\n")
        method, target, version = lines[0].split(" ", 2)
        if method == "CONNECT":
            host, port = target.rsplit(":", 1)
            up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(host, int(port)), 20)
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
        else:
            rest = target.split("://", 1)[1]
            hostport, _, path = rest.partition("/")
            host, _, port = hostport.partition(":")
            up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(host, int(port or 80)), 20)
            kept = [line for line in lines[1:] if line and not line.lower().startswith("proxy-")]
            up_writer.write("\r\n".join([f"{method} /{path} {version}", *kept, "", ""]).encode("latin-1"))
        await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))
    except Exception:
        writer.close()


async def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3130
    server = await asyncio.start_server(handle, "0.0.0.0", port)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
