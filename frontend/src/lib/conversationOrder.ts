import type { Conversation } from './types'

export function sortConversations(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((a, b) => (
    Number(b.is_pinned) - Number(a.is_pinned)
    || a.sort_order - b.sort_order
    || b.id - a.id
  ))
}

/** Replace only the requested rows' slots; hidden rows keep their positions. */
export function reorderConversationSubset(conversations: Conversation[], ids: number[]): Conversation[] {
  const selected = new Set(ids)
  let index = 0
  const orderedIds = sortConversations(conversations).map(conversation => (
    selected.has(conversation.id) ? ids[index++] : conversation.id
  ))
  const ranks = new Map(orderedIds.map((id, rank) => [id, rank]))
  return sortConversations(conversations.map(conversation => ({
    ...conversation, sort_order: ranks.get(conversation.id) ?? conversation.sort_order,
  })))
}
