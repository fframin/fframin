// 写真がないレシピ用に、文章からレシピカード画像を作る（端末内で描画・ネット不要）

const EMOJI_RULES = [
  [/カレー/, '🍛'],
  [/パスタ|スパゲ|ペペロン|カルボナーラ/, '🍝'],
  [/ラーメン|うどん|そば|麺/, '🍜'],
  [/丼|ご飯|ごはん|炒飯|チャーハン|おにぎり|リゾット|米/, '🍚'],
  [/寿司|鮭|サーモン|鯖|さば|魚|ぶり|刺身|まぐろ/, '🐟'],
  [/えび|海老|エビ/, '🍤'],
  [/鶏|チキン|唐揚げ|からあげ|ささみ/, '🍗'],
  [/豚|牛|肉|ハンバーグ|ステーキ|ベーコン/, '🥩'],
  [/卵|たまご|玉子|オムレツ/, '🍳'],
  [/スープ|味噌汁|みそ汁|鍋|シチュー/, '🍲'],
  [/サラダ|キャベツ|レタス|ほうれん草|白菜|ブロッコリー|野菜/, '🥗'],
  [/パン|トースト|サンド/, '🍞'],
  [/ケーキ|クッキー|プリン|スイーツ|チョコ|タルト|マフィン|ドーナツ/, '🍰'],
  [/ピザ/, '🍕'],
  [/豆腐|納豆/, '🫘'],
  [/トマト/, '🍅'],
  [/じゃがいも|ポテト/, '🥔'],
];

const PALETTES = [
  ['#ffe8d6', '#ffb38a', '#7a2e0e'],
  ['#e6f4ea', '#9fd8b0', '#1f5130'],
  ['#fff4cc', '#ffd166', '#6b4a00'],
  ['#e8eefc', '#a8bff5', '#23356b'],
  ['#fde7ef', '#f5a3bf', '#6d1f3c'],
  ['#efe7fb', '#c3a8f0', '#3f2470'],
];

function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h;
}

export function pickEmoji(text) {
  for (const [re, e] of EMOJI_RULES) if (re.test(text)) return e;
  return '🍽️';
}

// 日本語は単語の区切りがないので1文字ずつ詰めて折り返す
function wrap(ctx, text, maxWidth, maxLines) {
  const lines = [];
  let cur = '';
  for (const ch of [...text]) {
    if (ctx.measureText(cur + ch).width > maxWidth && cur) {
      lines.push(cur);
      cur = ch;
      if (lines.length === maxLines) break;
    } else cur += ch;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  const used = lines.join('').length;
  if (used < [...text].length && lines.length) lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1) + '…';
  return lines;
}

/**
 * @param {{title:string, ingredients?:string, tags?:string[]}} recipe
 * @returns {Promise<Blob>} PNG 画像
 */
export function makeRecipeCard({ title, ingredients = '', tags = [] }) {
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const [bg, accent, ink] = PALETTES[hash(title) % PALETTES.length];
  const font = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic",Meiryo,sans-serif';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(W - 120, 160, 300, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.arc(80, H - 60, 220, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.font = `260px ${font}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  // 料理名を優先し、料理名で決まらなければ材料から選ぶ
  const fromTitle = pickEmoji(title);
  ctx.fillText(fromTitle !== '🍽️' ? fromTitle : pickEmoji(ingredients), W - 230, 260);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ink;
  ctx.font = `bold 84px ${font}`;
  let y = 560;
  for (const line of wrap(ctx, title || 'レシピ', W - 160, 3)) {
    ctx.fillText(line, 80, y);
    y += 108;
  }

  const items = ingredients
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length) {
    y += 30;
    ctx.globalAlpha = 0.85;
    ctx.font = `46px ${font}`;
    for (const item of items.slice(0, 6)) {
      const [line] = wrap(ctx, `・${item}`, W - 160, 1);
      ctx.fillText(line, 80, y);
      y += 66;
    }
    if (items.length > 6) ctx.fillText(`ほか ${items.length - 6} 品`, 80, y);
    ctx.globalAlpha = 1;
  }

  if (tags.length) {
    ctx.font = `bold 40px ${font}`;
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.7;
    const [line] = wrap(ctx, tags.slice(0, 4).map((t) => `#${t}`).join('  '), W - 160, 1);
    ctx.fillText(line, 80, H - 90);
    ctx.globalAlpha = 1;
  }

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を作れませんでした'))), 'image/png')
  );
}
