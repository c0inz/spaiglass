/**
 * Timestamp restoration utilities
 * Handles restoring accurate timestamps for continued conversations
 */

import type { RawHistoryLine } from "./parser.ts";

/**
 * Restore accurate timestamps for messages in a conversation
 * When conversations are continued, timestamps get overwritten
 * This function restores original timestamps from first occurrence of each message.id
 */
export function restoreTimestamps(
  messages: RawHistoryLine[],
): RawHistoryLine[] {
  // Create a map to track the earliest timestamp for each message ID
  const timestampMap = new Map<string, string>();

  // First pass: collect earliest timestamps for each message.id
  for (const msg of messages) {
    const m = msg.message as unknown as Record<string, unknown>;
    if (msg.type === "assistant" && m?.id) {
      const messageId = m.id as string;
      if (!timestampMap.has(messageId)) {
        timestampMap.set(messageId, msg.timestamp);
      } else {
        // Keep the earliest timestamp
        const existingTimestamp = timestampMap.get(messageId)!;
        if (msg.timestamp < existingTimestamp) {
          timestampMap.set(messageId, msg.timestamp);
        }
      }
    }
  }

  // Second pass: restore timestamps and return updated messages
  return messages.map((msg) => {
    const m2 = msg.message as unknown as Record<string, unknown>;
    if (msg.type === "assistant" && m2?.id) {
      const restoredTimestamp = timestampMap.get(m2.id as string);
      if (restoredTimestamp) {
        return {
          ...msg,
          timestamp: restoredTimestamp,
        };
      }
    }
    // For user messages and messages without IDs, keep original timestamp
    return msg;
  });
}

/**
 * Sort messages by timestamp (chronological order)
 */
export function sortMessagesByTimestamp(
  messages: RawHistoryLine[],
): RawHistoryLine[] {
  return [...messages].sort((a, b) => {
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });
}

/**
 * Calculate conversation metadata from messages
 */
export function calculateConversationMetadata(messages: RawHistoryLine[]): {
  startTime: string;
  endTime: string;
  messageCount: number;
} {
  if (messages.length === 0) {
    const now = new Date().toISOString();
    return {
      startTime: now,
      endTime: now,
      messageCount: 0,
    };
  }

  // Sort messages by timestamp to get accurate start/end times
  const sortedMessages = sortMessagesByTimestamp(messages);
  const startTime = sortedMessages[0].timestamp;
  const endTime = sortedMessages[sortedMessages.length - 1].timestamp;

  return {
    startTime,
    endTime,
    messageCount: messages.length,
  };
}

/**
 * Process messages with timestamp restoration and sorting
 * This is the main function to call for preparing messages for API response
 */
export function processConversationMessages(
  messages: RawHistoryLine[],
  _sessionId: string,
): {
  messages: unknown[];
  metadata: {
    startTime: string;
    endTime: string;
    messageCount: number;
  };
} {
  // Restore timestamps
  const restoredMessages = restoreTimestamps(messages);

  // Sort by timestamp
  const sortedMessages = sortMessagesByTimestamp(restoredMessages);

  // Calculate metadata
  const metadata = calculateConversationMetadata(sortedMessages);

  // Return as unknown[] for frontend compatibility
  return {
    messages: sortedMessages as unknown[],
    metadata,
  };
}
