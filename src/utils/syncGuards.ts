export interface ChatSnapshotAcceptanceInput {
  responseServerRevision: number;
  appliedChatServerRevision: number;
  requestEpoch: number;
  currentEpoch: number;
  forceApply: boolean;
}

export interface ChatSnapshotAcceptanceResult {
  accept: boolean;
  resetAppliedRevision: boolean;
}

/**
 * Decides whether a fetched /api/py/chat/conversations snapshot should be applied.
 * Prevents the client from getting stuck dropping snapshots forever when the backend
 * restarts with a lower serverRevision or during an explicit global sync.
 */
export function evaluateChatSnapshotAcceptance(
  input: ChatSnapshotAcceptanceInput,
): ChatSnapshotAcceptanceResult {
  const {
    responseServerRevision,
    appliedChatServerRevision,
    requestEpoch,
    currentEpoch,
    forceApply,
  } = input;

  // An in-flight local mutation happened while this non-forced fetch was in flight.
  if (!forceApply && currentEpoch !== requestEpoch) {
    return { accept: false, resetAppliedRevision: false };
  }

  if (forceApply) {
    return {
      accept: true,
      resetAppliedRevision:
        responseServerRevision > 0 && responseServerRevision < appliedChatServerRevision,
    };
  }

  // If the server revision dropped significantly (e.g., backend restarted / DB recreated),
  // accept and realign instead of dropping every subsequent chat snapshot forever.
  if (responseServerRevision > 0 && responseServerRevision < appliedChatServerRevision) {
    const dropDelta = appliedChatServerRevision - responseServerRevision;
    if (dropDelta >= 2) {
      return { accept: true, resetAppliedRevision: true };
    }
    return { accept: false, resetAppliedRevision: false };
  }

  return { accept: true, resetAppliedRevision: false };
}

/**
 * Returns true if a WebSocket svl.resync_required frame originated from this very tab
 * so we do not execute a redundant second full global-sync immediately after finishing one.
 */
export function shouldSkipResyncEcho(
  frameOrigin: unknown,
  currentTabOrigin: string,
): boolean {
  if (!currentTabOrigin) return false;
  const incoming = typeof frameOrigin === 'string' ? frameOrigin.trim() : '';
  return Boolean(incoming && incoming === currentTabOrigin.trim());
}

export interface DurableChatBackupPayload {
  version: 2;
  savedAt: string;
  clearedAt: string | null;
  conversations: Array<{
    id: string;
    title: string;
    updatedAt: string;
    revision?: number;
    messages: any[];
  }>;
}

export function countTotalConversationMessages(
  conversations: Array<{ messages?: unknown[] }> | null | undefined,
): number {
  if (!Array.isArray(conversations)) return 0;
  return conversations.reduce(
    (sum, conv) => sum + (Array.isArray(conv?.messages) ? conv.messages.length : 0),
    0,
  );
}

/**
 * Determines whether a client-side recovery backup should be offered/kept when
 * the server unexpectedly returns 0 messages (e.g., transient empty boot) without
 * an explicit operator clear-all action.
 */
export function shouldPreserveLocalConversationsOnEmptyServer(
  serverConversations: Array<{ messages?: unknown[] }>,
  currentConversations: Array<{ messages?: unknown[] }>,
  explicitlyCleared: boolean,
): boolean {
  if (explicitlyCleared) return false;
  const serverCount = countTotalConversationMessages(serverConversations);
  const localCount = countTotalConversationMessages(currentConversations);
  return serverCount === 0 && localCount > 0;
}
