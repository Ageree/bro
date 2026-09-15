---
name: vphone
description: Drive the Bro virtual iPhone (vphone-cli) for iOS E2E — Safari landing/cabinet/vault and, if activated, Messages. Use on an Apple Silicon MacBook with a launched VM. Never attempt this on Cloud Linux.
---

# vphone — Bro device tests

[vphone-cli](https://github.com/Lakr233/vphone-cli) boots a **virtual iPhone** on Apple Silicon (Virtualization.framework, PV=3). It is not a cable to a physical phone.

Cloud Linux cannot host it. No self-hosted worker is implied. If `uname` is not `Darwin/arm64`, stop and tell the human to run setup on the MacBook (or start `cursor worker start` there and re-run).

## Host setup (MacBook, once)

1. Recovery: `csrutil disable` + `csrutil allow-research-guests enable`, then `sudo nvram boot-args="amfi_get_out_of_my_way=1 -v"` and reboot. Or keep SIP: `csrutil enable --without debug` and `vphone-amfidont`.
2. From this repo: `npm run vphone:setup`
3. `vphone-cli vm create bro -V jb` then `vphone-cli vm launch bro`
4. Socket: `~/.vphone/VMs/bro/vphone.sock` (override with `VPHONE_SOCK` / `VPHONE_VM`)

First-boot setup: pick United States, not Japan or the EU. Stuck on "Press home": VNC right-click = home.

## Drive the VM

JSON line on the Unix socket, JSON line back. Compact grayscale JPEG is `image` (base64) unless `"screen":false`.

```json
{"t":"screenshot"}
{"t":"tap","x":645,"y":1398}
{"t":"swipe","x1":645,"y1":2600,"x2":645,"y2":1400,"ms":300}
{"t":"key","name":"home"}
{"t":"type","text":"https://brobro.tech"}
```

Keys: `home` | `power` | `volup` | `voldown`. `type` sets the **guest clipboard** — tap the field, then paste. Screen is 1290×2796.

Repo helpers:

- `npm run vphone:check` — protocol + wiring (Linux CI ok)
- `npm run vphone:e2e` — live smoke: screenshot, home, Safari, clipboard = `VPHONE_SITE` (default `https://brobro.tech`)
- `scripts/lib/vphone.ts` — `discoverSocket`, `sendCommand`, `appPosition`

Dock: Phone, Safari, Messages, Music. Home grid includes Settings, Wallet, Mail, Photos. Use `appPosition("safari")` then tap.

Optional MCP: [vphone-mcp](https://github.com/pluginslab/vphone-mcp) with `VPHONE_SOCK` pointing at the same socket.

## What to test for Bro

Do these as a human would. After every gesture, read the screenshot.

1. **Landing** — Safari → `https://brobro.tech`. CTA «Получить своего бро», iOS UA. Do not finish paid signup unless asked.
2. **Cabinet** — `/cabinet.html`. Login sheet, one-time code path. A VM usually has no iMessage; if the code cannot arrive, stop and say so.
3. **Vault** — `/vault.html` behind cabinet. Never type a real card/password into a screenshot-backed session unless the human said to.
4. **Messages** — only if the VM shows a blue iMessage thread with Bro. Activation on a VM often fails (attestation). Physical iPhone stays the source of truth for Photon blue bubbles.

Do not claim a full Bro chat loop passed unless the screenshot shows the outbound bubble and Bro's reply.

## Hard stops

- Nested macOS / Cloud VM: `Virtualization is not available on this hardware`
- `zsh: killed ./vphone-cli`: SIP/AMFI not relaxed
- Missing `vphone.sock`: VM not launched
- iMessage gray / activation error: use the physical iPhone; do not invent a delivered message
