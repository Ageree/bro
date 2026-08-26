import { defineComposioTools } from "@composio/experimental/eve";
import { sessionFor } from "../lib/composio";
import { tenantId } from "../lib/tenant";

export default defineComposioTools((ctx) => sessionFor(tenantId(ctx)));
