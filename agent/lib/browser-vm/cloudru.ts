import { z } from "zod";
import { env } from "@shared/environment";

/**
 * The slice of the Cloud.ru Evolution API the browser VMs need: create one
 * from the sealed image, read it, power it, delete it with what it leaves
 * billed. Verified against the live API with `browser-vm/image/build.py` and
 * `scripts/cloudru-browser-pilot/vm.py` (see that folder's README).
 */
const iamTokenUrl = "https://iam.api.cloud.ru/api/v1/auth/token";
const organizationApi = "https://organization.api.cloud.ru/v1";
const computeApi = "https://compute.api.cloud.ru/api";

/** Pool hosts boot the stock image: the project keeps at most two of its own. */
const hostImage = "ubuntu-22.04";
/**
 * A pool host's disk: the sandbox root, the staged tar and zstd of two parks
 * at once, and the profiles of the sandboxes it holds.
 */
const hostDiskGb = 40;

/** Every call is bounded: the poller's tick must not wait on one forever. */
const requestTimeoutMs = 30_000;
/** How long an IAM token is reused, well inside the hour it lives. */
const accessTokenReuseMs = 50 * 60_000;

const accessTokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
});

const customersSchema = z.object({
  customers: z.tuple(
    [z.object({ customer_id: z.string().min(1) })],
    z.unknown()
  ),
});

const projectsSchema = z.object({
  projects: z.tuple([z.object({ id: z.string().min(1) })], z.unknown()),
});

// The create endpoint takes an array and answers with one: one VM each time.
const createdVmsSchema = z.tuple(
  [z.object({ id: z.string().min(1), name: z.string() })],
  z.unknown()
);

const floatingIpSchema = z.object({
  id: z.string().min(1),
  ip_address: z.string().nullish(),
});

/**
 * A VM as the lifecycle reads it: its power state, the boot disk that holds
 * the person's profile, and the public address its worker answers on. The
 * address comes a little after the VM itself, so both may be missing on an
 * early read.
 */
const vmSchema = z
  .object({
    disks: z
      .array(
        z.object({
          bootable: z.boolean().nullish(),
          id: z.string().min(1),
          primary: z.boolean().nullish(),
        })
      )
      .nullish(),
    id: z.string().min(1),
    interfaces: z
      .array(z.object({ floating_ip: floatingIpSchema.nullish() }))
      .nullish(),
    state: z.string().min(1),
  })
  .transform((vm) => {
    const floatingIps = (vm.interfaces ?? []).flatMap((item) =>
      item.floating_ip ? [item.floating_ip] : []
    );
    const floatingIp =
      floatingIps.find((item) => item.ip_address) ?? floatingIps[0];
    return {
      bootDiskId: vm.disks?.find(
        (disk) => disk.primary === true || disk.bootable === true
      )?.id,
      floatingIpId: floatingIp?.id,
      host: floatingIp?.ip_address ?? undefined,
      id: vm.id,
      state: vm.state,
    };
  });

// A listing carries more per VM, but only the name finds it: the full read
// follows by id, so a found VM has the same shape as `readCloudRuVm` gives.
const vmListSchema = z.object({
  items: z.array(z.object({ id: z.string().min(1), name: z.string() })),
});

/**
 * Both addresses of each VM in a listing: the floating IP the world (and
 * its sslip.io name) knows it by, and the address in the project's subnet.
 */
const vmAddressListSchema = z.object({
  items: z.array(
    z.object({
      interfaces: z
        .array(
          z.object({
            floating_ip: z
              .object({ ip_address: z.string().nullish() })
              .nullish(),
            ip_address: z.string().nullish(),
          })
        )
        .nullish(),
    })
  ),
});

const backupListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      resource: z.object({ resource_id: z.string().nullish() }).nullish(),
    })
  ),
});

/** A Cloud.ru reply that was not a 2xx, with enough of the body to act on. */
export class CloudRuError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, path: string, body: string) {
    super(`Cloud.ru ${String(status)} on ${path}: ${body.slice(0, 300)}`);
    this.name = "CloudRuError";
    this.status = status;
    this.body = body;
  }
}

/**
 * A call that failed before its request left for Cloud.ru: the image, the
 * key, its IAM token or the project could not be had. Nothing was asked of
 * the API, so a create that fails so made no VM, unlike one that went out
 * and got no answer; and an IAM refusal is never read as the API's own.
 */
export class CloudRuUnsentError extends Error {
  constructor(cause: unknown) {
    super(
      `Cloud.ru was not asked: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = "CloudRuUnsentError";
  }
}

/**
 * Create a workspace's VM from the sealed browser image, with a public
 * address and the security group that lets HTTPS reach its worker. The
 * answer comes before the VM runs; `readCloudRuVm` follows it up. Throws
 * `CloudRuUnsentError` when the create never left.
 */
export async function createCloudRuVm(input: {
  /** The user data, as YAML: the API wants it base64-encoded. */
  readonly cloudInit: string;
  readonly name: string;
}) {
  const image = env.CLOUDRU_BROWSER_IMAGE;
  if (image === undefined) {
    throw new CloudRuUnsentError("CLOUDRU_BROWSER_IMAGE is not configured.");
  }
  return createVm({
    ...input,
    diskGb: env.CLOUDRU_BROWSER_DISK_GB,
    flavor: env.CLOUDRU_BROWSER_FLAVOR,
    image,
  });
}

/**
 * Create a host of the browser pool: the stock Ubuntu image, which the
 * cloud-init sets up (`browser-vm/host/boot.py`), on BROWSER_HOST_FLAVOR,
 * with a public address and the same security group, subnet and zone as
 * the browser VMs. Throws `CloudRuUnsentError` when the create never left.
 */
export async function createCloudRuHostVm(input: {
  /** The user data, as YAML: the API wants it base64-encoded. */
  readonly cloudInit: string;
  readonly name: string;
}) {
  return createVm({
    ...input,
    diskGb: hostDiskGb,
    flavor: env.BROWSER_HOST_FLAVOR,
    image: hostImage,
  });
}

async function createVm(input: {
  readonly cloudInit: string;
  readonly diskGb: number;
  readonly flavor: string;
  readonly image: string;
  readonly name: string;
}) {
  const { image } = input;
  const projectId = await beforeSending(cloudRuProjectId);
  // The API refuses any field it does not know (422 `extra_forbidden`).
  const body = JSON.stringify([
    {
      availability_zone_name: env.CLOUDRU_ZONE,
      cloud_init: Buffer.from(input.cloudInit).toString("base64"),
      disks: [
        {
          disk_type_name: "SSD",
          name: `${input.name}-boot`,
          size: input.diskGb,
        },
      ],
      flavor_name: input.flavor,
      image_name: image,
      interfaces: [
        {
          new_external_ip: true,
          security_group_names: [env.CLOUDRU_SECURITY_GROUP],
          subnet_name: env.CLOUDRU_SUBNET,
          type: "regular",
        },
      ],
      name: input.name,
      project_id: projectId,
    },
  ]);
  const [created] = createdVmsSchema.parse(
    await request("POST", `${computeApi}/v1.1/vms`, body)
  );
  return { id: created.id, image, name: created.name };
}

/** The VM, or undefined once it is gone. */
export async function readCloudRuVm(vmId: string) {
  try {
    return vmSchema.parse(
      await request("GET", `${computeApi}/v1/vms/${encodeURIComponent(vmId)}`)
    );
  } catch (error) {
    if (error instanceof CloudRuError && error.status === 404) return undefined;
    throw error;
  }
}

/**
 * The VM of this name in the project, or undefined when there is none: how a
 * create whose answer was lost finds the VM it may have made. The listing is
 * matched by the exact name, as `scripts/cloudru-browser-pilot/vm.py` does.
 */
export async function findCloudRuVmByName(name: string) {
  // The API's name filter matches a part of the name ("bro-x-1" lists
  // "bro-x-10" too), so the exact match stays here.
  const query = new URLSearchParams({
    limit: "100",
    name,
    project_id: await cloudRuProjectId(),
  });
  const { items } = vmListSchema.parse(
    await request("GET", `${computeApi}/v1/vms?${query.toString()}`)
  );
  const found = items.find((item) => item.name === name);
  return found === undefined ? undefined : readCloudRuVm(found.id);
}

/**
 * Power a VM on or off, or reboot it. The answer comes at once; the state
 * changes over the next minute (`stopping` → `stopped`).
 */
export async function setCloudRuVmPower(
  vmId: string,
  state: "power_off" | "power_on" | "reboot"
) {
  await request(
    "POST",
    `${computeApi}/v1/vms/${encodeURIComponent(vmId)}/set-power`,
    JSON.stringify({ state })
  );
}

/**
 * Delete a VM with the attachments named. The boot disk dies with the VM
 * anyway; a floating IP left out stays and is billed. A VM already gone
 * counts as deleted, so a deletion retried after a lost answer settles.
 */
export async function deleteCloudRuVm(
  vmId: string,
  attachments: {
    readonly diskIds: readonly string[];
    readonly floatingIpIds: readonly string[];
  }
) {
  await deleteGone(
    `${computeApi}/v1/vms/${encodeURIComponent(vmId)}`,
    JSON.stringify({
      delete_attachments: {
        disk_ids: attachments.diskIds,
        external_ips: attachments.floatingIpIds,
      },
    })
  );
}

/** Release a public address that outlived its VM. */
export async function deleteCloudRuFloatingIp(floatingIpId: string) {
  await deleteGone(
    `${computeApi}/v1/floating-ips/${encodeURIComponent(floatingIpId)}`
  );
}

/** A page of `/v1/vms`, and how many pages a project could plausibly fill. */
const vmsPageLimit = 100;
const vmsPageCap = 10;

/**
 * The project's VMs as public address → private address. A VM of the
 * project cannot reach another one's public address (no hairpin, 02.10.2026)
 * but does reach its private one, so `agent/lib/browser-vm/private-route.ts`
 * dials this instead, under the same name and certificate.
 */
export async function listCloudRuPrivateAddresses() {
  const projectId = await cloudRuProjectId();
  const addresses = new Map<string, string>();
  for (let pageIndex = 0; pageIndex < vmsPageCap; pageIndex += 1) {
    const query = new URLSearchParams({
      limit: String(vmsPageLimit),
      offset: String(pageIndex * vmsPageLimit),
      project_id: projectId,
    });
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each page needs the previous page's offset.
    const page = await request(
      "GET",
      `${computeApi}/v1/vms?${query.toString()}`
    );
    const { items } = vmAddressListSchema.parse(page);
    for (const item of items) {
      for (const face of item.interfaces ?? []) {
        const publicAddress = face.floating_ip?.ip_address;
        const privateAddress = face.ip_address;
        if (publicAddress && privateAddress) {
          addresses.set(publicAddress, privateAddress);
        }
      }
    }
    if (items.length < vmsPageLimit) break;
  }
  return addresses;
}

/** The API's own maximum page size for `/v1/backups` (its default is only 50). */
const backupsPageLimit = 1000;
/** However deep a real project's backups could plausibly run; a loop stuck past
 * this is a bug (or a wildly larger fleet than this one), not patience. */
const backupsPageCap = 25;

/**
 * Delete every backup taken of these disks: a backup of a boot disk is a copy
 * of the person's browser profile, and it must not outlive their account.
 * Returns how many were deleted.
 *
 * `/v1/backups` paginates (`offset`/`limit`) like every other Cloud.ru listing
 * here: a project with more backups across its whole fleet than one page
 * holds must not leave a later page's match undeleted — a billed, forgotten
 * profile that was never cleaned up.
 */
export async function deleteCloudRuBackupsOf(diskIds: readonly string[]) {
  if (diskIds.length === 0) return 0;
  const projectId = await cloudRuProjectId();
  const items: z.infer<typeof backupListSchema>["items"] = [];
  let offset = 0;
  for (let pageIndex = 0; pageIndex < backupsPageCap; pageIndex += 1) {
    const query = new URLSearchParams({
      limit: String(backupsPageLimit),
      offset: String(offset),
      project_id: projectId,
    });
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each page needs the previous page's offset.
    const page = await request(
      "GET",
      `${computeApi}/v1/backups?${query.toString()}`
    );
    const listed = backupListSchema.parse(page);
    items.push(...listed.items);
    offset += listed.items.length;
    if (listed.items.length < backupsPageLimit) break;
    if (pageIndex === backupsPageCap - 1) {
      console.warn("[browser-vm] gave up paging through Cloud.ru backups", {
        pages: backupsPageCap,
        seen: items.length,
      });
    }
  }
  const doomed = items.filter((item) => {
    const resourceId = item.resource?.resource_id ?? undefined;
    return resourceId !== undefined && diskIds.includes(resourceId);
  });
  await Promise.all(
    doomed.map(async (item) =>
      deleteGone(`${computeApi}/v1/backups/${encodeURIComponent(item.id)}`)
    )
  );
  return doomed.length;
}

/** A step a request needs before it is sent: its failure sent nothing. */
async function beforeSending<T>(step: () => Promise<T>) {
  try {
    return await step();
  } catch (error) {
    if (error instanceof CloudRuUnsentError) throw error;
    throw new CloudRuUnsentError(error);
  }
}

async function deleteGone(url: string, body?: string) {
  try {
    await request("DELETE", url, body);
  } catch (error) {
    if (error instanceof CloudRuError && error.status === 404) return;
    throw error;
  }
}

let discoveredProjectId: string | undefined;

/**
 * The project the VMs live in: the configured one, or the first project of
 * the key's customer, looked up once per instance. The projects endpoint
 * answers an unfiltered call with an error, so the customer comes first.
 */
async function cloudRuProjectId() {
  if (env.CLOUDRU_PROJECT_ID !== undefined) return env.CLOUDRU_PROJECT_ID;
  if (discoveredProjectId !== undefined) return discoveredProjectId;
  const {
    customers: [customer],
  } = customersSchema.parse(
    await request("GET", `${organizationApi}/customers`)
  );
  const query = new URLSearchParams({ customer_ids: customer.customer_id });
  const {
    projects: [project],
  } = projectsSchema.parse(
    await request("GET", `${organizationApi}/projects?${query.toString()}`)
  );
  discoveredProjectId = project.id;
  return project.id;
}

let accessToken:
  | { readonly expiresAt: number; readonly value: string }
  | undefined;

/** A bearer token for the service account, reused while it lives. */
async function iamToken() {
  if (accessToken !== undefined && accessToken.expiresAt > Date.now()) {
    return accessToken.value;
  }
  const keyId = env.CLOUDRU_KEY_ID;
  const secret = env.CLOUDRU_KEY_SECRET;
  if (keyId === undefined || secret === undefined) {
    throw new Error(
      "CLOUDRU_KEY_ID and CLOUDRU_KEY_SECRET are not configured."
    );
  }
  const response = await fetch(iamTokenUrl, {
    body: JSON.stringify({ keyId, secret }),
    headers: { accept: "application/json", "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const token = accessTokenSchema.parse(await answer(response, iamTokenUrl));
  // A minute short of what IAM says, so a token is never sent as it expires.
  const reuseMs = Math.min(
    accessTokenReuseMs,
    token.expires_in === undefined
      ? accessTokenReuseMs
      : token.expires_in * 1_000 - 60_000
  );
  accessToken = { expiresAt: Date.now() + reuseMs, value: token.access_token };
  return token.access_token;
}

async function request(
  method: "DELETE" | "GET" | "POST",
  url: string,
  body?: string
) {
  // A read, a deletion or a power change on a VM that already has it is safe
  // to send twice. A create is not: one cut off after it landed would leave a
  // second VM billing for nobody, so a failed POST is the caller's to judge.
  const repeatable = method !== "POST";
  const attempt = async () => {
    const init: RequestInit = {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${await beforeSending(iamToken)}`,
        "content-type": "application/json",
      },
      method,
      signal: AbortSignal.timeout(requestTimeoutMs),
    };
    if (body !== undefined) init.body = body;
    return fetch(url, init);
  };
  const send = async () => {
    try {
      return await attempt();
    } catch (error) {
      if (!repeatable) throw error;
      return attempt();
    }
  };
  let response = await send();
  if (response.status === 401) {
    // The reused IAM token died early; a 401 means nothing was done.
    accessToken = undefined;
    response = await send();
  } else if (repeatable && response.status >= 500) {
    response = await attempt();
  }
  return answer(response, url);
}

async function answer(response: Response, url: string) {
  const path = new URL(url).pathname;
  const text = await response.text();
  if (!response.ok) throw new CloudRuError(response.status, path, text);
  try {
    // A 204 has no body, and nothing is read from it.
    return z.json().parse(text ? JSON.parse(text) : null);
  } catch {
    throw new CloudRuError(response.status, path, text);
  }
}
