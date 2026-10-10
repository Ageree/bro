import { z } from "zod";
import { defineYandexOperation } from "../operations";
import { mapsPage } from "./page";

const review = z.object({
  date: z.string(),
  rating: z.number().nullable(),
  text: z.string(),
});

const card = z.object({
  address: z.string().nullable(),
  booking: z
    .object({
      date: z.string(),
      guests: z.number().int(),
      partner: z.string().nullable(),
      slots: z.array(z.string()).nullable(),
      type: z.string().nullable(),
    })
    .nullable(),
  category: z.string().nullable(),
  hours: z.string().nullable(),
  id: z.string(),
  name: z.string(),
  openNow: z.boolean().nullable(),
  phone: z.string().nullable(),
  rating: z.number().nullable(),
  ratingCount: z.number().nullable(),
  reviews: z.array(review).max(3),
  site: z.string().nullable(),
  week: z.array(z.string()).max(7),
});

/**
 * One place's card on Yandex Maps: hours by day, rating, contacts, up to
 * three recent reviews, and the free times of its online booking on a date
 * when it takes bookings. It reads only: the booking itself is made by
 * browser_task, with the person's yes.
 */
export const mapsOrgOperation = defineYandexOperation({
  about:
    "A Yandex Maps place's card by its id (the number in the place's maps link, from maps.search): name, address, hours by day, rating, phone, site, up to three short reviews, and, with a date (YYYY-MM-DD), the free times of its online booking for that date and guests (default 2). It only reads: it does not book; a booking is made by browser_task, with the person's yes.",
  access: "read",
  args: z.object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .optional(),
    guests: z.number().int().min(1).max(20).default(2),
    id: z.string().regex(/^\d{1,20}$/u),
  }),
  id: "maps.org",
  origin: "https://yandex.ru/maps/",
  result: z.union([card, z.object({ error: z.string() })]),
  run: `async function (args) {
  ${mapsPage}
  const session = await mapsContext();
  if (session === null) return { status: "ok", data: { error: "no_session" } };
  const found = await mapsCall(session, "/maps/api/search", [
    ["lang", "ru_RU"],
    ["mode", "uri"],
    ["origin", "maps-bookmark"],
    ["snippets", "businessrating/1.x,bookings/1.x"],
    ["uri", "ymapsbm1://org?oid=" + args.id],
  ]);
  const bad = mapsAnswer(found);
  if (bad) return bad;
  const i = (found.items || [])[0];
  if (!i) return { status: "ok", data: { error: "not_found" } };
  await new Promise((r) => setTimeout(r, 1000));
  const rv = await mapsCall(session, "/maps/api/business/fetchReviews", [
    ["businessId", args.id],
    ["locale", "ru_RU"],
    ["page", "1"],
    ["pageSize", "3"],
    ["ranking", "by_relevance_org"],
  ]);
  if (rv.wall) return mapsAnswer(rv);
  const reviews = rv.error
    ? []
    : (rv.reviews || []).slice(0, 3).map((r) => ({
        date: (r.updatedTime || "").slice(0, 10),
        rating: r.rating ?? null,
        text: (r.text || "").split(/(?<=[.!?])\\s/)[0].slice(0, 160),
      }));
  let booking = null;
  if (args.date && i.booking && i.booking.slotsWidgetAvailable) {
    await new Promise((r) => setTimeout(r, 1000));
    const slots = await mapsCall(session, "/web-maps/api/slow/booking/getTimeslots", [
      ["date", args.date],
      ["permalink", args.id],
      ["serviceIds[0]", "guests:" + args.guests],
    ]);
    if (slots.wall) return mapsAnswer(slots);
    booking = {
      date: args.date,
      guests: args.guests,
      partner: i.booking.partner ? i.booking.partner.name : null,
      slots: slots.error ? null : slots.map((s) => s.datetime.slice(11, 16)),
      type: i.booking.bookingType || null,
    };
  }
  return {
    status: "ok",
    data: {
      address: i.fullAddress || i.address || null,
      booking,
      category: (i.categories || [])[0] ? i.categories[0].name : null,
      hours: i.workingTimeText || null,
      id: i.id,
      name: i.title,
      openNow: i.currentWorkingStatus ? i.currentWorkingStatus.isOpenNow : null,
      phone: (i.phones || [])[0] ? i.phones[0].number : null,
      rating: i.ratingData ? Math.round(i.ratingData.ratingValue * 10) / 10 : null,
      ratingCount: i.ratingData ? i.ratingData.ratingCount : null,
      reviews,
      site: (i.urls || [])[0] ? i.urls[0].split("?")[0] : null,
      week: (i.workingTime || []).slice(0, 7).map((d) =>
        d
          .map(
            (x) =>
              x.from.hours + ":" + String(x.from.minutes).padStart(2, "0") + "-" + x.to.hours + ":" + String(x.to.minutes).padStart(2, "0")
          )
          .join(",")
      ),
    },
  };
}`,
  service: "maps",
});
