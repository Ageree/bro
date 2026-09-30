#!/bin/bash
# Stage 2 (docs/browser-pool.md): the pool's sandbox rootfs archive, built once on a probe VM and shipped to
# hosts through Object Storage (browser-vm/host/provision.sh unpacks it).
#   rootfs_build.sh wheels            apt from mirror.yandex.ru, the sandbox's wheels from the PyPI mirror
#                                     (check /srv/bro/wheels.sha256 with verify_wheels.py in the session and
#                                     push its requirements.txt to /srv/bro/wheels/requirements.txt)
#   rootfs_build.sh build VERSION     build_rootfs.sh in ARCHIVE mode → /srv/bro/VERSION.tar.zst and its sha256
# Then a presigned PUT from the session: curl -fsS -T /srv/bro/VERSION.tar.zst '<url>'.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
STAND=/root/stand
case "${1:-}" in
  wheels)
    # archive.ubuntu.com does not answer from Cloud.ru (30.09.2026).
    sed -i -E 's#http://(archive|security)\.ubuntu\.com/ubuntu/?#http://mirror.yandex.ru/ubuntu/#' /etc/apt/sources.list
    apt-get update -q >/dev/null
    apt-get install -yq zstd debootstrap >/dev/null
    bash "$STAND/vm/wheels.sh" download
    ;;
  build)
    VERSION="$2"
    if [ ! -s /srv/bro/wheels/requirements.txt ]; then
      echo "push the requirements.txt verify_wheels.py wrote to /srv/bro/wheels/ first" >&2
      exit 1
    fi
    BRO_PYTHON_SETUP="$STAND/vm/wheels.sh" BRO_PYTHON_WHEELS=/srv/bro/wheels \
      bash "$STAND/browser-vm/image/sandbox/build_rootfs.sh" "/srv/bro/rootfs/$VERSION" "$VERSION" \
      "/srv/bro/$VERSION.tar.zst"
    stat -c %s "/srv/bro/$VERSION.tar.zst"
    sha256sum "/srv/bro/$VERSION.tar.zst"
    ;;
  *)
    sed -n 2,7p "$0"
    exit 2
    ;;
esac
