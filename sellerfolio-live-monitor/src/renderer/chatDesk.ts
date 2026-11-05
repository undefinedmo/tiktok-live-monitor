// LANE C — chat: question / wish detection (core/chatIntent), the chat column tools (search, All /
// Questions), question cards with a local-rule suggested reply + Approve (posts as Host through
// window.chatAPI.send, max 100 chars) / Skip, the "Buyers are asking for" panel, and the Chat
// screen (Questions list + Wishlist with Mark fulfilled). Updates the nav badge through
// ./shell setChatBadge(open questions).
//
// Lane C MOVES appendChat / appendOwnChat / setupChatInput (renderer.ts, inside the "lane C"
// fences) into this file.
// Fills: index.html #chatTools, #askingPanel, #chatScreen, .chat-note text; CSS block "lane C".
// SCAFFOLD STUB: no-ops. renderer.ts calls initChatDesk() once, onChat() after every 'chat'
// event is appended, and onChatScreenShown() when the Chat screen opens.

import type { ChatMessage } from '../core/types'

/** Called once by renderer.ts at startup. */
export function initChatDesk(): void {}

/** Called for every 'chat' event, after renderer.ts has appended the lines to #chatList. */
export function onChat(items: ChatMessage[]): void {
  void items
}

/** Called by renderer.ts showScreen() when the Chat screen becomes visible (repaint it). */
export function onChatScreenShown(): void {}
