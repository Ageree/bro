import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ArtifactMessageImage,
  MessageResponse,
} from "@web/components/ai-elements/message";

describe("message response rendering", () => {
  it("renders settled text synchronously and streaming text incrementally", () => {
    expect(
      MessageResponse({ children: "Current response" }).props
    ).toMatchObject({
      children: "Current response",
      isAnimating: false,
      mode: "static",
    });
    expect(
      MessageResponse({ children: "Partial response", isAnimating: true }).props
    ).toMatchObject({
      children: "Partial response",
      isAnimating: true,
      mode: "streaming",
    });
  });

  it("words the external link window of Streamdown in Russian", () => {
    // The translations are typed whole, so a control added by a newer
    // Streamdown fails the type check until it is worded here.
    expect(
      MessageResponse({ children: "[сайт](https://e.com)" }).props
    ).toMatchObject({
      translations: {
        copyLink: "Скопировать ссылку",
        externalLinkWarning: "Ты переходишь на внешний сайт.",
        openExternalLink: "Открыть внешнюю ссылку?",
        openLink: "Открыть",
      },
    });
  });

  it("renders only authenticated artifact images inline", () => {
    const artifactMarkup = renderToStaticMarkup(
      createElement(ArtifactMessageImage, {
        alt: "Product",
        src: "/artifacts/0d01e667-d128-4bb7-a248-1ae21db72f4f",
      })
    );
    const externalMarkup = renderToStaticMarkup(
      createElement(ArtifactMessageImage, {
        alt: "External product",
        src: "https://example.com/product.png",
      })
    );

    expect(artifactMarkup).toContain("<img");
    expect(artifactMarkup).toContain('loading="lazy"');
    expect(artifactMarkup).toContain("/artifacts/0d01e667");
    expect(externalMarkup).toContain(
      "Изображение не показано: External product"
    );
    expect(externalMarkup).not.toContain("https://example.com/product.png");
  });
});
