import { describe, expect, it } from "vitest";
import type { PlaceInventory } from "@agent/lib/signatures/commands";
import { choosePlaces } from "@agent/lib/signatures/places";

type Place = PlaceInventory["places"][number];

function place(overrides: Partial<Place> = {}): Place {
  return {
    bro: null,
    empty: true,
    field: "signature",
    hidden: false,
    hint: "signature",
    label: "Подпись · (подпись)",
    marked: false,
    page: 1,
    type: "signature",
    ...overrides,
  };
}

/** A sign mark the task agent made with this workspace's token. */
function mark(
  role: "date" | "initials" | "signature",
  n: number,
  overrides: Partial<Place> = {}
) {
  return place({
    bro: { n, role },
    field: `bro_sign_${role}_${String(n)}`,
    hint: role,
    label: role === "date" ? "Дата" : "Наниматель",
    marked: true,
    type: role === "date" ? "text" : "signature",
    ...overrides,
  });
}

function inventory(
  places: Place[],
  overrides: Partial<PlaceInventory> = {}
): PlaceInventory {
  return {
    ok: true,
    pages: 3,
    places,
    signed_by_bro: false,
    signed_fields: [],
    status: "ok",
    ...overrides,
  };
}

const shared = { sourceKind: "shared" } as const;

describe("which places a signing fills", () => {
  it("takes the task agent's marks of a shared file over the form's own signature field", () => {
    const result = choosePlaces(
      inventory([
        place(),
        mark("signature", 1, { page: 1 }),
        mark("signature", 1, { page: 3 }),
        mark("date", 1, { page: 3 }),
      ]),
      shared
    );
    expect(result).toEqual({
      kind: "ok",
      plan: {
        pages: 3,
        places: [
          {
            field: "bro_sign_signature_1",
            label: "Наниматель",
            mark: true,
            pages: [1, 3],
            role: "signature",
          },
          {
            field: "bro_sign_date_1",
            label: "Дата",
            mark: true,
            pages: [3],
            role: "date",
          },
        ],
      },
    });
  });

  it("lets the person choose when the marked file came from them", () => {
    expect(
      choosePlaces(inventory([mark("signature", 1)]), {
        sourceKind: "attachment",
      })
    ).toMatchObject({ kind: "choose_fields" });
  });

  it("shows a mark without this workspace's token as foreign", () => {
    const result = choosePlaces(
      inventory([mark("signature", 9, { marked: false })]),
      shared
    );
    expect(result).toMatchObject({
      candidates: [{ field: "bro_sign_signature_9", foreign: true }],
      kind: "choose_fields",
    });
    // A token on one widget of a field does not vouch for its other ones.
    expect(
      choosePlaces(
        inventory([
          mark("signature", 1),
          mark("signature", 1, { marked: false, page: 3 }),
        ]),
        shared
      )
    ).toMatchObject({
      candidates: [{ foreign: true, pages: [1, 3] }],
      kind: "choose_fields",
    });
  });

  it("asks when a marked place is labelled as a counterparty's", () => {
    expect(
      choosePlaces(
        inventory([
          mark("signature", 1, { label: "Подпись наймодателя:" }),
          mark("signature", 2),
        ]),
        shared
      )
    ).toMatchObject({ kind: "choose_fields" });
  });

  it("keeps every label of a field's widgets and shows a counterparty's place as such", () => {
    expect(
      choosePlaces(
        inventory([
          place({ label: "Наниматель:", page: 1 }),
          place({ label: "Поручитель:", page: 3 }),
        ]),
        { sourceKind: "attachment" }
      )
    ).toMatchObject({
      candidates: [
        {
          counterparty: true,
          label: "Наниматель / Поручитель",
          pages: [1, 3],
        },
      ],
      kind: "choose_fields",
    });
  });

  it("fills exactly the fields chosen, and refuses a name or a stamp spot", () => {
    const places = [
      place(),
      place({ field: "signature_2", page: 2 }),
      place({ field: "fill_date", hint: "date", label: "Дата", type: "text" }),
      place({
        field: "sign_decoding",
        hint: "name",
        label: "(расшифровка)",
        type: "text",
      }),
    ];
    const chosen = choosePlaces(inventory(places), {
      fields: ["signature_2", "fill_date"],
      sourceKind: "attachment",
    });
    expect(
      chosen.kind === "ok" && chosen.plan.places.map(({ field }) => field)
    ).toEqual(["signature_2", "fill_date"]);
    expect(
      choosePlaces(inventory(places), {
        fields: ["sign_decoding", "nowhere"],
        sourceKind: "attachment",
      })
    ).toMatchObject({
      kind: "unknown_field",
      unknown: ["sign_decoding", "nowhere"],
    });
  });

  it("has no place to sign with only a date", () => {
    expect(choosePlaces(inventory([mark("date", 1)]), shared)).toEqual({
      kind: "no_places",
    });
  });

  it("refuses more than forty places", () => {
    const places = Array.from({ length: 41 }, (_, index) =>
      mark("signature", index + 1)
    );
    expect(choosePlaces(inventory(places), shared)).toEqual({
      kind: "too_many",
    });
  });

  it("never rewrites a digitally signed PDF", () => {
    expect(
      choosePlaces(
        inventory([mark("signature", 1)], { signed_fields: ["sig_bank"] }),
        shared
      )
    ).toEqual({ kind: "already_signed" });
  });

  it("passes on the kit's refusal of an encrypted PDF", () => {
    expect(
      choosePlaces(inventory([], { status: "encrypted" }), shared)
    ).toEqual({ kind: "encrypted" });
  });
});
