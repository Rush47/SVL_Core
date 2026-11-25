import { isValidAgentAvatar, type AgentAvatar } from './agentAvatars.ts';

// Optional tool contract, not a personality prompt.
export const SELF_AVATAR_CAPABILITY = 'Optional own-avatar tool: emit a separate line <svl_avatar>{"query":"image search terms","index":0}</svl_avatar> (Wikimedia Commons, index 0–4), or {"file":"File:exact filename.jpg"} inside the same tag. No action is required. Server reports success or failure separately.';

export function extractSelfAvatarAction(text: string): { text: string; args?: Record<string, unknown> } {
  let fenced = false;
  let args: Record<string, unknown> | undefined;
  const lines = text.split('\n').filter(line => {
    if (/^\s*\x60\x60\x60/.test(line)) { fenced = !fenced; return true; }
    if (fenced || args) return true;
    const match = /^\s*<svl_avatar>(\{[^\n]{1,800}\})<\/svl_avatar>\s*$/.exec(line);
    if (!match) return true;
    try {
      const value = JSON.parse(match[1]);
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).some(k => !['query','file','index'].includes(k)) ||
          !(typeof value.query === 'string' || typeof value.file === 'string')) return true;
      args = value;
      return false;
    } catch { return true; }
  });
  return { text: lines.join('\n').trim(), args };
}

const strip = (v: unknown, n: number) => String(v || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0,n);

export async function findSelfAvatars(args: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<AgentAvatar[]> {
  const query = String(args.query || args.search_query || '').trim().slice(0,120);
  let file = String(args.file || '').trim().slice(0,240);
  const rawUrl = String(args.image_url || args.imageUrl || '').trim();
  if (rawUrl) {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'commons.wikimedia.org' || !url.pathname.startsWith('/wiki/File:') || url.username || url.password || url.port)
      throw new Error('Wybierz stronę pliku Wikimedia Commons lub wyszukaj obraz przez query.');
    file = decodeURIComponent(url.pathname.slice(6)).replace(/_/g,' ');
  }
  if (file && !/^File:/i.test(file)) throw new Error('Wymagana nazwa File:…');
  if (!file && query.length < 2) throw new Error('Podaj zapytanie lub nazwę pliku.');
  const params = new URLSearchParams({action:'query',format:'json',prop:'imageinfo',iiprop:'url|extmetadata',iiurlwidth:'256'});
  if (file) params.set('titles',file);
  else {
    params.set('generator','search'); params.set('gsrsearch',query+' filetype:bitmap'); params.set('gsrnamespace','6'); params.set('gsrlimit','12');
  }
  const response = await fetcher('https://commons.wikimedia.org/w/api.php?'+params, {headers:{Accept:'application/json','User-Agent':'SVL_Core/2.0 agent avatar'},signal:AbortSignal.timeout(10000),redirect:'error'});
  if (!response.ok) throw new Error('Wikimedia HTTP '+response.status);
  const json = await response.json() as any;
  if (json.error) throw new Error('Wikimedia: '+String(json.error.info || json.error.code));
  const pages = (Object.values(json.query?.pages || {}) as any[]).sort((a,b)=>(a.index??0)-(b.index??0));
  return pages.flatMap(page=>{
    const info=page.imageinfo?.[0]; if(!info || !page.title) return [];
    const avatar={title:strip(page.title,160),image_url:String(info.thumburl || ''),source_url:'https://commons.wikimedia.org/wiki/'+encodeURIComponent(page.title.replace(/ /g,'_')).replace(/%3A/i,':'),license:strip(info.extmetadata?.LicenseShortName?.value,80),author:strip(info.extmetadata?.Artist?.value,200)};
    return isValidAgentAvatar(avatar) ? [avatar] : [];
  }).slice(0,5);
}

export async function downloadSelfAvatar(avatar: AgentAvatar, fetcher: typeof fetch = fetch): Promise<string> {
  if (!isValidAgentAvatar(avatar)) throw new Error('Niezweryfikowane źródło obrazu.');
  const res = await fetcher(avatar.image_url,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{'User-Agent':'SVL_Core/2.0 agent avatar'}});
  if(!res.ok || !res.body) throw new Error('Nie udało się pobrać obrazu: HTTP '+res.status);
  const reader=res.body.getReader(); const chunks: Uint8Array[]=[]; let size=0;
  try { for (;;) { const next=await reader.read(); if(next.done)break; size+=next.value.length; if(size>750000)throw new Error('Obraz przekracza 750 KB.'); chunks.push(next.value); } }
  finally { await reader.cancel().catch(()=>{}); }
  const bytes=Buffer.concat(chunks);
  const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'jpeg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'webp':'';
  if(!mime) throw new Error('Nieobsługiwany format obrazu: wymagany PNG, JPEG lub WebP.');
  return 'data:image/'+mime+';base64,'+bytes.toString('base64');
}
