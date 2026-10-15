import { describe, expect, it } from "vitest";
import { isLocationCard, readLocationCard } from "@agent/lib/location/vcf";

function card(name: string, url: string) {
  return new TextEncoder().encode(
    [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "PRODID:-//Apple Inc.//iPhone OS 17//EN",
      `N:;${name};;;`,
      `FN:${name}`,
      `item1.URL;type=pref:${url}`,
      "item1.X-ABLabel:map url",
      "END:VCARD",
      "",
    ].join("\r\n")
  );
}

describe("iMessage location cards", () => {
  it("knows a card by its name or type", () => {
    expect(isLocationCard("CL.loc.vcf", undefined)).toBe(true);
    expect(isLocationCard("x.vcf", "text/x-vlocation")).toBe(true);
    expect(isLocationCard("contact.vcf", "text/vcard")).toBe(false);
  });

  it("reads the current location as where the person is", () => {
    for (const name of ["Current Location", "Моя геопозиция"]) {
      expect(
        readLocationCard(
          card(
            name,
            String.raw`http://maps.apple.com/?ll=55.751244\,37.618423&q=55.751244\,37.618423`
          )
        )
      ).toEqual({
        kind: "position",
        label: null,
        lat: 55.751244,
        lon: 37.618423,
      });
    }
  });

  it("reads a pin with its own name as a place", () => {
    expect(
      readLocationCard(
        card(
          "Кофемания",
          String.raw`https://maps.apple.com/?q=55.75\,37.61&ll=55.75\,37.61`
        )
      )
    ).toEqual({ kind: "place", label: "Кофемания", lat: 55.75, lon: 37.61 });
  });

  it("gives nothing for a card without a map point or a large file", () => {
    expect(
      readLocationCard(card("Current Location", "https://example.com/"))
    ).toBeUndefined();
    expect(readLocationCard(new Uint8Array(5_000))).toBeUndefined();
  });
});
