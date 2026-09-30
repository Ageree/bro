"""Stage 2 leak check (like scripts/cloudru-browser-pilot/leak_check.py), run INSIDE a pool sandbox in slot 0
with a neighbour in slot 1:
  runc --root /run/runc-bro exec bro-<id> python3 -c "$(cat leak.py)" HOST_VPC_IP HOST_PUBLIC_IP
  runc --root /run/runc-bro exec bro-<id> python3 -c "$(cat leak.py)" '<json [[label, host, port], ...]>'
Every forbidden destination must fail at once (TCP reset or ICMP prohibited), never time out."""

import errno
import json
import socket
import sys
import time


def default_targets(vpc, public):
    return [
        ["B worker via B transit", "172.31.0.6", 8080],
        ["B router other port", "172.31.0.6", 22],
        ["B transit gateway (host)", "172.31.0.5", 443],
        ["inner address (own, same for all)", "192.168.254.2", 8080],
        ["inner router", "192.168.254.1", 22],
        ["host via own gateway: hostd", "172.31.0.1", 8090],
        ["host via own gateway: Caddy 443", "172.31.0.1", 443],
        ["host via own gateway: Caddy 80", "172.31.0.1", 80],
        ["host via own gateway: ssh", "172.31.0.1", 22],
        ["host via own gateway: stand proxy (test-only open)", "172.31.0.1", 3130],
        ["host VPC address: ssh", vpc, 22],
        ["host VPC address: Caddy", vpc, 443],
        ["host VPC address: hostd", vpc, 8090],
        ["VPC gateway", "10.0.0.1", 53],
        ["VPC neighbour", "10.0.0.7", 22],
        ["VPC other", "10.1.2.3", 443],
        ["metadata", "169.254.169.254", 80],
        ["172.16/12", "172.16.0.1", 80],
        ["100.64/10", "100.64.0.1", 80],
        ["loopback of host range", "127.0.0.53", 53],
        ["host public IP: Caddy", public, 443],
        ["internet (control): ya.ru", "77.88.55.242", 443],
        ["internet (control): routerai.ru", "routerai.ru", 443],
        ["raw.githubusercontent.com (silent from Cloud.ru)", "raw.githubusercontent.com", 443],
        ["IPv6", "2a02:6b8::2:242", 443],
    ]


targets = json.loads(sys.argv[1]) if sys.argv[1].startswith("[") else default_targets(*sys.argv[1:3])
results = []
for label, host, port in targets:
    started = time.monotonic()
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.settimeout(8)
    try:
        sock.connect((host, port))
        outcome = "CONNECTED"
    except ConnectionRefusedError:
        outcome = "refused (tcp reset)"
    except socket.timeout:
        outcome = "TIMEOUT"
    except OSError as error:
        outcome = {errno.EHOSTUNREACH: "unreachable (icmp)", errno.ENETUNREACH: "network unreachable",
                   errno.EACCES: "prohibited (icmp)"}.get(error.errno, f"error {error.errno}")
    finally:
        sock.close()
    results.append({"what": label, "to": f"{host}:{port}", "outcome": outcome,
                    "ms": round((time.monotonic() - started) * 1000)})
for row in results:
    print(json.dumps(row))
