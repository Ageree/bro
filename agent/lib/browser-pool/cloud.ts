/**
 * The Cloud.ru calls the pool's hosts are made with, in one place: the
 * `cloudru` host mode (`BROWSER_HOST_CLOUD`) creates, powers and deletes the
 * hosts' VMs through them, and the `static` mode never calls any of them
 * (`agent/lib/browser-pool/hosts.ts` keeps the two apart).
 */
export {
  CloudRuError,
  CloudRuUnsentError,
  createCloudRuHostVm,
  deleteCloudRuFloatingIp,
  deleteCloudRuVm,
  findCloudRuVmByName,
  readCloudRuVm,
  setCloudRuVmPower,
} from "@agent/lib/browser-vm/cloudru";
