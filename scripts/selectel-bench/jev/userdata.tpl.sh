#!/bin/bash
# Jev 1.14 bench (role __ROLE__): Chrome + the harness from user data; results are served read-only on :80 from /var/www/bench.
R=/var/www/bench; mkdir -p $R /etc/bench /opt/jev; rm -f $R/*
log(){ echo "BENCH $*" | tee -a $R/log.txt >/dev/ttyS0; }
log "runcmd-start role=__ROLE__ epoch=$(date +%s.%N)"
(cd $R && nohup python3 -m http.server 80 >/dev/null 2>&1 &)
log "cpu=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs) nproc=$(nproc) mem=$(free -m | awk '/Mem/{print $2}')"
echo "127.0.1.1 $(hostname)" >> /etc/hosts; useradd -m -s /bin/bash bench 2>/dev/null
echo '__TS_B64__' | base64 -d > /etc/bench/typesafe
echo '__KEY_B64__' | base64 -d > /etc/bench/routerai
echo '__PKG_B64__' | base64 -d | tar -xz -C /opt/jev
echo '__EXT_B64__' | base64 -d > /opt/bench_extend_system.txt; mkdir -p /opt/bench; cp /opt/bench_extend_system.txt /opt/bench/extend_system.txt
chown bench /etc/bench/*; chmod 600 /etc/bench/*; chown -R bench $R /opt/jev; chmod -R a+rX /opt/jev /opt/bench
export DEBIAN_FRONTEND=noninteractive
t0=$(date +%s.%N)
for n in 1 2 3; do curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && break; sleep 5; done
apt-get update -qq; apt-get install -y -qq /tmp/chrome.deb xvfb fonts-noto-color-emoji fonts-liberation python3-venv >/dev/null 2>&1
log "chrome-install sec=$(python3 -c "import time;print(round(time.time()-$t0,1))") ver=$(google-chrome --version 2>&1)"
sudo -u bench bash -c 'python3 -m venv /home/bench/venv && /home/bench/venv/bin/pip install -q "httpx[http2]" websocket-client __EXTRA_PIP__' > $R/pip.txt 2>&1
log "pip rc=$?"
sudo -u bench bash -c 'Xvfb :99 -screen 0 1366x900x24 >/dev/null 2>&1 &'; sleep 1
sudo -u bench env DISPLAY=:99 PYTHONPATH=/opt/jev/jev:/opt/jev/jev/shim:/opt/jev/src ANONYMIZED_TELEMETRY=false __JEV_ENV__ \
  ARMS=__ARMS__ TASKS=__TASKS__ REPS=__REPS__ BOX=__BOX__ BOX_PER_PAGE=__BOX_PER_PAGE__ \
  /home/bench/venv/bin/python /opt/jev/jev/orchestrate.py > $R/stdout.txt 2>&1
log "orchestrate-exit rc=$?"
shred -u /etc/bench/typesafe /etc/bench/routerai
log "done epoch=$(date +%s.%N)"
