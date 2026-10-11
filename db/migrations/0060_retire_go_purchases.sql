-- Yandex Go rides are no longer tracked here: Yandex's own active order is
-- the guard (agent/lib/yandex/go/booking.ts). An open Go attempt would block
-- every purchase of the workspace for good; none of them became a ride
-- (checked against the order history on 11.10).
UPDATE "yandex_purchases"
SET "state" = 'rejected', "settled_at" = now(), "updated_at" = now()
WHERE "service" = 'go' AND "state" IN ('quoted', 'submitting', 'unknown', 'active');
