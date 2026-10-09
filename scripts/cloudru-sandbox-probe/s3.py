"""Object Storage of Cloud.ru for the stand, stdlib only: presigned links, listing, deleting.

The Cloud.ru key never goes to a probe VM: this runs in the session, and the VM gets presigned links
(a capability for one object and one method, for a limited time) instead.

  python s3.py presign get|put KEY [--expires 3600]   one link
  python s3.py presign-many put PREFIX COUNT          links for PREFIX/part-000 … as JSON {name: url}
  python s3.py put KEY FILE | get KEY FILE            upload or download from here
  python s3.py list PREFIX                            keys and sizes
  python s3.py delete-prefix PREFIX                   delete every object under the prefix

Needs CLOUDRU_KEY_ID, CLOUDRU_KEY_SECRET and CLOUDRU_S3_TENANT_ID (or S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID and
S3_SECRET_ACCESS_KEY for another provider, Selectel: that key, region and host instead); the access key is
"<tenant>:<key id>", region ru-central-1, endpoint https://s3.cloud.ru (path style). Bucket: $PROBE_BUCKET
(default bucket-ac164a).
"""

import argparse
import base64
import datetime
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

def setting(name):
    value = os.environ.get(name, "")
    return "".join(value.split()).strip("‘’“”'\"")


# Another S3 provider (Selectel) when S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are set
# (as in Bro's env.ts); Cloud.ru's otherwise. The endpoint is an https origin; ENDPOINT is its host.
PROVIDER = all(setting(n) for n in ("S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"))
ENDPOINT = urllib.parse.urlsplit(setting("S3_ENDPOINT")).hostname if PROVIDER else "s3.cloud.ru"
REGION = setting("S3_REGION") if PROVIDER else "ru-central-1"
BUCKET = os.environ.get("PROBE_BUCKET", "bucket-ac164a")
EMPTY_SHA = hashlib.sha256(b"").hexdigest()


def clean(value):
    """Keys arrive with line breaks inside or wrapped in typographic quotes (as in cloudru.py)."""
    return "".join(value.split()).strip("‘’“”'\"")


def credentials():
    if PROVIDER:
        return setting("S3_ACCESS_KEY_ID"), setting("S3_SECRET_ACCESS_KEY")
    access = f"{clean(os.environ['CLOUDRU_S3_TENANT_ID'])}:{clean(os.environ['CLOUDRU_KEY_ID'])}"
    return access, clean(os.environ["CLOUDRU_KEY_SECRET"])


def quote(text, safe="-_.~"):
    return urllib.parse.quote(text, safe=safe)


def signing_key(secret, day):
    key = ("AWS4" + secret).encode()
    for part in (day, REGION, "s3", "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    return key


def canonical_query(params):
    return "&".join(f"{quote(k)}={quote(str(v))}" for k, v in sorted(params.items()))


def presign(method, key, expires=3600, now=None):
    """A SigV4 query-signed link: whoever holds it may do `method` on this one object until it expires."""
    access, secret = credentials()
    now = now or datetime.datetime.now(datetime.timezone.utc)
    stamp, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    scope = f"{day}/{REGION}/s3/aws4_request"
    path = f"/{BUCKET}/{quote(key, safe='-_.~/')}"
    params = {"X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": f"{access}/{scope}",
              "X-Amz-Date": stamp, "X-Amz-Expires": str(expires), "X-Amz-SignedHeaders": "host"}
    request = "\n".join([method, path, canonical_query(params), f"host:{ENDPOINT}\n", "host", "UNSIGNED-PAYLOAD"])
    to_sign = "\n".join(["AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(request.encode()).hexdigest()])
    signature = hmac.new(signing_key(secret, day), to_sign.encode(), hashlib.sha256).hexdigest()
    return f"https://{ENDPOINT}{path}?{canonical_query(params)}&X-Amz-Signature={signature}"


def signed(method, key="", params=None, body=b""):
    """A header-signed request (listing and bulk delete from the session)."""
    access, secret = credentials()
    now = datetime.datetime.now(datetime.timezone.utc)
    stamp, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    scope = f"{day}/{REGION}/s3/aws4_request"
    path = f"/{BUCKET}/{quote(key, safe='-_.~/')}" if key else f"/{BUCKET}"
    payload = hashlib.sha256(body).hexdigest()
    headers = {"host": ENDPOINT, "x-amz-content-sha256": payload, "x-amz-date": stamp}
    if body:
        headers["content-md5"] = base64.b64encode(hashlib.md5(body).digest()).decode()
    names = ";".join(sorted(headers))
    canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
    request = "\n".join([method, path, canonical_query(params or {}), canonical_headers, names, payload])
    to_sign = "\n".join(["AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(request.encode()).hexdigest()])
    signature = hmac.new(signing_key(secret, day), to_sign.encode(), hashlib.sha256).hexdigest()
    headers["Authorization"] = f"AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders={names}, " \
                               f"Signature={signature}"
    query = canonical_query(params or {})
    url = f"https://{ENDPOINT}{path}" + (f"?{query}" if query else "")
    return send(urllib.request.Request(url, body or None, headers, method=method))


def send(request, attempts=5):
    # The session's egress proxy drops a tunnel now and then: retry.
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            if attempt == attempts - 1:
                raise
            time.sleep(2 ** attempt)


def listing(prefix):
    keys, token = [], None
    while True:
        params = {"list-type": "2", "prefix": prefix}
        if token:
            params["continuation-token"] = token
        code, body = signed("GET", params=params)
        if code != 200:
            sys.exit(f"list {code}: {body[:300]!r}")
        text = body.decode()
        keys += [(k, int(s)) for k, s in re.findall(r"<Key>(.*?)</Key>.*?<Size>(\d+)</Size>", text, re.S)]
        match = re.search(r"<NextContinuationToken>(.*?)</NextContinuationToken>", text)
        if not match:
            return keys
        token = match.group(1)


def delete_prefix(prefix):
    keys = [k for k, _ in listing(prefix)]
    for i in range(0, len(keys), 500):
        objects = "".join(f"<Object><Key>{k}</Key></Object>" for k in keys[i:i + 500])
        body = f"<Delete><Quiet>true</Quiet>{objects}</Delete>".encode()
        code, answer = signed("POST", params={"delete": ""}, body=body)
        if code != 200 or b"<Error>" in answer:
            sys.exit(f"delete {code}: {answer[:300]!r}")
    return len(keys)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    one = sub.add_parser("presign")
    one.add_argument("method", choices=["get", "put"])
    one.add_argument("key")
    one.add_argument("--expires", type=int, default=3600)
    many = sub.add_parser("presign-many")
    many.add_argument("method", choices=["get", "put"])
    many.add_argument("prefix")
    many.add_argument("count", type=int)
    many.add_argument("--expires", type=int, default=6 * 3600)
    for name in ("put", "get"):
        transfer = sub.add_parser(name)
        transfer.add_argument("key")
        transfer.add_argument("file")
    sub.add_parser("list").add_argument("prefix")
    sub.add_parser("delete-prefix").add_argument("prefix")
    args = parser.parse_args()
    if args.cmd == "presign":
        print(presign(args.method.upper(), args.key, args.expires))
    elif args.cmd == "presign-many":
        print(json.dumps({f"part-{i:03d}": presign(args.method.upper(), f"{args.prefix}/part-{i:03d}", args.expires)
                          for i in range(args.count)}))
    elif args.cmd == "put":
        with open(args.file, "rb") as f:
            data = f.read()
        code, body = send(urllib.request.Request(presign("PUT", args.key), data, method="PUT"))
        print("put", code, len(data), body[:200] if code != 200 else "")
    elif args.cmd == "get":
        code, body = send(urllib.request.Request(presign("GET", args.key)))
        if code != 200:
            sys.exit(f"get {code}: {body[:300]!r}")
        with open(args.file, "wb") as f:
            f.write(body)
        print("get", code, len(body))
    elif args.cmd == "list":
        for key, size in listing(args.prefix):
            print(size, key)
    else:
        print("deleted", delete_prefix(args.prefix))


if __name__ == "__main__":
    main()
