import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as agentMailClient from "@agent/lib/agent-mail/client";
import {
  agentMailSignUp,
  agentMailSignUpSentence,
  generatedPassword,
  registersWithAgentMail,
  saveAgentMailLogin,
  signUpLine,
  signUpUsername,
  siteAgentMailbox,
} from "@agent/lib/browser-use/sign-up";
import {
  type AccessScope,
  accessScopeForUser,
} from "@shared/identity/access-scope";
import {
  parseLoginVaultPayload,
  serializeLoginVaultPayload,
  type VaultCreateItem,
} from "@shared/vault/schema";

type Mailbox = Awaited<ReturnType<typeof agentMailClient.ensureAgentMailbox>>;

const mailbox = {
  createdAt: new Date(),
  displayName: "Bro",
  email: "quiet.fox42@agentmail.to",
  inboxId: "inbox-1",
  workspaceId: "workspace-1",
};

const ensureAgentMailbox = vi.hoisted(() =>
  vi.fn<() => Promise<Mailbox>>(() => Promise.resolve(null))
);
const readVaultItems = vi.hoisted(() =>
  vi.fn<
    () => Promise<
      {
        account: string;
        createdAt: string;
        hasSecret: boolean;
        id: string;
        kind: "login";
        label: string;
        updatedAt: string;
      }[]
    >
  >(() => Promise.resolve([]))
);
const readVaultSecret = vi.hoisted(() =>
  vi.fn<() => Promise<string | undefined>>(() => Promise.resolve(undefined))
);
const saveVaultItem = vi.hoisted(() =>
  vi.fn<(scope: AccessScope, item: VaultCreateItem) => Promise<string>>(() =>
    Promise.resolve("vault-1")
  )
);

vi.mock("@agent/lib/agent-mail/client", () => ({ ensureAgentMailbox }));
vi.mock("@db/services/vault", () => ({
  deleteVaultItem: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
  readVaultItems,
  readVaultSecret,
  saveVaultItem,
}));

const scope = accessScopeForUser("better-auth:alice");

/** A login saved for iNaturalist with `email`, as the vault lists it. */
function savedLogin(email: string) {
  readVaultItems.mockResolvedValue([
    {
      account: "www.inaturalist.org · q•••@agentmail.to",
      createdAt: new Date().toISOString(),
      hasSecret: true,
      id: "vault-1",
      kind: "login",
      label: "Аккаунт Бро на www.inaturalist.org",
      updatedAt: new Date().toISOString(),
    },
  ]);
  readVaultSecret.mockResolvedValue(
    serializeLoginVaultPayload({
      authentication: { password: "Secret-1!", type: "password" },
      identifier: { type: "email", value: email },
      kind: "login",
      origin: "https://www.inaturalist.org",
      version: 2,
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureAgentMailbox.mockResolvedValue(mailbox);
  readVaultItems.mockResolvedValue([]);
  readVaultSecret.mockResolvedValue(undefined);
});

describe("an account registered with Bro's own mailbox", () => {
  it("makes a fresh password most forms take", () => {
    const passwords = Array.from({ length: 50 }, generatedPassword);
    for (const password of passwords) {
      expect(password).toHaveLength(18);
      expect(password).toMatch(/[a-z]/u);
      expect(password).toMatch(/[A-Z]/u);
      expect(password).toMatch(/\d/u);
      expect(password).toContain("!");
      expect(password).toMatch(/^[A-Za-z2-9!]+$/u);
    }
    expect(new Set(passwords).size).toBe(passwords.length);
  });

  it("names the account after the mailbox", () => {
    expect(signUpUsername("quiet.fox42@agentmail.to")).toBe("quietfox42");
    expect(signUpUsername("42@agentmail.to")).toBe("bro42");
    expect(signUpUsername("a-very-long-mailbox-name-here@agentmail.to")).toBe(
      "averylongmailboxname"
    );
  });

  it("tells the run to type both by alias, and nothing of the person's", () => {
    const line = signUpLine("quietfox42");

    expect(line.startsWith(agentMailSignUpSentence)).toBe(true);
    expect(registersWithAgentMail(`Найди аккаунт\n\n${line}`)).toBe(true);
    expect(registersWithAgentMail("Зарегистрируйся на сайте")).toBe(false);
    expect(registersWithAgentMail(undefined)).toBe(false);
    expect(line).toContain(
      "the email address is the secret login_username and the password the secret login_password"
    );
    expect(line).toContain(
      "Never type the person's name, phone, own email, address, birth date or anything else of theirs"
    );
    expect(line).toContain("stop with NEEDS: email_code");
    expect(line).toContain(
      "Never write a password or a secret's value in your report."
    );
  });

  it("saves the account as the site's login in the vault", async () => {
    const id = await saveAgentMailLogin(scope, {
      email: mailbox.email,
      origin: "https://www.inaturalist.org",
    });

    expect(id).toBe("vault-1");
    const item = saveVaultItem.mock.calls[0]?.[1];
    expect(item).toMatchObject({
      kind: "login",
      label: "Аккаунт Бро на www.inaturalist.org",
    });
    const payload = parseLoginVaultPayload(item?.secret ?? "");
    expect(payload).toMatchObject({
      identifier: { type: "email", value: mailbox.email },
      origin: "https://www.inaturalist.org",
    });
    expect(payload?.authentication.type).toBe("password");
  });

  it("registers anew only where the vault has no login for the site", async () => {
    await expect(
      agentMailSignUp(scope, "https://www.inaturalist.org/signup")
    ).resolves.toEqual({
      email: mailbox.email,
      kind: "new",
      origin: "https://www.inaturalist.org",
      username: "quietfox42",
    });

    savedLogin("alice@example.com");
    await expect(
      agentMailSignUp(scope, "https://www.inaturalist.org")
    ).resolves.toEqual({ kind: "saved" });
  });

  it("registers nothing without a mailbox or an https site", async () => {
    await expect(agentMailSignUp(scope, "http://example.com")).resolves.toBe(
      undefined
    );
    ensureAgentMailbox.mockResolvedValue(null);
    await expect(
      agentMailSignUp(scope, "https://www.inaturalist.org")
    ).resolves.toBe(undefined);
  });

  it("reads the site's letters in Bro's mailbox only for Bro's own login", async () => {
    savedLogin(mailbox.email);
    await expect(
      siteAgentMailbox(scope, "https://www.inaturalist.org")
    ).resolves.toBe(mailbox);

    // The person's own login on the site: their Gmail has the letters.
    savedLogin("alice@example.com");
    await expect(
      siteAgentMailbox(scope, "https://www.inaturalist.org")
    ).resolves.toBe(undefined);

    await expect(siteAgentMailbox(scope, null)).resolves.toBe(undefined);
    ensureAgentMailbox.mockRejectedValue(new Error("down"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      siteAgentMailbox(scope, "https://www.inaturalist.org")
    ).resolves.toBe(undefined);
  });
});
