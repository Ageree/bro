import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InfrastructureSection } from "@app/(authenticated)/workspace/(overview)/page";
import * as Settings from "@db/services/settings";
import type { AccessScope } from "@shared/identity/access-scope";
import * as Admin from "@web/auth/admin";

// The selector is a client component that needs the tRPC provider.
vi.mock(
  "@app/(authenticated)/workspace/(overview)/_components/model-selector",
  () => ({ ModelSelector: () => "Выбрать" })
);

const adminMock = vi.spyOn(Admin, "isAdminScope");
const modelMock = vi.spyOn(Settings, "getWorkspaceModelId");

const scope = {
  userId: "better-auth:person-1",
  workspaceId: "personal:p1",
} satisfies AccessScope;

describe("cabinet infrastructure", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the owner the storage, the browser and the model", async () => {
    adminMock.mockResolvedValue(true);
    modelMock.mockResolvedValue("deepseek/deepseek-v4.1-flash");

    const html = renderToStaticMarkup(await InfrastructureSection({ scope }));

    expect(html).toContain("Инфраструктура");
    expect(html).toContain("Хранилище файлов");
    expect(html).toContain("Браузер");
    expect(html).toContain("deepseek/deepseek-v4.1-flash");
  });

  it("shows anyone else nothing, and reads no model for them", async () => {
    adminMock.mockResolvedValue(false);

    await expect(InfrastructureSection({ scope })).resolves.toBeNull();
    expect(modelMock).not.toHaveBeenCalled();
  });
});
