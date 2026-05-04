import { createClient } from '@supabase/supabase-js';

// Supabase client singleton — used for blob (image) storage. Keys come from .env.local; the
// publishable anon key is intentionally client-side. Bucket name is also env-driven so we can
// point at a different bucket per environment without code changes.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const SUPABASE_BUCKET = (import.meta.env.VITE_SUPABASE_BUCKET as string | undefined) || 'focus-images';

export const supabase = (url && anonKey) ? createClient(url, anonKey) : null;

// Upload a Blob to the focus-images bucket. Returns the public URL on success. Throws on
// failure so the caller can surface the error to the user.
export async function uploadFocusImage(id: string, blob: Blob, contentType = 'image/webp'): Promise<string> {
  if (!supabase) throw new Error('Supabase not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
  // Path: <id>.webp under the bucket root. Cache-control 1 year — these are immutable
  // (the id is unique per upload, never reused) so the browser can fully cache them.
  const path = `${id}.webp`;
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(path, blob, {
    contentType,
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

export async function deleteFocusImageBlob(id: string): Promise<void> {
  if (!supabase) return;
  const path = `${id}.webp`;
  // Don't throw on delete failure — Liveblocks metadata is the source of truth; an orphaned
  // blob is harmless and can be GC'd separately if it ever becomes a real cost issue.
  await supabase.storage.from(SUPABASE_BUCKET).remove([path]);
}
