// Live on Voximplant: app bro-ru-bridge (id 59499143),
// scenario ru-hairpin (id 3607805), rule inbound-bridge (id 9330638).
// Bind a purchased DID to this application after top-up.

const BRIDGE_URL = "https://frugal-dragon-943.convex.site/call-bridge";
const SECRET = "BRO_INTERNAL_SECRET"; // live scenario has the real secret
const CLI = ""; // +7… when purchased; empty uses the DID Inkbox called

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
