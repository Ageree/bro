import {
  claimPhoneActivation,
  changePhoneState,
  updatePhoneProvisioning,
  claimPhoneNumberRequests,
  finishPhoneNumberRequest,
  phonePilot,
  readHeldPhoneNumbers,
  readPhoneNumber,
  savePhoneQuote,
} from "@db/services/phone";
import type { AccessScope } from "@shared/identity/access-scope";
import { env } from "@shared/environment";
import * as exolve from "@shared/phone/exolve";
import * as elevenlabs from "@shared/phone/elevenlabs";
import { PhonePreflightError } from "@shared/phone/errors";
import { domesticPhoneSchema } from "@shared/phone/policy";

export async function activatePhone(
  scope: AccessScope,
  quoteId: string,
  automatic = false
) {
  await elevenlabs.requirePhoneAgentReady();
  const claim = await claimPhoneActivation(scope, quoteId);
  let row = claim.row;
  const token = row.leaseToken;
  let retryStage: typeof row.stage | null = null;
  if (!claim.claimed || !token) return row;
  const update = async (
    patch: Parameters<typeof updatePhoneProvisioning>[2],
    finish = false
  ) => {
    row = await updatePhoneProvisioning(row.id, token, patch, finish);
  };
  try {
    if (!row.numberId) {
      const owned = await exolve.findOwnedNumber(row.number);
      if (owned) {
        if (row.stage === "quoted") {
          await update({ state: "operator-required" }, true);
          return row;
        }
        await update({ numberId: owned.numberId, stage: "owned" });
      } else {
        if (row.stage !== "quoted") {
          // Stage `buying` without an owned number: the purchase may have
          // been charged. Never buy again, and stop retrying: the operator
          // is alerted by the schedule.
          await update({ state: "operator-required" }, true);
          return row;
        }
        await update({ stage: "buying" });
        retryStage = "quoted";
        const bought = await exolve.purchaseNumber({
          candidate: row.number,
          maxSetupRub: automatic ? env.PHONE_MAX_SETUP_RUB : row.setupRub,
          maxMonthlyRub: automatic ? env.PHONE_MAX_MONTHLY_RUB : row.monthlyRub,
          maxSipMonthlyRub: automatic
            ? env.PHONE_MAX_SIP_MONTHLY_RUB
            : row.sipMonthlyRub,
        });
        retryStage = null;
        if (bought.number !== row.number)
          throw new Error(
            "Purchased number does not match persisted candidate."
          );
        await update({ numberId: bought.numberId, stage: "owned" });
      }
    }
    const numberId = row.numberId;
    if (!numberId) throw new Error("Provider number id missing.");
    if (!row.sipId) {
      const sip = await exolve.findSip(numberId);
      if (sip) await update({ sipId: sip.sipId, stage: "sip-ready" });
      else {
        if (row.stage !== "owned")
          throw new Error(
            "SIP creation is ambiguous; operator reconciliation is required."
          );
        await update({ stage: "sip-creating" });
        retryStage = "owned";
        const created = await exolve.createSip({
          numberId,
          maxMonthlyRub: automatic
            ? env.PHONE_MAX_SIP_MONTHLY_RUB
            : row.sipMonthlyRub,
        });
        retryStage = null;
        await update({ sipId: created.sipId, stage: "sip-ready" });
      }
    }
    const sipId = row.sipId;
    if (!sipId) throw new Error("SIP id missing.");
    if (!row.phoneNumberId) {
      const imported = await elevenlabs.findPhoneNumber(row.number);
      if (imported) {
        if (imported.agentId !== env.PHONE_AGENT_ID)
          throw new Error("Imported phone is bound to another voice agent.");
        await update({ ...imported, stage: "imported" });
      } else {
        if (row.stage !== "sip-ready")
          throw new Error(
            "Phone import is ambiguous; operator reconciliation is required."
          );
        await update({ stage: "importing" });
        retryStage = "sip-ready";
        const importedPhone = await elevenlabs.importPhoneNumber({
          number: row.number,
          sipId,
        });
        retryStage = null;
        if (importedPhone.agentId !== env.PHONE_AGENT_ID)
          throw new Error("Unexpected voice agent mapping.");
        await update({ ...importedPhone, stage: "imported" });
      }
    }
    if (!row.outboundPhoneNumberId) {
      const outbound = await elevenlabs.findOutboundPhoneNumber({
        number: row.number,
        sipId,
      });
      if (outbound) {
        if (outbound.agentId !== env.PHONE_AGENT_ID)
          throw new Error("Outbound alias belongs to another voice agent.");
        await update({ ...outbound, stage: "outbound-imported" });
      } else {
        if (row.stage !== "imported")
          throw new Error(
            "Outbound alias import is ambiguous; reconcile before any repeat."
          );
        await update({ stage: "outbound-importing" });
        retryStage = "imported";
        const created = await elevenlabs.importOutboundPhoneNumber({
          number: row.number,
          sipId,
        });
        retryStage = null;
        if (created.agentId !== env.PHONE_AGENT_ID)
          throw new Error("Unexpected outbound alias voice agent mapping.");
        await update({ ...created, stage: "outbound-imported" });
      }
    }
    await update({ stage: "forwarding" });
    await exolve.configureForwarding({ numberId, number: row.number });
    if (!row.phoneNumberId || !row.outboundPhoneNumberId || !row.agentId)
      throw new Error(
        "Both inbound and outbound phone identities must be verified before activation."
      );
    const verified = await elevenlabs.verifyPhoneBinding({
      numberId,
      number: row.number,
      sipId,
      phoneNumberId: row.phoneNumberId,
      outboundPhoneNumberId: row.outboundPhoneNumberId,
      agentId: row.agentId,
    });
    if (
      verified.monthlyRub >
        (automatic
          ? env.PHONE_MAX_MONTHLY_RUB
          : Math.min(row.monthlyRub, env.PHONE_MAX_MONTHLY_RUB)) ||
      verified.sipMonthlyRub >
        (automatic
          ? env.PHONE_MAX_SIP_MONTHLY_RUB
          : Math.min(row.sipMonthlyRub, env.PHONE_MAX_SIP_MONTHLY_RUB))
    )
      throw new PhonePreflightError("FEE_CAP_CHANGED");
    await update({ ...verified, stage: "ready", state: "active" }, true);
    return row;
  } catch (error) {
    if (error instanceof PhonePreflightError && retryStage !== null) {
      await update(
        {
          state: retryStage === "quoted" ? "quoted" : "uncertain",
          stage: retryStage,
        },
        true
      );
    } else {
      await update(
        { state: row.stage === "quoted" ? "quoted" : "uncertain" },
        true
      );
    }
    return row;
  }
}

export async function provisionNewWorkspacePhones() {
  const requests = await claimPhoneNumberRequests();
  await Promise.all(
    requests.map(async (request) => {
      const token = request.leaseToken;
      if (!token) return;
      const scope = {
        workspaceId: request.workspaceId,
        userId: request.ownerUserId,
      };
      try {
        if (!phonePilot(scope)) {
          await finishPhoneNumberRequest(
            scope.workspaceId,
            token,
            "retry",
            "configuration"
          );
          return;
        }
        let number = await readPhoneNumber(scope);
        if (
          number &&
          ["active", "disabled", "released"].includes(number.state)
        ) {
          await finishPhoneNumberRequest(
            scope.workspaceId,
            token,
            "complete",
            null
          );
          return;
        }
        if (
          number?.state === "operator-required" ||
          number?.state === "releasing"
        ) {
          await finishPhoneNumberRequest(
            scope.workspaceId,
            token,
            "operator-required",
            "uncertain"
          );
          return;
        }
        if (!number || (number.state === "quoted" && !number.numberId)) {
          const quote = await exolve.quoteNumber(
            await readHeldPhoneNumbers(scope)
          );
          domesticPhoneSchema.parse(quote.candidate);
          if (
            ![quote.setupRub, quote.monthlyRub, quote.sipMonthlyRub].every(
              (fee) => Number.isInteger(fee) && fee >= 0
            ) ||
            quote.setupRub > env.PHONE_MAX_SETUP_RUB ||
            quote.monthlyRub > env.PHONE_MAX_MONTHLY_RUB ||
            quote.sipMonthlyRub > env.PHONE_MAX_SIP_MONTHLY_RUB
          )
            throw new PhonePreflightError("FEE_CAP_CHANGED");
          number = await savePhoneQuote(
            scope,
            {
              number: quote.candidate,
              setupRub: quote.setupRub,
              monthlyRub: quote.monthlyRub,
              sipMonthlyRub: quote.sipMonthlyRub,
              quotedAt: quote.quotedAt,
            },
            {
              sessionId: request.sessionId,
              conversationId: request.conversationId,
              conversationChannel: request.conversationChannel,
            }
          );
        }
        const provisioned = await activatePhone(scope, number.id, true);
        await finishPhoneNumberRequest(
          scope.workspaceId,
          token,
          provisioned.state === "active"
            ? "complete"
            : provisioned.state === "operator-required"
              ? "operator-required"
              : "retry",
          provisioned.state === "active"
            ? null
            : provisioned.state === "quoted"
              ? "preflight"
              : "uncertain"
        );
      } catch (error) {
        await finishPhoneNumberRequest(
          scope.workspaceId,
          token,
          "retry",
          error instanceof PhonePreflightError ? "preflight" : "configuration"
        );
      }
    })
  );
}

export async function releasePhone(scope: AccessScope) {
  const row = await changePhoneState(scope, "releasing");
  if (!row.leaseToken || row.state !== "releasing") return row;
  try {
    if (row.outboundPhoneNumberId)
      await elevenlabs.removePhoneNumber(row.outboundPhoneNumberId);
    if (row.phoneNumberId)
      await elevenlabs.removePhoneNumber(row.phoneNumberId);
    if (!row.numberId)
      throw new Error("Number ownership must be reconciled by the operator.");
    const disconnected = await exolve.disconnectNumber({
      numberId: row.numberId,
      sipId: row.sipId,
    });
    return await updatePhoneProvisioning(
      row.id,
      row.leaseToken,
      { state: disconnected.released ? "released" : "operator-required" },
      true
    );
  } catch {
    return updatePhoneProvisioning(
      row.id,
      row.leaseToken,
      { state: "operator-required" },
      true
    );
  }
}
