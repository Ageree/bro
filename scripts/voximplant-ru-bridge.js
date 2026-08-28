// Paste into a Voximplant scenario. Inkbox Voice AI dials BRO_RU_BRIDGE_E164
// (this app's US DID). We look up the real +7 dest and hairpin media.
//
// Convex env: BRO_INTERNAL_SECRET must be set on the deployment.
// Replace the three constants. CLI is what the clinic sees.

const BRIDGE_URL = "https://YOUR_DEPLOYMENT.convex.site/call-bridge";
const SECRET = "BRO_INTERNAL_SECRET";
const CLI = "+79XXXXXXXXX";

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
      const out = VoxEngine.callPSTN(dest, CLI);
      VoxEngine.easyProcess(e.call, out);
    },
    { method: "GET" },
  );
});
