import { disableRoute } from "eve/channels";

// Telegram HTTP lives on the iMessage channel so from(conversationId)
// hits the same eve session. This file only reserved the slug.
export default disableRoute();
