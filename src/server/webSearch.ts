export type WebSource = {
  title: string;
  uri: string;
};

type GroundingResponse = {
  candidates?: Array<{
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: {
          title?: string;
          uri?: string;
        };
      }>;
    };
  }>;
};

export function isWebSearchRequest(message: string): boolean {
  const normalizedMessage = message
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  const asksForSources =
    /\b(?:podaj|wyslij|daj|wstaw|dolacz|udostepnij|chce|potrzebuj\w*|poprosz\w*|give|send|provide|find|search|include|cite|need)\b.{0,60}(?:internet|sieci|online|web|link|url|zrod|source|citation)/i.test(normalizedMessage);
  const explicitlySearchesWeb =
    /(?:wyszuk\w*|poszuk\w*|znajdz|przeszuk\w*|sprawdz|search|look up)\b.{0,60}(?:internet|sieci|online|web|google)/i.test(
      normalizedMessage,
    ) ||
    /(?:internet|sieci|online|web|google).{0,60}(?:wyszuk\w*|poszuk\w*|znajdz|przeszuk\w*|sprawdz|search|look up)/i.test(
      normalizedMessage,
    );
  const asksForCurrentInformation =
    /\b(?:najnowsz\w*\s+(?:informacj|wiadomos|dane|wersj|wydan)|wiadomosci\s+(?:ze\s+swiata|z\s+kraju|sportow|gospodarcz|dnia)|aktualn\w*\s+(?:kurs|cen|pogod|informacj|dane|statystyk|wynik)|pogoda\s+(?:w|we|na|na\s+dzis)|kurs\s+(?:walut|dolara|euro|btc|bitcoin)|kto\s+(?:jest|wygral)\s+(?:obecnie|teraz|dzisiaj)|breaking\s+news|latest\s+(?:news|version|release|updates))\b/i.test(
      normalizedMessage,
    );

  return asksForSources || explicitlySearchesWeb || asksForCurrentInformation;
}

export function collectWebSources(response: GroundingResponse): WebSource[] {
  const sources: WebSource[] = [];
  const seen = new Set<string>();

  for (const candidate of response.candidates || []) {
    for (const chunk of candidate.groundingMetadata?.groundingChunks || []) {
      const web = chunk.web;
      if (!web?.uri) continue;

      let parsed: URL;
      try {
        parsed = new URL(web.uri);
      } catch {
        continue;
      }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || seen.has(parsed.href)) {
        continue;
      }
      seen.add(parsed.href);

      const title = (web.title || parsed.hostname)
        .replace(/[\[\]()\\\r\n]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      const uri = parsed.href.replace(/[()]/g, (character) => (character === '(' ? '%28' : '%29'));
      sources.push({ title: title || parsed.hostname, uri });
      if (sources.length === 8) return sources;
    }
  }

  return sources;
}

export function appendWebSources(reply: string, sources: WebSource[]): string {
  if (!sources.length) return reply;
  const sourceList = sources.map(({ title, uri }) => `- [${title}](${uri})`).join('\n');
  return `${reply.trim()}\n\n### Źródła z internetu\n${sourceList}`;
}
