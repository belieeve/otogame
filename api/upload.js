// Vercel Edge Function: Upload file to Vercel Blob and return public URL
// Requires project env var: BLOB_READ_WRITE_TOKEN (from Vercel Blob settings)
import { put } from '@vercel/blob';

export const config = { runtime: 'edge' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      },
    });
  }
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file) return json({ error: 'file missing' }, 400);
    const filename = (formData.get('filename') || file.name || 'track.mp3').toString();
    // Upload to Vercel Blob (public)
    const blob = await put(filename, file, { access: 'public' });
    return new Response(JSON.stringify({ url: blob.url, size: blob.size, pathname: blob.pathname }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}

