import type { SigningPlan } from "@db/services/signatures/signings";
import type { PlaceInventory } from "./commands";

type Place = PlaceInventory["places"][number];
type Role = SigningPlan["places"][number]["role"];

/** At most this many places go into one signing, or into a choice. */
const maximumPlaces = 40;
const labelCharacters = 40;

/**
 * Parties that are never the person signing their own form: a mark labelled
 * so is a counterparty's place however it was marked, and the person picks
 * the places. Roles that could be either side of a contract (исполнитель,
 * заказчик, продавец, покупатель) are not here: their labels reach the
 * question instead.
 */
const counterpartyLabel =
  /наймодател|арендодател|работодател|поручител|свидетел|нотариус|представител|кредитор|залогодерж|landlord|lessor|employer|witness|guarantor|notary|lender/u;

const foldedLabel = (label: string) =>
  label.normalize("NFKC").toLocaleLowerCase().replaceAll("ё", "е");

/**
 * The label as the question quotes it: one line, no «?» or «!» that would
 * end the question early, no trailing colon, at most 40 characters.
 */
function questionLabel(label: string) {
  const line = label
    .replaceAll(/[?!？！\r\n]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replace(/[\s:]+$/u, "");
  const short = Array.from(line).slice(0, labelCharacters).join("").trim();
  return short.length > 0 ? short : null;
}

/**
 * The role a widget can take: a mark's own (`bro_sign_<role>_<n>`), or a
 * form place's by the printed words around it — a signature or initials
 * into an unsigned signature field or an empty text field, a date only into
 * an empty text field. The name and the stamp spots («расшифровка»,
 * «М.П.») are never a place to sign.
 */
function eligibleRole(place: Place): Role | undefined {
  if (place.hidden) return undefined;
  const role = place.bro?.role ?? place.hint;
  const emptyText = place.type === "text" && place.empty;
  if (role === "date") return emptyText ? "date" : undefined;
  if (role === "signature" || role === "initials") {
    return place.type === "signature" || emptyText ? role : undefined;
  }
  return undefined;
}

interface Grouped {
  /** A widget of the field is labelled as a counterparty's. */
  readonly counterparty: boolean;
  readonly field: string;
  readonly label: string | null;
  readonly mark: boolean;
  readonly pages: number[];
  readonly role: Role;
  readonly trusted: boolean;
}

/** The eligible widgets by field: its role, its pages, its first label. */
function groupedPlaces(
  places: readonly Place[],
  sourceKind: "attachment" | "shared"
) {
  const fields = new Map<string, Grouped>();
  for (const place of places) {
    const role = eligibleRole(place);
    if (role === undefined) continue;
    const counterparty = counterpartyLabel.test(foldedLabel(place.label));
    const known = fields.get(place.field);
    if (known === undefined) {
      fields.set(place.field, {
        counterparty,
        field: place.field,
        label: questionLabel(place.label),
        mark: place.bro !== null,
        pages: [place.page],
        role,
        // A file the person sends back is checked by them, whatever marks
        // it carries.
        trusted: place.bro !== null && place.marked && sourceKind === "shared",
      });
      continue;
    }
    if (!known.pages.includes(place.page)) known.pages.push(place.page);
    fields.set(place.field, {
      ...known,
      counterparty: known.counterparty || counterparty,
      label: known.label ?? questionLabel(place.label),
    });
  }
  const grouped = [...fields.values()];
  for (const place of grouped) place.pages.sort((a, b) => a - b);
  return grouped;
}

const planPlace = ({ field, label, mark, pages, role }: Grouped) => ({
  field,
  label,
  mark,
  pages,
  role,
});

/**
 * Which places of the PDF a signing fills, decided here over the kit's
 * inventory (`listPlaces`): the fields the person chose (`fields`), else the
 * places the task agent marked with this workspace's token in a file it
 * shared, unless one of them is labelled as a counterparty's; otherwise the
 * person chooses. A PDF already carrying a digital signature is never
 * rewritten.
 */
export function choosePlaces(
  inventory: PlaceInventory,
  options: {
    readonly fields?: readonly string[];
    readonly sourceKind: "attachment" | "shared";
  }
) {
  if (inventory.status !== "ok") return { kind: inventory.status };
  if (inventory.signed_by_bro) return { kind: "signed_by_bro" as const };
  if (inventory.signed_fields.length > 0) {
    return { kind: "already_signed" as const };
  }
  const grouped = groupedPlaces(inventory.places, options.sourceKind);
  const candidates = grouped.slice(0, maximumPlaces).map((place) => {
    // A mark without this workspace's token, or in the person's own file.
    const candidate: ReturnType<typeof planPlace> & { foreign?: true } =
      planPlace(place);
    if (place.mark && !place.trusted) candidate.foreign = true;
    return candidate;
  });
  const plan = (chosen: readonly Grouped[]) => {
    if (!chosen.some(({ role }) => role !== "date")) {
      return { kind: "no_places" as const };
    }
    if (chosen.length > maximumPlaces) return { kind: "too_many" as const };
    return {
      kind: "ok" as const,
      plan: {
        pages: inventory.pages,
        places: chosen.map(planPlace),
      } satisfies SigningPlan,
    };
  };
  const fields = [...new Set(options.fields ?? [])];
  if (fields.length > 0) {
    const unknown = fields.filter(
      (field) => !grouped.some((place) => place.field === field)
    );
    if (unknown.length > 0) {
      return { candidates, kind: "unknown_field" as const, unknown };
    }
    return plan(grouped.filter((place) => fields.includes(place.field)));
  }
  const trusted = grouped.filter((place) => place.trusted);
  if (trusted.length > 0 && !trusted.some((place) => place.counterparty)) {
    return plan(trusted);
  }
  if (grouped.length === 0) return { kind: "no_places" as const };
  return { candidates, kind: "choose_fields" as const };
}
