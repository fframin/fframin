// バズレシピ帳「SNS取り込みサーバー」（Cloudflare Workers 用）
// 投稿のURLを受け取り、写真のURLと投稿文を返す。写真の中継（CORS対応）も行う。
//
//   GET /?url=<投稿URL>        → { source, title, text, author, images: [画像URL...] }
//   GET /image?url=<画像URL>   → 画像そのもの
//
// 環境変数 TOKEN を設定すると、ヘッダー X-Import-Token が一致するリクエストだけを受け付ける（他人に使われないように推奨）。
// ※ 各SNSの仕様変更で取れなくなることがあります。取り込んだ内容は個人で見返す範囲で使ってください。

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'X-Import-Token',
  'Access-Control-Max-Age': '86400',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

function httpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML の <meta property/name="..." content="..."> を集める */
export function readMeta(html) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const val = (tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1];
    if (!key || val == null) continue;
    const k = key.toLowerCase();
    (meta[k] ||= []).push(decodeEntities(val));
  }
  return meta;
}

/** Instagram の og:description（「いいね！12件、コメント3件 - user、日付: "本文"」）から本文と投稿者を取り出す */
export function parseInstagramDescription(desc, title = '') {
  const caption = (desc.match(/:\s*["「“]([\s\S]*)["」”]\s*\.?\s*$/) || [])[1];
  const author =
    (desc.match(/-\s*([A-Za-z0-9._]+)\s/) || [])[1] || (title.match(/\(@([A-Za-z0-9._]+)\)/) || [])[1] || '';
  return { text: caption || desc, author: author ? `@${author}` : '' };
}

async function fromX(url) {
  const m = url.pathname.match(/^\/([^/]+)\/status(?:es)?\/(\d+)/);
  if (!m) return null;
  // 公開投稿の内容を JSON で返してくれる FxTwitter の API を使う
  const r = await fetch(`https://api.fxtwitter.com/${m[1]}/status/${m[2]}`, { headers: { 'User-Agent': 'buzz-recipe-import' } });
  if (!r.ok) return null;
  const { tweet } = await r.json();
  if (!tweet) return null;
  const photos = (tweet.media?.photos || []).map((p) => p.url);
  const thumbs = (tweet.media?.videos || []).map((v) => v.thumbnail_url).filter(Boolean);
  return {
    source: 'x',
    title: '',
    text: tweet.text || '',
    author: tweet.author?.screen_name ? `@${tweet.author.screen_name}` : '',
    images: [...photos, ...thumbs],
  };
}

async function fromOembed(endpoint, source) {
  const r = await fetch(endpoint);
  if (!r.ok) return null;
  const d = await r.json();
  return {
    source,
    title: source === 'youtube' ? d.title || '' : '',
    text: source === 'tiktok' ? d.title || '' : '',
    author: d.author_unique_id ? `@${d.author_unique_id}` : d.author_name || '',
    images: d.thumbnail_url ? [d.thumbnail_url] : [],
  };
}

async function fromOgp(url) {
  const r = await fetch(url.href, {
    headers: { 'User-Agent': CRAWLER_UA, 'Accept-Language': 'ja,en;q=0.8' },
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`投稿を読み込めませんでした（${r.status}）`);
  const html = (await r.text()).slice(0, 1_500_000);
  const meta = readMeta(html);
  const first = (k) => (meta[k] || [])[0] || '';
  const ogTitle = first('og:title') || decodeEntities((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '');
  const desc = first('og:description') || first('description') || first('twitter:description');
  const images = [...new Set([...(meta['og:image'] || []), ...(meta['twitter:image'] || [])])];
  const host = url.hostname.replace(/^www\./, '');

  if (/(^|\.)instagram\.com$/.test(host)) {
    const { text, author } = parseInstagramDescription(desc, ogTitle);
    if (!text && !images.length) throw new Error('Instagramの投稿を読み込めませんでした（非公開またはログインが必要な投稿の可能性があります）');
    return { source: 'instagram', title: '', text, author, images };
  }
  return { source: 'web', title: ogTitle, text: desc, author: first('author') || '', images };
}

export async function extract(url) {
  const host = url.hostname.replace(/^(www|m|mobile|vt|vm)\./, '');
  if (/(^|\.)(x|twitter)\.com$/.test(host)) {
    const r = await fromX(url).catch(() => null);
    if (r) return r;
  }
  if (/(^|\.)tiktok\.com$/.test(host)) {
    const r = await fromOembed(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url.href)}`, 'tiktok').catch(() => null);
    if (r) return r;
  }
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) {
    const r = await fromOembed(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url.href)}`, 'youtube').catch(() => null);
    if (r) {
      const og = await fromOgp(url).catch(() => null);
      return { ...r, text: og?.text || r.text };
    }
  }
  return fromOgp(url);
}

async function proxyImage(url) {
  const r = await fetch(url.href, { headers: { 'User-Agent': CRAWLER_UA } });
  const type = r.headers.get('Content-Type') || '';
  if (!r.ok || !type.startsWith('image/')) return json({ error: '画像を取得できませんでした' }, 502);
  const len = Number(r.headers.get('Content-Length') || 0);
  if (len > MAX_IMAGE_BYTES) return json({ error: '画像が大きすぎます' }, 413);
  const body = await r.arrayBuffer();
  if (body.byteLength > MAX_IMAGE_BYTES) return json({ error: '画像が大きすぎます' }, 413);
  return new Response(body, { headers: { ...CORS, 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' } });
}

export default {
  async fetch(request, env = {}) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET') return json({ error: 'GET のみ対応しています' }, 405);
    if (env.TOKEN && request.headers.get('X-Import-Token') !== env.TOKEN) return json({ error: 'unauthorized' }, 401);

    const reqUrl = new URL(request.url);
    const target = httpUrl(reqUrl.searchParams.get('url'));
    if (!target) return json({ error: 'url を指定してください' }, 400);

    try {
      if (reqUrl.pathname.replace(/\/+$/, '').endsWith('/image')) return await proxyImage(target);
      const data = await extract(target);
      data.images = (data.images || []).filter((s) => httpUrl(s)).slice(0, 6);
      return json(data);
    } catch (err) {
      return json({ error: err.message || '取り込みに失敗しました' }, 502);
    }
  },
};
