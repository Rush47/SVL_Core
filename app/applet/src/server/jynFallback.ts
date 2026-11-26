/** A transport error is not a generated AI answer or a verified system status. */
export function generateJynConversationalFallback(_message: string, agentId: string = 'Jyn') {
  return {
    reply: 'Model AI nie zwrócił odpowiedzi. Brak potwierdzonych danych o stanie systemu.',
    modelUsed: 'Serwer SVL (błąd silnika AI)',
    sender: agentId,
    agentId,
    provenance: 'error',
  };
}
