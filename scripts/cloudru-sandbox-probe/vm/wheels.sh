#!/bin/bash
# Python of the sandbox root when GitHub and PyPI do not answer from Cloud.ru (30.09.2026: TCP connects, no data
# comes back; uv, its CPython builds and jev live on GitHub). Ubuntu's python3.11 (browser-use needs >= 3.11) and
# wheels from the Huawei Cloud PyPI mirror, each checked against PyPI's own sha256 in the session
# (verify_wheels.py) before the rootfs build installs them offline. numpy < 2.5: 2.5 needs Python 3.12.
#   wheels.sh download     → /srv/bro/wheels and /srv/bro/wheels.sha256 (on the host)
#   wheels.sh install      in the chroot, as BRO_PYTHON_SETUP of build_rootfs.sh (wheels in /opt/bro/wheels)
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
MIRROR="${BRO_PYPI_MIRROR:-https://repo.huaweicloud.com/repository/pypi/simple}"
PACKAGES=(browser-use==0.13.10 aiohttp==3.14.3 opencv-python-headless==5.0.0.93 "numpy<2.5")
apt-get update -q >/dev/null
apt-get install -yq python3.11 python3.11-venv >/dev/null
if [ "${1:-install}" = download ]; then
  rm -rf /srv/bro/dl /srv/bro/wheels
  python3.11 -m venv /srv/bro/dl
  /srv/bro/dl/bin/pip download -q -d /srv/bro/wheels --index-url "$MIRROR" --only-binary=:all: "${PACKAGES[@]}"
  (cd /srv/bro/wheels && sha256sum ./*) > /srv/bro/wheels.sha256
  wc -l < /srv/bro/wheels.sha256
else
  python3.11 -m venv /opt/bro/bu/.venv
  /opt/bro/bu/.venv/bin/pip install -q --no-index --find-links /opt/bro/wheels "${PACKAGES[@]}"
  /opt/bro/bu/.venv/bin/python -c "import browser_use, aiohttp, cv2; print('venv ok', browser_use.__file__)"
fi
