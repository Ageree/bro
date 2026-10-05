#!/bin/bash
# Lifecycle probe: a unit that logs each boot's uptime and serves /var/www/b read-only on :80.
mkdir -p /var/www/b
cat > /usr/local/bin/bootprobe.sh <<'X'
#!/bin/bash
echo "boot uptime=$(cut -d' ' -f1 /proc/uptime) epoch=$(date +%s.%N)" >> /var/www/b/boots.txt
cd /var/www/b && exec python3 -m http.server 80
X
chmod +x /usr/local/bin/bootprobe.sh
cat > /etc/systemd/system/bootprobe.service <<'X'
[Unit]
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/local/bin/bootprobe.sh
[Install]
WantedBy=multi-user.target
X
systemctl daemon-reload; systemctl enable --now bootprobe
systemd-analyze > /var/www/b/systemd-analyze.txt 2>&1
