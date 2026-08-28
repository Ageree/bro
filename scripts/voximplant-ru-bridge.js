// DEPRECATED: Voximplant RU verification needs ИП ЭЦП. Hairpin moved to
// Zadarma (`POST /zadarma-bridge`, rewrite_forward_number). Keep this only
// if someone later finishes Vox KYC. Live leftovers: app bro-ru-bridge
// (59499143), scenario ru-hairpin (3607805), rule inbound-bridge (9330638),
// Moscow DID +74992816046 (deactivated until 2026-09-11).

const BRIDGE_URL = "https://frugal-dragon-943.convex.site/call-bridge";
const SECRET = "BRO_INTERNAL_SECRET"; // live scenario has the real secret
const CLI = ""; // live scenario uses +74992816046; empty falls back to the DID Inkbox called

VoxEngine.addEventListener(AppEvents.CallAlerting, (e) => {
  const from = encodeURIComponent(e.callerid || "");
  const url = `${BRIDGE_URL}?secret=${encodeURIComponent(SECRET)}&from=${from}`;
  Net.httpRequest(
    url,
    (res) => {
      if (res.code !== 200) {
        Logger.write(`call-bridge ${res.code} ${res.text}`);
        e.call.hangup();
        return;
      }
      let dest = "";
      try {
        dest = JSON.parse(res.text).destE164 || "";
      } catch (err) {
        Logger.write(`call-bridge bad json ${res.text}`);
      }
      if (!dest) {
        e.call.hangup();
        return;
      }
      const out = VoxEngine.callPSTN(dest, CLI || e.destination || e.callerid);
      VoxEngine.easyProcess(e.call, out);
    },
    { method: "GET" },
  );
});
