"""The host's Caddyfile: one public name with Let's Encrypt, hostd under /h/, each sandbox's worker under
/g/<id>/ (prefix stripped; the worker checks its own tokens). The admin API listens on a unix socket
only: on localhost:2019 any local process could load a config that publishes a worker's CDP."""


def caddyfile(*, domain, admin_socket, hostd_port, routes):
    """`routes`: [(sandbox id, worker address, worker port)], in a stable order."""
    lines = ["{", f"\tadmin unix/{admin_socket}", "}", f"{domain} {{",
             "\thandle_path /h/* {", f"\t\treverse_proxy 127.0.0.1:{hostd_port}", "\t}"]
    for sandbox_id, address, port in sorted(routes):
        lines += [f"\thandle_path /g/{sandbox_id}/* {{", f"\t\treverse_proxy {address}:{port}", "\t}"]
    lines += ["\thandle {", "\t\trespond 404", "\t}", "}", ""]
    return "\n".join(lines)


def reload_command(caddy, path, admin_socket):
    return [caddy, "reload", "--config", str(path), "--adapter", "caddyfile", "--address", f"unix/{admin_socket}"]
