import { defineTool } from "eve/tools";
import { z } from "zod";
import { describeWatcher, triggerSpec } from "../../convex/lib/watcherPolicy.ts";
import { composio } from "../lib/composio";
import { createWatcher, listWatchers, stopWatchers } from "../lib/convex";
import { composioUserId, tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Push watcher on a connected app (Gmail, Google Calendar): events arrive by webhook, instantly, no polling. start needs source + about (what matters, in the person's words), optional gmailQuery (Gmail search syntax, e.g. from:bank.ru). stop by id or all. list shows active ones. For prices or websites use schedule_wakeup kind=watcher instead.",
  inputSchema: z.object({
    action: z.enum(["start", "stop", "list"]).default("start"),
    source: z.enum(["gmail", "calendar"]).optional(),
    about: z.string().min(1).optional(),
    gmailQuery: z.string().optional(),
    id: z.string().optional(),
  }),
  async execute({ action, source, about, gmailQuery, id }, ctx) {
    const phone = composioUserId(tenantId(ctx));
    if (action === "stop") {
      const rows = await stopWatchers(phone, id);
      for (const row of rows) {
        await composio()
          .triggers.delete(row.triggerId)
          .catch((err: unknown) => {
            console.error("composio trigger delete failed", row.triggerId, err);
          });
      }
      return `stopped ${rows.length}`;
    }
    if (action === "list") {
      const rows = await listWatchers(phone);
      if (rows.length === 0) return "no push watchers";
      return rows.map(describeWatcher).join("\n");
    }
    if (!source || !about) {
      return "start needs source (gmail|calendar) and about";
    }
    const spec = triggerSpec(source, gmailQuery);
    const accounts = await composio().connectedAccounts.list({
      userIds: [phone],
      toolkitSlugs: [spec.toolkit],
      statuses: ["ACTIVE"],
    });
    if (accounts.items.length === 0) {
      return `${source} не подключён: вызови COMPOSIO_MANAGE_CONNECTIONS toolkits=["${spec.toolkit}"], дождись подключения и повтори watch_app`;
    }
    const { triggerId } = await composio().triggers.create(phone, spec.slug, {
      triggerConfig: spec.config,
    });
    const watcherId = await createWatcher({
      tenantPhone: phone,
      source,
      triggerId,
      triggerSlug: spec.slug,
      about,
      filter: gmailQuery?.trim() || undefined,
    });
    return `watching ${source}: ${about} (${watcherId}). События придут сами — поллинг не нужен.`;
  },
});
