import { disableTool } from "eve/tools";

/** iMessage/Telegram have no HITL pause — ask_question would hang the human. */
export default disableTool();
