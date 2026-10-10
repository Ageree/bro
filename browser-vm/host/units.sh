# The systemd units of a browser host, written by provision.sh and again by update.sh (hostd's self-update):
# each function writes its unit and says (exit status 0) whether the file changed.
write_unit() {
  local path="$1" before=""
  [ -f "$path" ] && before=$(sha256sum < "$path")
  cat > "$path.new"
  mv "$path.new" "$path"
  [ "$before" != "$(sha256sum < "$path")" ]
}

write_caddy_unit() {
  write_unit /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
# Ports 80 and 443 only. Not CAP_NET_ADMIN (upstream's unit gives it for QUIC buffers): with it, code run as
# caddy could delete hostd's nftables table, the one barrier between sandboxes and the VPC.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
RuntimeDirectory=caddy
RuntimeDirectoryMode=0750

[Install]
WantedBy=multi-user.target
UNIT
}

write_hostd_unit() {
  write_unit /etc/systemd/system/bro-hostd.service <<'UNIT'
[Unit]
Description=Bro browser host daemon
After=network-online.target caddy.service
Wants=network-online.target

[Service]
ExecStart=/opt/bro/venv/bin/python /opt/bro/host/hostd.py
Environment=PYTHONUNBUFFERED=1
Restart=always
RestartSec=2
# Sandboxes outlive a hostd restart (their own cgroups too): only hostd itself is stopped. No PrivateMounts
# or ProtectSystem either: the overlays hostd mounts for runc sandboxes must be the host's own.
KillMode=process

[Install]
WantedBy=multi-user.target
UNIT
}
