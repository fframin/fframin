import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { readMeta, parseInstagramDescription, decodeEntities } from '../server/import-worker.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// 外部サイトへの通信を差し替える
function mockFetch(routes) {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    for (const [prefix, handler] of routes) if (url.startsWith(prefix)) return handler(url, init);
    throw new Error(`unexpected fetch: ${url}`);
  };
}

const call = (path, headers = {}, env = {}) =>
  worker.fetch(new Request(`https://importer.example.workers.dev${path}`, { headers }), env);

test('meta タグと HTML エンティティを読む', () => {
  const meta = readMeta(`<meta property="og:title" content="A &amp; B"><meta content='x.jpg' property='og:image'>`);
  assert.equal(meta['og:title'][0], 'A & B');
  assert.equal(meta['og:image'][0], 'x.jpg');
  assert.equal(decodeEntities('&#x1F373;&#12354;'), '🍳あ');
});

test('Instagram の説明文から本文と投稿者を取り出す', () => {
  const en = parseInstagramDescription('1,234 likes, 56 comments - cook_lab on November 1, 2026: "無限キャベツ\n材料…".');
  assert.equal(en.text, '無限キャベツ\n材料…');
  assert.equal(en.author, '@cook_lab');
  const ja = parseInstagramDescription('いいね！12件、コメント3件 - cook_lab、2026年11月1日: 「レンジで5分」');
  assert.equal(ja.text, 'レンジで5分');
});

test('Instagram の投稿（OGP）を取り込む', async () => {
  mockFetch([
    [
      'https://www.instagram.com/p/abc/',
      (url, init) => {
        assert.match(init.headers['User-Agent'], /facebookexternalhit/);
        return new Response(
          `<html><head>
            <meta property="og:title" content="Cook Lab (@cook_lab) on Instagram">
            <meta property="og:description" content="10 likes, 2 comments - cook_lab on November 1, 2026: &quot;無限キャベツ&#10;＜材料＞&#10;キャベツ 1/4玉&quot;">
            <meta property="og:image" content="https://scontent.cdninstagram.com/v/a.jpg">
          </head></html>`,
          { headers: { 'Content-Type': 'text/html' } }
        );
      },
    ],
  ]);
  const res = await call('/?url=' + encodeURIComponent('https://www.instagram.com/p/abc/'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const data = await res.json();
  assert.equal(data.source, 'instagram');
  assert.equal(data.text, '無限キャベツ\n＜材料＞\nキャベツ 1/4玉');
  assert.equal(data.author, '@cook_lab');
  assert.deepEqual(data.images, ['https://scontent.cdninstagram.com/v/a.jpg']);
});

test('X の投稿を取り込む', async () => {
  mockFetch([
    [
      'https://api.fxtwitter.com/someone/status/123',
      () =>
        Response.json({
          tweet: {
            text: '鶏むねのやわらか焼き\n鶏むね肉 300g',
            author: { screen_name: 'someone' },
            media: { photos: [{ url: 'https://pbs.twimg.com/media/1.jpg' }, { url: 'https://pbs.twimg.com/media/2.jpg' }] },
          },
        }),
    ],
  ]);
  const data = await (await call('/?url=' + encodeURIComponent('https://x.com/someone/status/123?s=20'))).json();
  assert.equal(data.source, 'x');
  assert.equal(data.author, '@someone');
  assert.equal(data.text, '鶏むねのやわらか焼き\n鶏むね肉 300g');
  assert.equal(data.images.length, 2);
});

test('TikTok は oEmbed を使う', async () => {
  mockFetch([
    ['https://www.tiktok.com/oembed', () => Response.json({ title: '5分でできる #レシピ', author_unique_id: 'chef', thumbnail_url: 'https://p16.tiktokcdn.com/t.jpg' })],
  ]);
  const data = await (await call('/?url=' + encodeURIComponent('https://www.tiktok.com/@chef/video/1'))).json();
  assert.equal(data.source, 'tiktok');
  assert.equal(data.text, '5分でできる #レシピ');
  assert.equal(data.author, '@chef');
});

test('画像の中継は画像だけを通す', async () => {
  mockFetch([
    ['https://img.example.com/ok.jpg', () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } })],
    ['https://img.example.com/page', () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } })],
  ]);
  const ok = await call('/image?url=' + encodeURIComponent('https://img.example.com/ok.jpg'));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Content-Type'), 'image/jpeg');
  assert.equal((await ok.arrayBuffer()).byteLength, 3);
  const ng = await call('/image?url=' + encodeURIComponent('https://img.example.com/page'));
  assert.equal(ng.status, 502);
});

test('合言葉と URL の検証', async () => {
  assert.equal((await call('/?url=https://x.com/a/status/1', {}, { TOKEN: 's3cret' })).status, 401);
  assert.equal((await call('/?url=javascript:alert(1)')).status, 400);
  assert.equal((await call('/')).status, 400);
  const pre = await worker.fetch(new Request('https://w.dev/', { method: 'OPTIONS' }), {});
  assert.equal(pre.headers.get('Access-Control-Allow-Headers'), 'X-Import-Token');
});
