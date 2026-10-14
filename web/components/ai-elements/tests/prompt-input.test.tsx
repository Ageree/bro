import {
  createElement,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("motion/react", () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Vitest hoists mock factories above module-scope component values.
  const MotionDiv = ({
    layout,
    transition: _transition,
    ...props
  }: ComponentProps<"div"> & {
    layout?: boolean | string;
    transition?: unknown;
  }) => (
    <div
      data-motion-element="div"
      data-motion-layout={layout === undefined ? undefined : String(layout)}
      {...props}
    />
  );
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Vitest hoists mock factories above module-scope component values.
  const MotionSpan = ({
    layout,
    transition: _transition,
    ...props
  }: ComponentProps<"span"> & {
    layout?: boolean | string;
    transition?: unknown;
  }) => (
    <span
      data-motion-element="span"
      data-motion-layout={layout === undefined ? undefined : String(layout)}
      {...props}
    />
  );

  return {
    LazyMotion: ({ children }: { children: ReactNode }) => children,
    domMax: {},
    m: {
      create:
        (component: ComponentType<ComponentProps<"div">>) =>
        ({
          layout: _layout,
          transition: _transition,
          ...props
        }: ComponentProps<"div"> & {
          layout?: boolean | string;
          transition?: unknown;
        }) =>
          createElement(component, props),
      div: MotionDiv,
      span: MotionSpan,
    },
    useReducedMotion: () => false,
  };
});
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
} from "@web/components/ai-elements/prompt-input";

describe("prompt input", () => {
  it("anchors the compact submit button without dropping footer children", () => {
    const markup = renderToStaticMarkup(
      <PromptInput compact onSubmit={() => undefined}>
        <PromptInputFooter>
          <span>Composer tools</span>
          <PromptInputSubmit />
        </PromptInputFooter>
      </PromptInput>
    );

    expect(markup).toContain("Composer tools");
    expect(markup).toContain('aria-label="Submit"');
    expect(markup).toContain("absolute");
    expect(markup).toContain("right-1.5");
    expect(markup).toContain("bottom-1.5");
  });
});
