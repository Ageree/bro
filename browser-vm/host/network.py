"""Sandbox networking of a browser host: the one module that knows the address scheme.

A snapshot must come up on any host, so every sandbox has the SAME inside address and the uniqueness lives
outside it:

  sandbox netns bro-s-<id>     eth0 192.168.254.2/30, default via .1         (runsc takes it over)
        | veth
  router netns  bro-r-<id>     in0 192.168.254.1/30, up0 = transit router address, default via transit gw
        | veth                 SNAT (masquerade) of the sandbox's egress on up0,
        |                      DNAT transit:8080 -> 192.168.254.2:8080 so Caddy reaches the worker
  root netns                   brt<n> = transit gateway, 172.31.0.0/16 cut into /30s (slot n: .4n+1 and .4n+2)

The inside /30 is outside the Cloud.ru VPC (10.0.0.0/8). The root netns gets one generated nftables table
(`inet bro`), applied atomically with `nft -f`: a sandbox reaches the internet through the uplink with
masquerade and nothing else — no other sandbox, no private or shared ranges (10/8, 172.16/12, 192.168/16,
100.64/10), no metadata (169.254/16), no port of the host itself (hostd, Caddy, ssh). Its transit veth may
only carry its own router address, and IPv6 from sandboxes is dropped.

What a sandbox may not reach is refused at once (a TCP reset, an ICMP "prohibited"), never silently dropped:
a silent address hung browser-use for minutes after `done` on the stage 1 stand. Only a forged source
address and IPv6 are dropped: there is nobody to answer.

Stage 1 showed that a gVisor restore tolerates a changed inside address, and runc makes no snapshots, so the
router namespace per sandbox is no longer needed. It stays because it works and is tested; dropping it
(a unique inside address from the host's pool, the worker reached directly) belongs here alone.
"""

import ipaddress
import json

INNER = ipaddress.ip_network("192.168.254.0/30")
INNER_ROUTER = str(INNER.network_address + 1)
INNER_SANDBOX = str(INNER.network_address + 2)
BLOCKED = ("0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
           "192.168.0.0/16", "224.0.0.0/3")


class Network:
    def __init__(self, *, pool="172.31.0.0/16", worker_port=8080, ip="ip", nft="nft", blocked=()):
        self.pool = ipaddress.ip_network(pool)
        self.worker_port = worker_port
        self.ip, self.nft = ip, nft
        self.blocked = BLOCKED + tuple(str(ipaddress.ip_network(cidr)) for cidr in blocked)

    @property
    def slots(self):
        return self.pool.num_addresses // 4

    def transit(self, slot):
        """(gateway in the root netns, router address) of a transit slot."""
        if not 0 <= slot < self.slots:
            raise ValueError(f"transit slot {slot} is outside the pool")
        base = self.pool.network_address + 4 * slot
        return str(base + 1), str(base + 2)

    def allocate(self, used):
        for slot in range(self.slots):
            if slot not in used:
                return slot
        raise RuntimeError("no free transit slot")

    @staticmethod
    def netns(sandbox_id):
        return f"bro-s-{sandbox_id}", f"bro-r-{sandbox_id}"

    @staticmethod
    def uplink_veth(slot):
        return f"brt{slot}"

    def worker_address(self, slot):
        return self.transit(slot)[1], self.worker_port

    def setup(self, sandbox_id, slot, router_rules_path):
        """Commands that build both namespaces and their links (the router ruleset is at the path)."""
        sandbox, router = self.netns(sandbox_id)
        gateway, address = self.transit(slot)
        up, up_peer = self.uplink_veth(slot), f"brq{slot}"
        inner, inner_peer = f"brs{slot}", f"bri{slot}"
        ip = self.ip
        return [
            [ip, "netns", "add", router],
            [ip, "netns", "add", sandbox],
            [ip, "link", "add", up, "type", "veth", "peer", "name", up_peer],
            [ip, "link", "set", up_peer, "netns", router],
            [ip, "-n", router, "link", "set", up_peer, "name", "up0"],
            [ip, "addr", "add", f"{gateway}/30", "dev", up],
            [ip, "link", "set", up, "up"],
            [ip, "-n", router, "addr", "add", f"{address}/30", "dev", "up0"],
            [ip, "-n", router, "link", "set", "up0", "up"],
            [ip, "-n", router, "link", "set", "lo", "up"],
            [ip, "link", "add", inner, "type", "veth", "peer", "name", inner_peer],
            [ip, "link", "set", inner, "netns", sandbox],
            [ip, "link", "set", inner_peer, "netns", router],
            [ip, "-n", sandbox, "link", "set", inner, "name", "eth0"],
            [ip, "-n", router, "link", "set", inner_peer, "name", "in0"],
            [ip, "-n", router, "addr", "add", f"{INNER_ROUTER}/{INNER.prefixlen}", "dev", "in0"],
            [ip, "-n", router, "link", "set", "in0", "up"],
            [ip, "-n", sandbox, "addr", "add", f"{INNER_SANDBOX}/{INNER.prefixlen}", "dev", "eth0"],
            [ip, "-n", sandbox, "link", "set", "eth0", "up"],
            [ip, "-n", sandbox, "link", "set", "lo", "up"],
            [ip, "-n", sandbox, "route", "add", "default", "via", INNER_ROUTER],
            [ip, "-n", router, "route", "add", "default", "via", gateway],
            [ip, "netns", "exec", router, "sysctl", "-qw", "net.ipv4.ip_forward=1"],
            [ip, "netns", "exec", router, "sysctl", "-qw", "net.ipv6.conf.all.disable_ipv6=1"],
            [ip, "netns", "exec", sandbox, "sysctl", "-qw", "net.ipv6.conf.all.disable_ipv6=1"],
            [ip, "netns", "exec", router, self.nft, "-f", str(router_rules_path)],
        ]

    def teardown(self, sandbox_id, slot):
        """Deleting a namespace deletes the veths in it and their peers; the last one is for a half-built
        setup that never moved the uplink peer."""
        sandbox, router = self.netns(sandbox_id)
        return [[self.ip, "netns", "del", sandbox], [self.ip, "netns", "del", router],
                [self.ip, "link", "del", self.uplink_veth(slot)]]

    def router_rules(self):
        """The router netns: egress from the sandbox leaves masqueraded as the router's transit address;
        from outside only the worker port comes in; the router itself answers nothing."""
        port = self.worker_port
        return f"""table ip bro_router
delete table ip bro_router
table ip bro_router {{
\tchain prerouting {{
\t\ttype nat hook prerouting priority dstnat; policy accept;
\t\tiifname "up0" tcp dport {port} dnat to {INNER_SANDBOX}:{port}
\t}}
\tchain postrouting {{
\t\ttype nat hook postrouting priority srcnat; policy accept;
\t\toifname "up0" masquerade
\t}}
\tchain forward {{
\t\ttype filter hook forward priority filter; policy drop;
\t\tct state established,related accept
\t\tiifname "in0" oifname "up0" accept
\t\tiifname "up0" oifname "in0" ct status dnat tcp dport {port} accept
\t}}
\tchain input {{
\t\ttype filter hook input priority filter; policy drop;
\t\tct state established,related accept
\t\tiifname "in0" meta l4proto tcp reject with tcp reset
\t\tiifname "in0" reject
\t}}
}}
"""

    def host_rules(self, slots, uplink):
        """The root netns table for every sandbox on the host (`slots`): applied as one transaction."""
        guards = "".join(
            f'\t\tiifname "{self.uplink_veth(slot)}" ip saddr != {self.transit(slot)[1]} drop\n'
            for slot in sorted(slots))
        blocked = ", ".join(self.blocked)
        return f"""table inet bro
delete table inet bro
table inet bro {{
\tset blocked {{
\t\ttype ipv4_addr; flags interval; auto-merge;
\t\telements = {{ {blocked} }}
\t}}
\tchain input {{
\t\ttype filter hook input priority filter; policy accept;
\t\tiifname "brt*" ct state established,related accept
\t\tiifname "brt*" jump refuse
\t}}
\tchain forward {{
\t\ttype filter hook forward priority filter; policy accept;
\t\tiifname "brt*" meta nfproto ipv6 drop
{guards}\t\toifname "brt*" ct state established,related accept
\t\toifname "brt*" drop
\t\tiifname "brt*" ip daddr @blocked jump refuse
\t\tiifname "brt*" oifname "{uplink}" accept
\t\tiifname "brt*" jump refuse
\t}}
\tchain refuse {{
\t\tmeta l4proto tcp reject with tcp reset
\t\treject with icmpx type admin-prohibited
\t}}
\tchain postrouting {{
\t\ttype nat hook postrouting priority srcnat; policy accept;
\t\toifname "{uplink}" ip saddr {self.pool} masquerade
\t}}
}}
"""

    def uplink_command(self):
        return [self.ip, "-j", "route", "show", "default"]

    @staticmethod
    def uplink_from(output):
        routes = json.loads(output or "[]")
        for route in routes:
            if route.get("dev"):
                return route["dev"]
        raise RuntimeError("no default route")
