/** What a chat is called until its first message names it. */
export const defaultChatTitle = "Новый чат";

// Chats written before the default was Russian hold this one: shown as the
// Russian default, left as they are in the database.
const legacyDefaultChatTitle = "New chat";

/** The title «Все чаты» shows for a stored one. */
export function shownChatTitle(title: string) {
  return title === legacyDefaultChatTitle ? defaultChatTitle : title;
}
