# Virtual iPhone tests (vphone-cli)

Agents drive a jailbroken **iOS VM** on an Apple Silicon Mac via [vphone-cli](https://github.com/Lakr233/vphone-cli) and the host socket `vphone.sock`. This is not a USB link to a physical iPhone. Cloud Linux cannot boot a PV=3 guest.

## Why Bro uses it

Static `*:check` scripts do not see iOS Safari, the cabinet login sheet, or Messages chrome. On a MacBook the VM is a real iOS UI the agent can tap, swipe, and screenshot.

Blue iMessage (Photon) still needs a **physical iPhone** unless the VM activates iMessage — device attestation often fails in a guest. Use the VM for landing / cabinet / vault; treat Messages as bonus.

## MacBook (once)

1. Recovery Terminal:

```bash
csrutil disable
csrutil allow-research-guests enable
```

Then in macOS:

```bash
sudo nvram boot-args="amfi_get_out_of_my_way=1 -v"   # reboot after
```

SIP-on alternative: `csrutil enable --without debug` in Recovery, then `vphone-amfidont`.

2. From this repo:

```bash
npm run vphone:setup
vphone-cli vm create bro -V jb
vphone-cli vm launch bro
export VPHONE_VM=bro
# or: export VPHONE_SOCK=~/.vphone/VMs/bro/vphone.sock
npm run vphone:e2e
```

`vm create` downloads IPSWs and restores the guest. First-boot region: United States (not Japan / EU).

## Commands

| Script | Where | What |
| --- | --- | --- |
| `npm run vphone:check` | anywhere | Protocol, discovery, wiring |
| `npm run vphone:setup` | Apple Silicon Mac | Homebrew tap install + printed next steps |
| `npm run vphone:e2e` | Mac + launched VM | Screenshot, Home, Safari, clipboard = `VPHONE_SITE` |

Socket protocol (one JSON line in, one out) lives in `scripts/lib/vphone.ts`. Agent playbook: `.cursor/skills/vphone/SKILL.md`. Optional MCP: [vphone-mcp](https://github.com/pluginslab/vphone-mcp) with the same `VPHONE_SOCK`.

## Cursor Cloud

A cloud agent on Linux cannot install or launch the VM. To let agents drive it: run `cursor worker start` on the MacBook that has the VM, then target that worker. If no worker is connected, stop and say so — do not pretend the guest is up.
