import type { EveDynamicToolPart, EveMessageInputRequest } from "eve/react";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Button } from "@web/components/ui/button";
import { ToolContent } from "@web/components/ai-elements/tool";
import { InputRequestActions, QuestionRequest } from "./input-request";
import { AgentMessagePart } from "./parts";
import type { RespondToAgentInput } from "./types";

const pendingApproval = {
  approval: { id: "legacy-approval" },
  input: { action: "allow", kind: "table" },
  state: "approval-requested",
  toolCallId: "legacy-call",
  toolMetadata: {
    eve: {
      inputRequest: {
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Approve", style: "primary" },
          { id: "cancel", label: "Cancel", style: "danger" },
        ],
        prompt: "Approve tool call: standing_permission",
        requestId: "legacy-request",
      },
      kind: "tool-call",
      name: "standing_permission",
    },
  },
  toolName: "standing_permission",
  type: "dynamic-tool",
} satisfies EveDynamicToolPart;

const missingInfoQuestion = {
  allowFreeform: true,
  kind: "question",
  options: [{ id: "tomorrow", label: "Завтра" }],
  prompt: "Когда забронировать столик?",
  requestId: "missing-info-request",
} satisfies EveMessageInputRequest;

describe("native approval prompts", () => {
  it("renders legacy pending approval as plain text and conversational actions", () => {
    const onInputResponses = vi.fn<RespondToAgentInput>();
    const markup = renderToStaticMarkup(
      <InputRequestActions
        canRespond
        onInputResponses={onInputResponses}
        part={pendingApproval}
      />
    );

    expect(markup).toContain(
      "Постоянное разрешение — такие поручения дальше без подтверждения:"
    );
    expect(markup).toContain("Подтвердить");
    expect(markup).toContain("Отмена");
    expect(markup).toContain('data-variant="act"');
    expect(markup).toContain('data-variant="quiet"');
    expect(markup).toContain('data-size="act-sm"');
    expect(markup).toMatch(/^<div class="space-y-2"><p class="/u);
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('data-slot="alert');
    expect(markup).not.toContain('data-slot="card');
    expect(markup).not.toContain("bg-warning");
    expect(markup).not.toContain("border-warning");
    expect(markup).not.toContain("disabled=");
    expect(onInputResponses).not.toHaveBeenCalled();
  });

  it("submits the original legacy request and option ids", () => {
    const onInputResponses = vi.fn<RespondToAgentInput>();
    const options = [
      { id: "approve-old-call", label: "Разрешить", style: "primary" },
      { id: "decline-old-call", label: "Не выполнять", style: "danger" },
    ] satisfies NonNullable<EveMessageInputRequest["options"]>;
    const part = {
      ...pendingApproval,
      toolMetadata: {
        eve: {
          ...pendingApproval.toolMetadata.eve,
          inputRequest: {
            ...pendingApproval.toolMetadata.eve.inputRequest,
            options,
          },
        },
      },
    } satisfies EveDynamicToolPart;
    const rendered: ReactNode = InputRequestActions({
      canRespond: true,
      onInputResponses,
      part,
    });

    expect(onInputResponses).not.toHaveBeenCalled();
    if (!isValidElement<{ children: ReactNode }>(rendered)) {
      throw new Error("The pending request must render.");
    }
    const actions = Children.toArray(rendered.props.children).find(
      (child) => isValidElement(child) && child.type === "div"
    );
    if (!isValidElement<{ children: ReactNode }>(actions)) {
      throw new Error("The pending request must have response actions.");
    }
    const buttons = Children.toArray(actions.props.children);
    expect(buttons).toHaveLength(options.length);
    for (const [index, button] of buttons.entries()) {
      if (
        !isValidElement<{
          children: ReactNode;
          disabled: boolean;
          onClick: () => void;
        }>(button)
      ) {
        throw new Error("Each option must render a response button.");
      }
      expect(button.type).toBe(Button);
      expect(button.props.disabled).toBe(false);
      expect(button.props.children).toBe(options[index]?.label);
      button.props.onClick();
      expect(onInputResponses).toHaveBeenNthCalledWith(index + 1, [
        { optionId: options[index]?.id, requestId: "legacy-request" },
      ]);
    }
    expect(onInputResponses).toHaveBeenCalledTimes(options.length);
  });

  it("keeps legacy pending choices visible but disabled when responses are unavailable", () => {
    const onInputResponses = vi.fn<RespondToAgentInput>();
    const markup = renderToStaticMarkup(
      <InputRequestActions
        canRespond={false}
        onInputResponses={onInputResponses}
        part={pendingApproval}
      />
    );

    expect(markup).toContain("Подтвердить");
    expect(markup).toContain("Отмена");
    expect(markup.match(/\sdisabled=""/gu)).toHaveLength(2);
    expect(onInputResponses).not.toHaveBeenCalled();
  });

  it.each(["approve", "cancel"])(
    "hides an already answered %s request even before the tool state updates",
    (optionId) => {
      const part = {
        ...pendingApproval,
        toolMetadata: {
          eve: {
            ...pendingApproval.toolMetadata.eve,
            inputResponse: { optionId, requestId: "legacy-request" },
          },
        },
      } satisfies EveDynamicToolPart;
      const markup = renderToStaticMarkup(
        <InputRequestActions
          canRespond
          onInputResponses={() => undefined}
          part={part}
        />
      );

      expect(markup).toBe("");
    }
  );

  it.each([
    {
      ...pendingApproval,
      approval: { approved: true, id: "legacy-approval" },
      state: "approval-responded",
    },
    {
      ...pendingApproval,
      approval: { approved: true, id: "legacy-approval" },
      output: "Разрешение сохранено.",
      state: "output-available",
    },
    {
      ...pendingApproval,
      approval: { approved: false, id: "legacy-approval" },
      state: "output-denied",
    },
    {
      ...pendingApproval,
      approval: { approved: true, id: "legacy-approval" },
      errorText: "Не удалось выполнить поручение.",
      state: "output-error",
    },
  ] satisfies readonly EveDynamicToolPart[])(
    "hides historical requests in $state state",
    (part) => {
      const markup = renderToStaticMarkup(
        <InputRequestActions
          canRespond
          onInputResponses={() => undefined}
          part={part}
        />
      );

      expect(markup).toBe("");
    }
  );

  it("preserves the readable completed tool result without its old confirmation", () => {
    const part = {
      ...pendingApproval,
      approval: { approved: true, id: "legacy-approval" },
      output: "Разрешение сохранено.",
      state: "output-available",
    } satisfies EveDynamicToolPart;
    const rendered: ReactNode = AgentMessagePart({
      canRespond: true,
      onInputResponses: () => undefined,
      part,
      showCaret: false,
      userVisibleOnly: false,
    });
    if (!isValidElement<{ children: ReactNode }>(rendered)) {
      throw new Error("The completed tool must still render.");
    }
    const content = Children.toArray(rendered.props.children).find(
      (child) => isValidElement(child) && child.type === ToolContent
    );
    if (!isValidElement<{ children: ReactNode }>(content)) {
      throw new Error("The completed tool must retain its content.");
    }
    const markup = renderToStaticMarkup(<>{content.props.children}</>);

    expect(markup).toContain("Разрешение сохранено.");
    expect(markup).not.toContain("Постоянное разрешение");
    expect(markup).not.toContain("Подтвердить");
    expect(markup).not.toContain('role="alert"');
  });
});

describe("missing-info questions", () => {
  it("keeps the question, answer choices, and freeform input available", () => {
    const onInputResponses = vi.fn<RespondToAgentInput>();
    const markup = renderToStaticMarkup(
      <QuestionRequest
        canRespond
        inputRequest={missingInfoQuestion}
        onInputResponses={onInputResponses}
      />
    );

    expect(markup).toContain("Когда забронировать столик?");
    expect(markup).toContain("Завтра");
    expect(markup).toContain("<textarea");
    expect(markup).toContain("Answer");
    expect(onInputResponses).not.toHaveBeenCalled();
  });

  it("keeps an answered question and its selected label readable", () => {
    const markup = renderToStaticMarkup(
      <QuestionRequest
        canRespond
        inputRequest={missingInfoQuestion}
        inputResponse={{
          optionId: "tomorrow",
          requestId: "missing-info-request",
        }}
        onInputResponses={() => undefined}
      />
    );

    expect(markup).toContain("Когда забронировать столик?");
    expect(markup).toContain("Responded: Завтра");
    expect(markup).toContain("disabled=");
  });
});
