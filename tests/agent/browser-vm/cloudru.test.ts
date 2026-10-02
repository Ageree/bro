import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserVmTestEnvironment,
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";

const compute = "https://compute.api.cloud.ru/api";
const iam = "https://iam.api.cloud.ru/api/v1/auth/token";
const organization = "https://organization.api.cloud.ru/v1";
const projectId = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const vmId = "0b4f7b52-8d33-4c7e-9a7d-1f3c1c7d9e11";

afterEach(() => {
  clearBrowserVmSettings();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

interface Call {
  readonly authorization: string | null;
  readonly body: string;
  readonly method: string;
  readonly signal: boolean;
  readonly url: string;
}

/**
 * Cloud.ru, scripted: IAM always hands out a token, and the rest answer from
 * the queue in order. Every call is recorded.
 */
function stubCloudRu(...answers: readonly (() => Response)[]) {
  const calls: Call[] = [];
  let next = 0;
  let tokens = 0;
  vi.stubGlobal(
    "fetch",
    (
      url: string,
      init: {
        body?: string;
        headers: HeadersInit;
        method: string;
        signal?: AbortSignal;
      }
    ) => {
      calls.push({
        authorization: new Headers(init.headers).get("authorization"),
        body: init.body ?? "",
        method: init.method,
        signal: init.signal !== undefined,
        url,
      });
      if (url === iam) {
        tokens += 1;
        return Promise.resolve(
          Response.json({ access_token: `iam-token-${String(tokens)}` })
        );
      }
      const answer = answers[next];
      next += 1;
      if (!answer) throw new Error("The test ran out of stubbed answers.");
      return Promise.resolve(answer());
    }
  );
  return calls;
}

async function loadCloudRu(settings = {}) {
  return importWithSettings(
    { ...browserVmTestEnvironment, ...settings },
    async () => import("@agent/lib/browser-vm/cloudru")
  );
}

function listedVm(index: number) {
  return {
    interfaces: [
      {
        floating_ip: { ip_address: `176.109.0.${String(index)}` },
        ip_address: `10.0.1.${String(index)}`,
      },
    ],
  };
}

const noContent = () => new Response(null, { status: 204 });

async function createTestVm(cloudRu: Awaited<ReturnType<typeof loadCloudRu>>) {
  return cloudRu.createCloudRuVm({
    cloudInit: "#cloud-config\n",
    name: "bro-x-1",
  });
}

describe("Cloud.ru VMs", () => {
  it("creates a VM from the sealed image in the key's first project", async () => {
    // Keys pasted from a chat arrived in typographic quotes and with a line
    // break inside; either broke every call with a 401.
    const cloudRu = await loadCloudRu({
      CLOUDRU_KEY_ID: "“test-key\n-id”",
      CLOUDRU_KEY_SECRET: " 'test-key-secret' ",
    });
    const calls = stubCloudRu(
      () => Response.json({ customers: [{ customer_id: "customer-1" }] }),
      () => Response.json({ projects: [{ id: projectId }] }),
      () =>
        Response.json(
          [{ id: vmId, name: "bro-personal-1", state: "creating" }],
          {
            status: 201,
          }
        )
    );
    const cloudInit = "#cloud-config\nruncmd: []\n";

    const created = await cloudRu.createCloudRuVm({
      cloudInit,
      name: "bro-personal-1",
    });

    expect(created).toEqual({
      id: vmId,
      image: "bro-browser-test-1",
      name: "bro-personal-1",
    });
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", iam],
      ["GET", `${organization}/customers`],
      ["GET", `${organization}/projects?customer_ids=customer-1`],
      ["POST", `${compute}/v1.1/vms`],
    ]);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      keyId: "test-key-id",
      secret: "test-key-secret",
    });
    expect(calls.slice(1).map((call) => call.authorization)).toEqual([
      "Bearer iam-token-1",
      "Bearer iam-token-1",
      "Bearer iam-token-1",
    ]);
    expect(calls.every((call) => call.signal)).toBe(true);
    // The API refuses a field it does not know, and wants the user data in
    // base64: these are the fields it took live.
    expect(JSON.parse(calls[3]?.body ?? "")).toEqual([
      {
        availability_zone_name: "ru.AZ-3",
        cloud_init: Buffer.from(cloudInit).toString("base64"),
        disks: [
          { disk_type_name: "SSD", name: "bro-personal-1-boot", size: 12 },
        ],
        flavor_name: "gen-2-4",
        image_name: "bro-browser-test-1",
        interfaces: [
          {
            new_external_ip: true,
            security_group_names: ["bro-browser"],
            subnet_name: "Default_ru.AZ-3",
            type: "regular",
          },
        ],
        name: "bro-personal-1",
        project_id: projectId,
      },
    ]);
  });

  it("creates a pool host from the stock image, without the sealed one", async () => {
    const cloudRu = await loadCloudRu({
      BROWSER_HOST_FLAVOR: "gen-8-32",
      CLOUDRU_BROWSER_IMAGE: "",
      CLOUDRU_PROJECT_ID: projectId,
    });
    const calls = stubCloudRu(() =>
      Response.json([{ id: vmId, name: "bro-host-1", state: "creating" }], {
        status: 201,
      })
    );

    expect(
      await cloudRu.createCloudRuHostVm({
        cloudInit: "#cloud-config\n",
        name: "bro-host-1",
      })
    ).toEqual({ id: vmId, image: "ubuntu-22.04", name: "bro-host-1" });
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual([
      {
        availability_zone_name: "ru.AZ-3",
        cloud_init: Buffer.from("#cloud-config\n").toString("base64"),
        disks: [{ disk_type_name: "SSD", name: "bro-host-1-boot", size: 40 }],
        flavor_name: "gen-8-32",
        image_name: "ubuntu-22.04",
        interfaces: [
          {
            new_external_ip: true,
            security_group_names: ["bro-browser"],
            subnet_name: "Default_ru.AZ-3",
            type: "regular",
          },
        ],
        name: "bro-host-1",
        project_id: projectId,
      },
    ]);
  });

  it("reuses the IAM token and the project it found", async () => {
    const cloudRu = await loadCloudRu();
    const calls = stubCloudRu(
      () => Response.json({ customers: [{ customer_id: "customer-1" }] }),
      () => Response.json({ projects: [{ id: projectId }] }),
      () => Response.json({ items: [] }),
      () => Response.json({ items: [] })
    );

    await cloudRu.deleteCloudRuBackupsOf(["disk-1"]);
    await cloudRu.deleteCloudRuBackupsOf(["disk-1"]);

    expect(calls.filter((call) => call.url === iam)).toHaveLength(1);
    expect(
      calls.filter((call) => call.url.startsWith(organization))
    ).toHaveLength(2);
  });

  it("takes the configured project without asking for one", async () => {
    const cloudRu = await loadCloudRu({ CLOUDRU_PROJECT_ID: projectId });
    const calls = stubCloudRu(() => Response.json({ items: [] }));

    await cloudRu.deleteCloudRuBackupsOf(["disk-1"]);

    expect(calls.map((call) => call.url)).toEqual([
      iam,
      `${compute}/v1/backups?limit=1000&offset=0&project_id=${projectId}`,
    ]);
  });

  it("reads the boot disk and the public address of a VM", async () => {
    const cloudRu = await loadCloudRu();
    stubCloudRu(() =>
      Response.json({
        disks: [
          { bootable: false, id: "disk-data", primary: false },
          { bootable: true, id: "disk-boot", primary: true },
        ],
        id: vmId,
        interfaces: [
          { floating_ip: null },
          { floating_ip: { id: "fip-1", ip_address: "45.132.176.116" } },
        ],
        name: "bro-personal-1",
        state: "running",
      })
    );

    expect(await cloudRu.readCloudRuVm(vmId)).toEqual({
      bootDiskId: "disk-boot",
      floatingIpId: "fip-1",
      host: "45.132.176.116",
      id: vmId,
      state: "running",
    });
  });

  it("reads a VM whose address is not assigned yet, and a deleted one as gone", async () => {
    const cloudRu = await loadCloudRu();
    stubCloudRu(
      () => Response.json({ id: vmId, state: "creating" }),
      () => Response.json({ message: "not found" }, { status: 404 })
    );

    expect(await cloudRu.readCloudRuVm(vmId)).toEqual({
      bootDiskId: undefined,
      floatingIpId: undefined,
      host: undefined,
      id: vmId,
      state: "creating",
    });
    expect(await cloudRu.readCloudRuVm(vmId)).toBeUndefined();
  });

  it("maps each VM's public address to its private one, page by page", async () => {
    const cloudRu = await loadCloudRu({ CLOUDRU_PROJECT_ID: projectId });
    const calls = stubCloudRu(
      () =>
        Response.json({
          items: [
            ...Array.from({ length: 98 }, (_, index) => listedVm(index + 1)),
            // No public address yet, and no interface at all: nothing to map.
            { interfaces: [{ floating_ip: null, ip_address: "10.0.1.200" }] },
            { interfaces: null },
          ],
        }),
      () => Response.json({ items: [listedVm(150)] })
    );

    const addresses = await cloudRu.listCloudRuPrivateAddresses();
    expect(addresses.size).toBe(99);
    expect(addresses.get("176.109.0.7")).toBe("10.0.1.7");
    expect(addresses.get("176.109.0.150")).toBe("10.0.1.150");
    expect(
      calls.filter((call) => call.url !== iam).map((call) => call.url)
    ).toEqual([
      `${compute}/v1/vms?limit=100&offset=0&project_id=${projectId}`,
      `${compute}/v1/vms?limit=100&offset=100&project_id=${projectId}`,
    ]);
  });

  it("finds a VM by its exact name in the project, and nothing for a name no VM has", async () => {
    const cloudRu = await loadCloudRu({ CLOUDRU_PROJECT_ID: projectId });
    const calls = stubCloudRu(
      () =>
        Response.json({
          items: [
            { id: "vm-other", name: "bro-personal-10", state: "running" },
            { id: vmId, name: "bro-personal-1", state: "running" },
          ],
        }),
      () =>
        Response.json({
          disks: [{ bootable: true, id: "disk-boot", primary: true }],
          id: vmId,
          interfaces: [
            { floating_ip: { id: "fip-1", ip_address: "45.132.176.116" } },
          ],
          name: "bro-personal-1",
          state: "running",
        }),
      () =>
        Response.json({
          items: [{ id: "vm-other", name: "bro-personal-10" }],
        })
    );

    expect(await cloudRu.findCloudRuVmByName("bro-personal-1")).toEqual({
      bootDiskId: "disk-boot",
      floatingIpId: "fip-1",
      host: "45.132.176.116",
      id: vmId,
      state: "running",
    });
    expect(await cloudRu.findCloudRuVmByName("bro-personal-1")).toBeUndefined();
    expect(
      calls.filter((call) => call.url !== iam).map((call) => call.url)
    ).toEqual([
      // Cloud.ru filters by a part of the name: "bro-personal-10" comes too.
      `${compute}/v1/vms?limit=100&name=bro-personal-1&project_id=${projectId}`,
      `${compute}/v1/vms/${vmId}`,
      `${compute}/v1/vms?limit=100&name=bro-personal-1&project_id=${projectId}`,
    ]);
  });

  it("repeats a read once after a server error, but never a power change", async () => {
    const cloudRu = await loadCloudRu();
    const calls = stubCloudRu(
      () => new Response("upstream", { status: 502 }),
      () => Response.json({ id: vmId, state: "stopped" }),
      () => new Response("upstream", { status: 502 })
    );

    expect((await cloudRu.readCloudRuVm(vmId))?.state).toBe("stopped");
    await expect(
      cloudRu.setCloudRuVmPower(vmId, "power_on")
    ).rejects.toMatchObject({ name: "CloudRuError", status: 502 });
    expect(
      calls.filter((call) => call.url !== iam).map((call) => call.method)
    ).toEqual(["GET", "GET", "POST"]);
    expect(JSON.parse(calls.at(-1)?.body ?? "")).toEqual({ state: "power_on" });
  });

  it("gets a new IAM token when the reused one is refused", async () => {
    const cloudRu = await loadCloudRu();
    const calls = stubCloudRu(
      () => new Response("expired", { status: 401 }),
      noContent
    );

    await cloudRu.setCloudRuVmPower(vmId, "power_off");

    expect(
      calls.map((call) => [
        call.url === iam ? "iam" : call.method,
        call.authorization,
      ])
    ).toEqual([
      ["iam", null],
      ["POST", "Bearer iam-token-1"],
      ["iam", null],
      ["POST", "Bearer iam-token-2"],
    ]);
  });

  it("deletes a VM with its disk and address, and takes one already gone as deleted", async () => {
    const cloudRu = await loadCloudRu();
    const calls = stubCloudRu(noContent, () =>
      Response.json({ message: "not found" }, { status: 404 })
    );
    const attachments = { diskIds: ["disk-boot"], floatingIpIds: ["fip-1"] };

    await cloudRu.deleteCloudRuVm(vmId, attachments);
    await cloudRu.deleteCloudRuVm(vmId, attachments);

    const deletions = calls.filter((call) => call.method === "DELETE");
    expect(deletions.map((call) => call.url)).toEqual([
      `${compute}/v1/vms/${vmId}`,
      `${compute}/v1/vms/${vmId}`,
    ]);
    expect(JSON.parse(deletions[0]?.body ?? "")).toEqual({
      delete_attachments: { disk_ids: ["disk-boot"], external_ips: ["fip-1"] },
    });
  });

  it("releases an address that outlived its VM", async () => {
    const cloudRu = await loadCloudRu();
    const calls = stubCloudRu(noContent);

    await cloudRu.deleteCloudRuFloatingIp("fip-1");

    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: `${compute}/v1/floating-ips/fip-1`,
    });
  });

  it("deletes the backups of the given disks and no others", async () => {
    const cloudRu = await loadCloudRu({ CLOUDRU_PROJECT_ID: projectId });
    const calls = stubCloudRu(
      () =>
        Response.json({
          items: [
            { id: "backup-1", resource: { resource_id: "disk-boot" } },
            { id: "backup-2", resource: { resource_id: "disk-of-another" } },
            { id: "backup-3", resource: null },
          ],
        }),
      noContent
    );

    expect(await cloudRu.deleteCloudRuBackupsOf(["disk-boot"])).toBe(1);
    expect(
      calls.filter((call) => call.method === "DELETE").map((call) => call.url)
    ).toEqual([`${compute}/v1/backups/backup-1`]);
  });

  it("pages through more backups than fit on one page", async () => {
    const cloudRu = await loadCloudRu({ CLOUDRU_PROJECT_ID: projectId });
    // A full first page (the API's own maximum) proves nothing on it; the match
    // sits on the second page, which a fix must still fetch and act on.
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      id: `filler-${String(index)}`,
      resource: { resource_id: "disk-of-another" },
    }));
    const calls = stubCloudRu(
      () => Response.json({ items: firstPage }),
      () =>
        Response.json({
          items: [
            { id: "backup-late", resource: { resource_id: "disk-boot" } },
          ],
        }),
      noContent
    );

    expect(await cloudRu.deleteCloudRuBackupsOf(["disk-boot"])).toBe(1);
    expect(
      calls
        .filter((call) => call.url.includes("/v1/backups?"))
        .map((call) => call.url)
    ).toEqual([
      `${compute}/v1/backups?limit=1000&offset=0&project_id=${projectId}`,
      `${compute}/v1/backups?limit=1000&offset=1000&project_id=${projectId}`,
    ]);
    expect(
      calls.filter((call) => call.method === "DELETE").map((call) => call.url)
    ).toEqual([`${compute}/v1/backups/backup-late`]);
  });

  it("asks nothing for no disks", async () => {
    const cloudRu = await loadCloudRu();
    const calls = stubCloudRu();

    expect(await cloudRu.deleteCloudRuBackupsOf([])).toBe(0);
    expect(calls).toEqual([]);
  });

  it("reports a refused create with its status and body", async () => {
    const cloudRu = await loadCloudRu({ CLOUDRU_PROJECT_ID: projectId });
    const calls = stubCloudRu(() =>
      Response.json({ detail: "quota exceeded: vcpu" }, { status: 403 })
    );

    const failure = cloudRu.createCloudRuVm({
      cloudInit: "#cloud-config\n",
      name: "bro-x-1",
    });

    await expect(failure).rejects.toBeInstanceOf(cloudRu.CloudRuError);
    await expect(failure).rejects.toMatchObject({
      body: '{"detail":"quota exceeded: vcpu"}',
      status: 403,
    });
    // A create is never repeated: a second VM would bill for nobody.
    expect(
      calls.filter((call) => call.method === "POST" && call.url !== iam)
    ).toHaveLength(1);
  });

  it("tells a create that never left from one that got no answer", async () => {
    const refusingIam = () => {
      const urls: string[] = [];
      vi.stubGlobal("fetch", (url: string) => {
        urls.push(url);
        return Promise.resolve(
          url === iam
            ? new Response("forbidden", { status: 403 })
            : Response.json({ message: "not found" }, { status: 404 })
        );
      });
      return urls;
    };

    // IAM refuses the key: whether on the project lookup or on the create
    // itself, nothing reached the compute API, and the refusal is IAM's.
    const refused = async (settings: Record<string, string>) => {
      const cloudRu = await loadCloudRu(settings);
      const urls = refusingIam();
      const failure = createTestVm(cloudRu);

      await expect(failure).rejects.toBeInstanceOf(cloudRu.CloudRuUnsentError);
      await expect(failure).rejects.toThrow("auth/token");
      expect(urls.filter((url) => url.startsWith(compute))).toEqual([]);
    };
    await refused({});
    await refused({ CLOUDRU_PROJECT_ID: projectId });

    const cloudRu = await loadCloudRu({ CLOUDRU_BROWSER_IMAGE: "" });
    const urls = refusingIam();
    await expect(createTestVm(cloudRu)).rejects.toBeInstanceOf(
      cloudRu.CloudRuUnsentError
    );
    expect(urls).toEqual([]);

    // A 404 from IAM is not the VM's: the VM is not read as gone.
    vi.stubGlobal("fetch", (url: string) =>
      Promise.resolve(
        new Response("no such key", { status: url === iam ? 404 : 200 })
      )
    );
    await expect(cloudRu.readCloudRuVm(vmId)).rejects.toBeInstanceOf(
      cloudRu.CloudRuUnsentError
    );
  });
});
