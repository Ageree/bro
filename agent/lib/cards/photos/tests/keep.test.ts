import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { fetchPublic } from "@agent/lib/sandbox/public-fetch";
import { cardPhotoObject } from "@shared/cards/photos";
import { type Card, cardSchema } from "@shared/cards/schema";
import type * as Artifacts from "@shared/object-storage/artifacts";
import { contains, gpsText, jpeg, png } from "./images";

const network = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetchPublic>(),
}));
const store = vi.hoisted(() => ({
  configured: true,
  delete: vi.fn<typeof Artifacts.deleteArtifactObject>(),
  put: vi.fn<typeof Artifacts.putArtifactObject>(),
}));

vi.mock("@agent/lib/sandbox/public-fetch", () => ({
  fetchPublic: network.fetch,
}));
vi.mock("@shared/object-storage/artifacts", () => ({
  artifactStorageConfigured: () => store.configured,
  deleteArtifactObject: store.delete,
  putArtifactObject: store.put,
}));

import { keepCardPhotos } from "../keep";

const cardId = "C".repeat(43);
const photo = jpeg({ height: 600, orientation: 6, width: 800 });

/** What the sites answer, by address; anything else is a 404. */
let site: Map<string, () => Response>;

const image =
  (bytes: Uint8Array, type = "image/jpeg") =>
  () =>
    new Response(Buffer.from(bytes), { headers: { "content-type": type } });

function shot(name: string) {
  return {
    alt: `Фото ${name}`,
    url: `https://photos.example.com/${name}.jpg`,
  };
}

function card(blocks: readonly object[]) {
  return cardSchema.parse({ blocks, title: "Варианты" });
}

const gallery = (...names: string[]) => ({
  photos: names.map(shot),
  type: "gallery",
});

const carousel = (...names: string[]) => ({
  layout: "carousel",
  rows: names.map((name) => ({
    photo: shot(name),
    side: "1 000 ₽",
    title: name,
  })),
  type: "list",
});

function urls(kept: Card | undefined) {
  return JSON.stringify(kept).match(/"(?:https:\/\/|\/api\/)[^"]+"/gu);
}

function stored() {
  return store.put.mock.calls.map(([object]) => object.pathname);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  store.configured = true;
  store.put.mockResolvedValue();
  store.delete.mockResolvedValue();
  site = new Map();
  network.fetch.mockImplementation((url) =>
    Promise.resolve(
      site.get(url.href)?.() ?? new Response("Not found", { status: 404 })
    )
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("keeping a card's photos", () => {
  it("reuses only this card's already-kept copies when a revision adds photos", async () => {
    const previous = card([
      { type: "image", url: `/api/cards/${cardId}/photos/4`, alt: "Номер" },
    ]);
    site.set(shot("new").url, image(photo));
    const next = card([...previous.blocks, { type: "image", ...shot("new") }]);

    const kept = await keepCardPhotos(cardId, next, previous);

    expect(kept.card?.blocks[0]).toEqual(previous.blocks[0]);
    expect(kept).toMatchObject({ kept: 2, dropped: 0 });
    expect(network.fetch).toHaveBeenCalledOnce();
    expect(store.put).toHaveBeenCalledOnce();
    expect(store.delete).not.toHaveBeenCalled();
  });
  it("copies each photo under the card's link, without its metadata, and points the card at the copies", async () => {
    for (const name of ["living", "kitchen", "roborock", "dreame"]) {
      site.set(shot(name).url, image(photo));
    }

    const kept = await keepCardPhotos(
      cardId,
      card([gallery("living", "kitchen"), carousel("roborock", "dreame")])
    );

    expect(kept).toMatchObject({ droppedBlocks: [], dropped: 0, kept: 4 });
    expect(urls(kept.card)).toEqual(
      [0, 1, 2, 3].map(
        (number) => `"/api/cards/${cardId}/photos/${String(number)}"`
      )
    );
    expect(stored().toSorted()).toEqual(
      [0, 1, 2, 3].map((number) => cardPhotoObject(cardId, number)).toSorted()
    );
    for (const [object] of store.put.mock.calls) {
      expect(object.mediaType).toBe("image/jpeg");
      expect(contains(object.bytes, gpsText)).toBe(false);
    }
    expect(kept.card?.blocks[1]).toMatchObject({ layout: "carousel" });
  });

  it("drops a whole set when one of its photos fails, with the copies it had kept", async () => {
    site.set(shot("living").url, image(photo));
    site.set(shot("roborock").url, image(photo));
    site.set(
      shot("xiaomi").url,
      image(png({ height: 480, width: 640 }), "image/png")
    );

    const kept = await keepCardPhotos(
      cardId,
      card([
        gallery("living", "living"),
        carousel("roborock", "dreame", "xiaomi"),
      ])
    );

    expect(kept).toMatchObject({ droppedBlocks: [1], dropped: 3, kept: 2 });
    expect(kept.card?.blocks[1]).toMatchObject({
      layout: "rows",
      type: "list",
    });
    expect(JSON.stringify(kept.card?.blocks[1])).not.toContain("photo");
    const listCopies = new Set(
      [1, 2, 3].map((number) => cardPhotoObject(cardId, number))
    );
    const deleted = store.delete.mock.calls.map(([object]) => object);
    for (const object of stored().filter((path) => listCopies.has(path))) {
      expect(deleted).toContain(object);
    }
    expect(urls(kept.card)).toEqual([
      `"/api/cards/${cardId}/photos/0"`,
      `"/api/cards/${cardId}/photos/0"`,
    ]);
  });

  it("goes by the bytes, not by what the server calls them", async () => {
    site.set(
      shot("page").url,
      image(new Uint8Array(Buffer.from("<!doctype html><title>Фото</title>")))
    );

    expect(
      await keepCardPhotos(
        cardId,
        card([gallery("page", "page"), { text: "Квартира", type: "text" }])
      )
    ).toMatchObject({
      dropped: 2,
      kept: 0,
    });
    expect(store.put).not.toHaveBeenCalled();
  });

  it("refuses a photo past 8 MB and one under 200 px on a side", async () => {
    site.set(
      shot("huge").url,
      () =>
        new Response("x", {
          headers: { "content-length": String(9 * 1024 * 1024) },
        })
    );
    site.set(shot("tiny").url, image(jpeg({ height: 150, width: 150 })));
    site.set(shot("fine").url, image(photo));

    const kept = await keepCardPhotos(
      cardId,
      card([
        { alt: "Большое", type: "image", url: shot("huge").url },
        { alt: "Маленькое", type: "image", url: shot("tiny").url },
        { alt: "Обычное", type: "image", url: shot("fine").url },
      ])
    );

    expect(kept).toMatchObject({ droppedBlocks: [0, 1], dropped: 2, kept: 1 });
    expect(kept.card?.blocks).toEqual([
      { alt: "Обычное", type: "image", url: `/api/cards/${cardId}/photos/2` },
    ]);
  });

  it("never follows a redirect to a private host, nor reaches a name that resolves to one", async () => {
    site.set(
      shot("loopback").url,
      () =>
        new Response(null, {
          headers: { location: "https://127.0.0.1/a.jpg" },
          status: 302,
        })
    );
    site.set(
      shot("intranet").url,
      () =>
        new Response(null, {
          headers: { location: "https://photos.internal/a.jpg" },
          status: 301,
        })
    );
    network.fetch.mockImplementationOnce((url) =>
      url.href === shot("resolver").url
        ? Promise.reject(
            Object.assign(new Error("private"), { name: "BlockedHostError" })
          )
        : Promise.resolve(
            site.get(url.href)?.() ?? new Response(null, { status: 404 })
          )
    );

    const kept = await keepCardPhotos(
      cardId,
      card([
        { alt: "А", type: "image", url: shot("resolver").url },
        { alt: "Б", type: "image", url: shot("loopback").url },
        { alt: "В", type: "image", url: shot("intranet").url },
        { text: "Без фото", type: "text" },
      ])
    );

    expect(kept).toMatchObject({ dropped: 3, kept: 0 });
    expect(network.fetch.mock.calls.map(([url]) => url.hostname)).toEqual([
      "photos.example.com",
      "photos.example.com",
      "photos.example.com",
    ]);
    expect(console.warn).toHaveBeenCalledWith("[cards] a photo was not kept", {
      reason: "blocked-host",
    });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "example.com"
    );
  });

  it("gives back no card when it was nothing but photos and they did not keep", async () => {
    expect(
      await keepCardPhotos(cardId, card([gallery("gone", "gone")]))
    ).toMatchObject({
      card: undefined,
      dropped: 2,
    });
  });

  it("numbers an updated card's copies past the ones it shows already", async () => {
    site.set(shot("bedroom").url, image(photo));
    const previous = card([
      {
        photos: [0, 1, 2].map((number) => ({
          alt: "Было",
          url: `/api/cards/${cardId}/photos/${String(number)}`,
        })),
        type: "gallery",
      },
    ]);

    const kept = await keepCardPhotos(
      cardId,
      card([gallery("bedroom", "bedroom")]),
      previous
    );

    expect(urls(kept.card)).toEqual([
      `"/api/cards/${cardId}/photos/3"`,
      `"/api/cards/${cardId}/photos/3"`,
    ]);
  });

  it("downloads no more than six photos at once", async () => {
    let open = 0;
    let most = 0;
    network.fetch.mockImplementation(async () => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open -= 1;
      return image(photo)();
    });

    const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(
      await keepCardPhotos(cardId, card([gallery(...names)]))
    ).toMatchObject({ kept: 8 });
    expect(most).toBe(6);
  });

  it("keeps nothing, and asks no site, without object storage", async () => {
    store.configured = false;

    expect(
      await keepCardPhotos(cardId, card([carousel("roborock", "dreame")]))
    ).toMatchObject({ dropped: 2, kept: 0 });
    expect(network.fetch).not.toHaveBeenCalled();
  });
});

describe("keeping the photos behind «Подробнее»", () => {
  it("preserves each gallery's order when its photos reuse earlier copies", async () => {
    site.set(shot("a").url, image(photo));
    site.set(shot("b").url, image(photo));
    const kept = await keepCardPhotos(
      cardId,
      card([
        gallery("a", "b"),
        {
          type: "list",
          rows: [{ title: "Номер", more: { photos: [shot("b"), shot("a")] } }],
        },
      ])
    );
    expect(urls(kept.card)).toEqual(
      [0, 1, 1, 0].map(
        (number) => `"/api/cards/${cardId}/photos/${String(number)}"`
      )
    );
    expect(store.put).toHaveBeenCalledTimes(2);
  });

  it("keeps one copy of a shared photo even when another set loses it", async () => {
    site.set(shot("shared").url, image(photo));
    const kept = await keepCardPhotos(
      cardId,
      card([
        gallery("shared", "missing"),
        {
          type: "list",
          rows: [{ title: "Номер", more: { photos: [shot("shared")] } }],
        },
      ])
    );
    expect(kept.card?.blocks).toHaveLength(1);
    expect(urls(kept.card)).toEqual([`"/api/cards/${cardId}/photos/0"`]);
    expect(
      network.fetch.mock.calls.filter(
        ([url]) => url.href === shot("shared").url
      )
    ).toHaveLength(1);
    expect(stored()).toEqual([cardPhotoObject(cardId, 0)]);
    expect(store.delete).not.toHaveBeenCalled();
  });

  const options = (...names: string[]) => ({
    id: "hotel",
    label: "Какой отель берём",
    layout: "carousel",
    options: names.map((name) => ({
      more: {
        href: `https://ostrovok.ru/hotel/${name}/`,
        photos: [1, 2, 3].map((n) => shot(`${name}-${String(n)}`)),
      },
      photo: shot(name),
      title: name,
      value: name,
    })),
    type: "choice",
  });

  it("copies the options' own photos first, then those behind «Подробнее», all under the card's link", async () => {
    const names = ["nordkapp", "apelsin", "vosstaniya"];
    for (const name of names) {
      site.set(shot(name).url, image(photo));
      for (const n of [1, 2, 3])
        site.set(shot(`${name}-${String(n)}`).url, image(photo));
    }

    const kept = await keepCardPhotos(
      cardId,
      cardSchema.parse({
        actions: [{ label: "Выбрать и забронировать", submit: "book" }],
        blocks: [options(...names)],
        title: "Отели",
      })
    );

    expect(kept).toMatchObject({ droppedBlocks: [], dropped: 0, kept: 12 });
    const choice = kept.card?.blocks[0];
    if (choice?.type !== "choice") throw new Error("Expected the choice.");
    expect(choice.options.map((option) => option.photo?.url)).toEqual(
      [0, 1, 2].map((number) => `/api/cards/${cardId}/photos/${String(number)}`)
    );
    expect(choice.options[0]?.more?.photos?.map((each) => each.url)).toEqual(
      [3, 4, 5].map((number) => `/api/cards/${cardId}/photos/${String(number)}`)
    );
    expect(choice.options[0]?.more?.href).toBe(
      "https://ostrovok.ru/hotel/nordkapp/"
    );
  });

  it("drops only the photos behind «Подробнее» that failed, and keeps the set's own", async () => {
    for (const name of ["nordkapp", "apelsin"])
      site.set(shot(name).url, image(photo));
    site.set(shot("nordkapp-1").url, image(photo));
    site.set(shot("nordkapp-3").url, image(photo));

    const kept = await keepCardPhotos(
      cardId,
      cardSchema.parse({
        actions: [{ label: "Выбрать", submit: "book" }],
        blocks: [options("nordkapp", "apelsin")],
        title: "Отели",
      })
    );

    const choice = kept.card?.blocks[0];
    if (choice?.type !== "choice") throw new Error("Expected the choice.");
    expect(choice.layout).toBe("carousel");
    expect(choice.options.every((option) => option.photo !== undefined)).toBe(
      true
    );
    expect(choice.options[0]?.more?.photos).toHaveLength(2);
    expect(choice.options[1]?.more?.photos).toBeUndefined();
    expect(choice.options[1]?.more?.href).toBe(
      "https://ostrovok.ru/hotel/apelsin/"
    );
    expect(kept).toMatchObject({ droppedBlocks: [0], dropped: 4, kept: 4 });
  });

  it("leaves no «Подробнее» that had nothing but photos, none of them kept", async () => {
    site.set(shot("room").url, image(photo));

    const kept = await keepCardPhotos(
      cardId,
      card([
        {
          rows: [
            {
              more: { photos: [shot("hall")] },
              title: "Номер",
              photo: shot("room"),
            },
          ],
          type: "list",
        },
      ])
    );

    const list = kept.card?.blocks[0];
    if (list?.type !== "list") throw new Error("Expected the list.");
    expect(list.rows[0]?.photo?.url).toBe(`/api/cards/${cardId}/photos/0`);
    expect(list.rows[0]?.more).toBeUndefined();
  });
});
