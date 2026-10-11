import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as agentMailClient from "@agent/lib/agent-mail/client";
import {
  agentMailSignUp,
  agentMailSignUpSentence,
  generatedPassword,
  registersWithAgentMail,
  saveAgentMailLogin,
  settleSignUpLogin,
  signUpAccount,
  signUpLine,
  signUpSettlement,
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

const deleteVaultItem = vi.hoisted(() =>
  vi.fn<(scope: AccessScope, id: string) => Promise<boolean>>(() =>
    Promise.resolve(true)
  )
);

vi.mock("@agent/lib/agent-mail/client", () => ({ ensureAgentMailbox }));
vi.mock("@db/services/vault", () => ({
  deleteVaultItem,
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

  it("registers again with Bro's own login an earlier sign-up left", async () => {
    // 05.10: reCAPTCHA stopped the first sign-up, and the next one only
    // signed in to an account that was never made.
    savedLogin(mailbox.email);
    await expect(
      agentMailSignUp(scope, "https://www.inaturalist.org")
    ).resolves.toEqual({
      email: mailbox.email,
      kind: "again",
      origin: "https://www.inaturalist.org",
      username: "quietfox42",
    });
  });

  it("lets only a fresh login be taken out for a form never sent", () => {
    expect(signUpLine("quietfox42", true)).toContain("ACCOUNT: none");
    expect(signUpLine("quietfox42", false)).not.toContain("ACCOUNT: none");
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

describe("what a settled sign-up leaves in the vault", () => {
  const startTask = `Зарегистрируйся\n\n${signUpLine("quietfox42", true)}`;
  const followUpTask = `Bro took the code…\n\n${signUpLine("quietfox42")}`;
  const ended = { firstAttempt: true, missingSite: false, waitsOnStep: false };

  it("reads the run's word on the account from its footer", () => {
    expect(signUpAccount("RESULT: ok\nNEEDS: none\nACCOUNT: created")).toBe(
      "created"
    );
    expect(signUpAccount("- **ACCOUNT:** none")).toBe("none");
    expect(signUpAccount("ACCOUNT: maybe")).toBeUndefined();
    // The run answers in the errand's language too (iNaturalist, 05.10).
    expect(
      signUpAccount(
        "ACCOUNT: создан (сайт принял регистрацию; email подтверждён)"
      )
    ).toBe("created");
    expect(signUpAccount("ACCOUNT: зарегистрирован")).toBe("created");
    expect(signUpAccount("ACCOUNT: не создан, форма не отправлена")).toBe(
      "none"
    );
    expect(signUpAccount("ACCOUNT: нет")).toBe("none");
    expect(signUpAccount(null)).toBeUndefined();
    // Only the start is asked to say a form was never sent.
    expect(startTask).toContain("ACCOUNT: none when you never submitted");
    expect(followUpTask).not.toContain("ACCOUNT: none");
    expect(followUpTask).toContain("ACCOUNT: created once the site accepted");
  });

  it("tells of the account once it exists and the errand waits on nothing", () => {
    const created = {
      result: "NEEDS: none\nACCOUNT: created",
      task: startTask,
    };
    expect(signUpSettlement(created, ended)).toBe("created");
    expect(signUpSettlement({ ...created, task: followUpTask }, ended)).toBe(
      "created"
    );
    // Still waiting for the letter: nothing to tell yet.
    expect(
      signUpSettlement(created, { ...ended, waitsOnStep: true })
    ).toBeUndefined();
    // Not a sign-up at all.
    expect(
      signUpSettlement({ ...created, task: "Закажи корм" }, ended)
    ).toBeUndefined();
  });

  it("takes the login out only when the start surely never sent the form", () => {
    const unsent = { result: "NEEDS: none\nACCOUNT: none", task: startTask };
    expect(signUpSettlement(unsent, ended)).toBe("forget");
    expect(
      signUpSettlement(
        { result: null, task: startTask },
        {
          ...ended,
          missingSite: true,
        }
      )
    ).toBe("forget");
    // A later attempt after a wall: an earlier one may have sent it.
    expect(signUpSettlement(unsent, { ...ended, firstAttempt: false })).toBe(
      "kept"
    );
    // A follow-up saying «none» cannot undo the start's sign-up.
    expect(signUpSettlement({ ...unsent, task: followUpTask }, ended)).toBe(
      "kept"
    );
    // A failed run or a refusal without a word: unclear, so it stays.
    expect(
      signUpSettlement({ result: "NEEDS: none", task: startTask }, ended)
    ).toBe("kept");
  });

  it("says Bro keeps the login, sends no one to a page, never the password", async () => {
    savedLogin(mailbox.email);

    const line = await settleSignUpLogin(
      scope,
      "https://www.inaturalist.org",
      "created"
    );

    expect(line).toContain(
      "saved on your side as «Аккаунт Бро на www.inaturalist.org»"
    );
    expect(line).toContain("never point them to the vault");
    expect(line).toContain("забудь мой вход на www.inaturalist.org");
    expect(line).not.toContain("раздел «Сейф»");
    expect(line).not.toContain("/vault");
    expect(line).toContain("never write the password");
    expect(line).not.toContain("Secret-1!");
    expect(deleteVaultItem).not.toHaveBeenCalled();

    await expect(
      settleSignUpLogin(scope, "https://www.inaturalist.org", "kept")
    ).resolves.toContain("The login prepared for it stays saved on your side");
    expect(deleteVaultItem).not.toHaveBeenCalled();
  });

  it("takes out only Bro's own login for the site", async () => {
    savedLogin(mailbox.email);
    await expect(
      settleSignUpLogin(scope, "https://www.inaturalist.org", "forget")
    ).resolves.toContain("was taken out of the user's vault");
    expect(deleteVaultItem).toHaveBeenCalledWith(scope, "vault-1");

    // The person's own login on the site is never touched.
    deleteVaultItem.mockClear();
    savedLogin("alice@example.com");
    await expect(
      settleSignUpLogin(scope, "https://www.inaturalist.org", "forget")
    ).resolves.toBeUndefined();
    expect(deleteVaultItem).not.toHaveBeenCalled();
  });
});
