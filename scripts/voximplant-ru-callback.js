// Live on Voximplant: app bro-ru-bridge (59499143),
// scenario ru-callback (3608292), rule outbound-callback (9331615).
// Started via HTTP StartScenarios + script_custom_data JSON
// { dest, inkbox, cli }. cli is a verified Caller ID, not a RU DID.

const data = JSON.parse(VoxEngine.customData() || "{}");
const dest = String(data.dest || "");
const inkbox = String(data.inkbox || "");
const cli = String(data.cli || "");
if (!dest || !inkbox || !cli) {
  Logger.write("ru-callback missing dest/inkbox/cli");
  VoxEngine.terminate();
} else {
  const toAgent = VoxEngine.callPSTN(inkbox, cli);
  toAgent.addEventListener(CallEvents.Connected, () => {
    const toClinic = VoxEngine.callPSTN(dest, cli);
    VoxEngine.easyProcess(toAgent, toClinic);
  });
  toAgent.addEventListener(CallEvents.Failed, () => {
    Logger.write("ru-callback inkbox failed");
    VoxEngine.terminate();
  });
  toAgent.addEventListener(CallEvents.Disconnected, () => VoxEngine.terminate());
}
