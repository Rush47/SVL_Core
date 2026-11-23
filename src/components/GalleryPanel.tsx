import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Images, Upload, ThumbsUp, ThumbsDown, Trash2, Loader2 } from 'lucide-react';
import { safeFetchJson, getSvlOperatorAccessToken, hasSvlOperatorAccessToken } from '../utils/svlLogic';

interface Opinion { agent: string; verdict: 'like' | 'dislike'; comment: string; model: string }
interface GalleryItem { id: string; imageDataUrl: string; uploadedAt: string; opinions: Opinion[] }

const AGENT_AVATAR: Record<string, string> = { Jyn: 'SI' };
const timeOf = (iso: string) => (/^\d{4}-\d{2}-\d{2}T/.test(iso) ? new Date(iso).toLocaleString('pl-PL') : iso);

export const GalleryPanel: React.FC = () => {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    if (!hasSvlOperatorAccessToken()) {
      setError('Odblokuj dostęp przyciskiem 🔒 SVL w górnym pasku, aby korzystać z galerii.');
      return;
    }
    const res = await safeFetchJson<{ ok: boolean; items: GalleryItem[]; error?: string }>('/api/gallery', { timeoutMs: 8000 });
    if (res.ok && res.data?.ok) {
      setItems(res.data.items || []);
      setError(null);
    } else {
      setError(res.data?.error || res.error || `HTTP ${res.status}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) {
      setError('Zdjęcie za duże (limit 6 MB).');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('Nie udało się wczytać pliku.'));
        r.readAsDataURL(file);
      });
      const res = await safeFetchJson<{ ok: boolean; item?: GalleryItem; error?: string }>('/api/gallery/upload', {
        method: 'POST',
        timeoutMs: 180000,
        body: JSON.stringify({ imageBase64: dataUrl, mimeType: file.type || 'image/jpeg' }),
      });
      if (res.data?.ok && res.data.item) {
        setItems((prev) => [res.data!.item!, ...prev]);
      } else {
        setError(res.data?.error || res.error || 'Nie udało się dodać zdjęcia.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id: string) => {
    await safeFetchJson(`/api/gallery/${id}`, { method: 'DELETE', timeoutMs: 8000 });
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  return (
    <div className="flex-1 min-h-0 h-full overflow-y-auto svl-scroll-smooth p-3 sm:p-4 md:p-6 space-y-4 bg-[#0B0D13] text-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Images className="w-5 h-5 text-violet-400" />
          <h1 className="text-lg font-semibold text-slate-100">Galeria — ocena zdjęć przez AI</h1>
        </div>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="inline-flex items-center gap-1.5 rounded-md border border-violet-600 bg-violet-600/20 px-3 py-1.5 text-xs font-semibold text-violet-200 hover:bg-violet-600/35 disabled:opacity-50"
        >
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {uploading ? 'AI ogląda zdjęcie...' : 'Wrzuć zdjęcie'}
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPick} />
      </div>

      <p className="text-[11px] text-slate-500">
        Po wrzuceniu agent AI (Jyn) ogląda zdjęcie modelem wizyjnym, daje 👍/👎 i komentuje.
      </p>
      {error && <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">{error}</div>}

      {items.length === 0 && !error && (
        <div className="text-sm text-slate-500 py-10 text-center">Brak zdjęć. Wrzuć pierwsze, a AI je oceni.</div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <div key={item.id} className="rounded-xl border border-slate-800 bg-[#111520] overflow-hidden">
            <div className="relative">
              <img src={item.imageDataUrl} alt="Zdjęcie Operatora" loading="lazy" className="w-full h-56 object-cover bg-[#0B0D13]" />
              <button
                type="button"
                onClick={() => void remove(item.id)}
                aria-label="Usuń zdjęcie"
                className="absolute top-2 right-2 rounded-md bg-black/50 hover:bg-rose-600/70 p-1.5 text-slate-200"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="p-3 space-y-2">
              <div className="text-[10px] text-slate-500">{timeOf(item.uploadedAt)}</div>
              {item.opinions.map((o) => (
                <div key={o.agent} className="rounded-lg border border-slate-800/80 bg-[#0d1017] p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-violet-600/30 text-[10px] font-bold text-violet-200">
                      {AGENT_AVATAR[o.agent] || o.agent.slice(0, 2)}
                    </span>
                    <span className="text-xs font-semibold text-slate-100">{o.agent}</span>
                    <span
                      className={`ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        o.verdict === 'like'
                          ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40'
                          : 'bg-rose-500/15 text-rose-300 border border-rose-500/40'
                      }`}
                    >
                      {o.verdict === 'like' ? <ThumbsUp className="w-3 h-3" /> : <ThumbsDown className="w-3 h-3" />}
                      {o.verdict === 'like' ? 'Like' : 'Dislike'}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[12px] leading-snug text-slate-300">{o.comment}</p>
                  <div className="mt-1 text-[9px] text-slate-600 font-mono">{o.model}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
