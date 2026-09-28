"""What sites see through the browser: the address from ipinfo.io and the WebRTC ICE candidates.

With the residential proxy and --force-webrtc-ip-handling-policy=disable_non_proxied_udp, the ipinfo
address must be the proxy's and no candidate may carry the VM's own address.
"""

import json

from jev_ultrafast.browser import Browser

GATHER = """new Promise(resolve => {
  const ips = new Set();
  const pc = new RTCPeerConnection({iceServers: [{urls: 'stun:stun.l.google.com:19302'}]});
  pc.createDataChannel('x');
  pc.onicecandidate = e => {
    if (!e.candidate) return resolve([...ips]);
    // "candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> ..."
    const p = e.candidate.candidate.split(' ');
    ips.add(p[4] + ' ' + p[2] + ' ' + p[7]);
  };
  pc.createOffer().then(o => pc.setLocalDescription(o));
  setTimeout(() => resolve([...ips]), 6000);
})"""

browser = Browser("https://ipinfo.io/json")
try:
    seen = json.loads(browser.evaluate("document.body.innerText"))
    # ICE gathering takes seconds; the harness IPC default is 5 s.
    response = browser.call("Runtime.evaluate", expression=GATHER, awaitPromise=True, returnByValue=True,
                            _response_timeout=20)
    candidates = response.get("result", {}).get("value")
finally:
    browser.close()
print(json.dumps({"site_sees": {k: seen.get(k) for k in ("ip", "city", "org")}, "webrtc_candidates": candidates},
                 ensure_ascii=False))
