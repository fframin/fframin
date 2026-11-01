// レシピ文章の解析（分量の拡大縮小・SNS投稿文の振り分け）。DOM を使わない純粋な関数だけを置く。

const FULLWIDTH = /[０-９．／]/g;
export const toHalfWidth = (s) =>
  String(s ?? '').replace(FULLWIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

const UNICODE_FRACTIONS = { '½': 1 / 2, '¼': 1 / 4, '¾': 3 / 4, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 1 / 8 };

// 数の表記: 「1と1/2」「1/2」「1.5」「½」
const NUM_RE = /(\d+\s*と\s*\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?|[½¼¾⅓⅔⅛])/g;

const PREFIX_UNITS = /(大さじ|小さじ|大匙|小匙|カップ|cup|計量カップ)\s*(約)?\s*$/i;
// 数字の後ろに付く「量」の単位（作り方の文中でもこれが付いていれば変換する）
const AMOUNT_SUFFIX =
  /^\s*(kg|mg|g|ｇ|グラム|ml|mL|ML|cc|CC|l|L|リットル|個|コ|ケ|本|枚|玉|片|かけ|株|束|袋|缶|パック|切れ|切|尾|匹|杯|合|カップ|房|丁|粒|滴|つ|膳|尾|cm)/;
// 変換してはいけない数（加熱時間・温度・倍率など）
const NO_SCALE_SUFFIX = /^\s*(w|W|ワット|分|秒|時間|℃|°|度|%|％|倍|日|回|週|段|号|人分|人前|mm|ミリ|cm幅|cm角|等分|番|ヶ月|か月|歳)/;
const FRACTION_UNITS = /^(大さじ|小さじ|大匙|小匙|カップ|cup|計量カップ|個|コ|ケ|本|枚|玉|片|かけ|株|束|袋|缶|パック|切れ|切|尾|匹|杯|合|房|丁|つ|膳)$/i;
const METRIC_UNITS = /^(kg|mg|g|ｇ|グラム|ml|mL|ML|cc|CC|l|L|リットル|cm|粒|滴)$/;

export function parseNumber(token) {
  const t = toHalfWidth(token).replace(/\s/g, '');
  if (t in UNICODE_FRACTIONS) return UNICODE_FRACTIONS[t];
  let m = t.match(/^(\d+)と(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = t.match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : NaN;
  return Number(t);
}

const NICE_FRACTIONS = [
  [0, ''],
  [1 / 4, '1/4'],
  [1 / 3, '1/3'],
  [1 / 2, '1/2'],
  [2 / 3, '2/3'],
  [3 / 4, '3/4'],
  [1, ''],
];

/** 単位に合わせて読みやすい表記にする（大さじ1と1/2、450g など） */
export function formatAmount(value, unit = '') {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (METRIC_UNITS.test(unit)) {
    if (value >= 100) return String(Math.round(value / 5) * 5);
    if (value >= 10) return String(Math.round(value));
    return String(Math.round(value * 10) / 10);
  }
  if (FRACTION_UNITS.test(unit) || !unit) {
    const whole = Math.floor(value);
    const frac = value - whole;
    let best = null;
    for (const [v, label] of NICE_FRACTIONS) {
      if (Math.abs(frac - v) < 0.06) best = [v, label];
    }
    if (best) {
      const w = best[0] === 1 ? whole + 1 : whole;
      if (!best[1]) return String(w);
      return w ? `${w}と${best[1]}` : best[1];
    }
    if (value >= 10) return String(Math.round(value));
    return String(Math.round(value * 10) / 10);
  }
  return String(Math.round(value * 10) / 10);
}

/**
 * 文章中の分量を ratio 倍にする。
 * mode='ingredient': 時間・温度など以外の数をすべて変換（材料の行向け）
 * mode='step'      : 単位の付いた量だけ変換（作り方の文中向け。「3分」「600W」「1cm幅」は変えない）
 * @returns {{text:string, scaled:boolean, amount?:boolean, original?:string}[]} 表示用の区切り
 */
export function scaleText(text, ratio, mode = 'ingredient') {
  const src = toHalfWidth(text);
  const parts = [];
  let last = 0;
  NUM_RE.lastIndex = 0;
  let m;
  while ((m = NUM_RE.exec(src))) {
    const start = m.index;
    const end = start + m[0].length;
    const before = src.slice(Math.max(0, start - 8), start);
    const after = src.slice(end, end + 6);
    // 英数字の途中（例: A1, 2x）は数として扱わない
    const glued = /[A-Za-z]$/.test(before) && !PREFIX_UNITS.test(before);
    const prefix = before.match(PREFIX_UNITS);
    const suffix = after.match(AMOUNT_SUFFIX);
    const noScale = NO_SCALE_SUFFIX.test(after);
    let scalable;
    if (glued || noScale) scalable = false;
    else if (mode === 'step') scalable = Boolean(prefix || (suffix && suffix[1] !== 'cm'));
    else scalable = true;

    if (!scalable) continue;
    const value = parseNumber(m[0]);
    if (!Number.isFinite(value)) continue;
    const unit = prefix ? prefix[1] : suffix ? suffix[1] : '';
    if (start > last) parts.push({ text: src.slice(last, start), scaled: false });
    // amount: 分量として扱った箇所（倍率1でも印を付けて、タップできるようにする）
    if (ratio === 1) parts.push({ text: m[0], scaled: false, amount: true, original: m[0] });
    else parts.push({ text: formatAmount(value * ratio, unit), scaled: true, amount: true, original: m[0] });
    last = end;
  }
  if (last < src.length) parts.push({ text: src.slice(last), scaled: false });
  return parts.length ? parts : [{ text: src, scaled: false }];
}

/** 材料の行から、基準にできる最初の量（数値と単位）を取り出す */
export function firstAmount(line) {
  const src = toHalfWidth(line);
  NUM_RE.lastIndex = 0;
  let m;
  while ((m = NUM_RE.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 8), m.index);
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 6);
    if (NO_SCALE_SUFFIX.test(after) || (/[A-Za-z]$/.test(before) && !PREFIX_UNITS.test(before))) continue;
    const value = parseNumber(m[0]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const prefix = before.match(PREFIX_UNITS);
    const suffix = after.match(AMOUNT_SUFFIX);
    return { value, unit: prefix ? prefix[1] : suffix ? suffix[1] : '', prefix: Boolean(prefix), raw: m[0] };
  }
  return null;
}

/** 「450」「450g」「1と1/2」「1.5個」などの入力から数値を取り出す */
export function parseUserAmount(input) {
  const m = toHalfWidth(input).match(/\d+\s*と\s*\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?|[½¼¾⅓⅔⅛]/);
  return m ? parseNumber(m[0]) : NaN;
}

// ---------- SNS 投稿文の振り分け ----------

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍⃣]/gu;
const DECOR = /^[\s・•●○◯◎■□◆◇▪▫▶▷►★☆✔✓☑✅✨❤♡♥︎*＊\-–—=＝~〜_|｜>＞]+/;
const SECTION_WORDS = [
  ['ingredients', /^(材料|ざいりょう|用意するもの|ingredients?)/i],
  ['steps', /^(作り方|つくりかた|作りかた|手順|工程|how\s*to(\s*make)?|directions|steps?|recipe|レシピ)/i],
  ['memo', /^(ポイント|point|コツ|memo|メモ|保存|保存方法|アレンジ|ひとこと|一言|tips?)/i],
];
const QUANTITY_HINT =
  /(大さじ|小さじ|大匙|小匙|カップ|少々|少量|適量|適宜|お好みで|ひとつまみ|ひとかけ|\d+\s*(g|ｇ|kg|ml|mL|cc|個|本|枚|玉|片|かけ|株|束|袋|缶|パック|切れ|合|房|丁|cm))/;
const STEP_MARKER = /^(\d+\s*[.)．、:：]|\d+\s+(?=[^\d\s/]{3,})|[①-⑳]|[❶-❿]|[⓵-⓾]|step\s*\d+|STEP\s*\d+|\(\d+\)|（\d+）)/i;

function stripDecor(line) {
  return line.replace(EMOJI, ' ').replace(DECOR, '').replace(/\s+/g, ' ').trim();
}

function sectionOf(line) {
  // 見出しの装飾（【】〈〉<>[]■ など）を外してから判定
  const bare = stripDecor(line).replace(/^[【〈《<＜\[［(（「『]+/, '').trim();
  for (const [kind, re] of SECTION_WORDS) {
    const m = bare.match(re);
    if (!m) continue;
    const rest = bare.slice(m[0].length).replace(/^[】〉》>＞\]］)）」』:：\s]+/, '');
    // 「材料（2人分）」のような見出しだけを認め、「材料を混ぜる」のような文は除く
    if (rest.length <= 14 && !/[をにでがはへ]/.test(rest.slice(0, 1))) return { kind, rest };
  }
  return null;
}

function cleanIngredient(line) {
  let s = stripDecor(line);
  // 「キャベツ……1/4玉」「キャベツ：1/4玉」→「キャベツ 1/4玉」
  s = s.replace(/\s*(?:[…‥]+|\.{2,}|・{2,}|:|：|\s-\s)\s*/g, ' ').trim();
  return s;
}

// 材料の行ではなく「〜する」「〜を入れる」のような手順の文か
const looksLikeStep = (s) => /を|[るすくむぐつぬぶうた。！!]$/.test(s) || s.length > 20;

function cleanStep(line) {
  return stripDecor(line).replace(STEP_MARKER, '').trim();
}

/**
 * SNS の投稿文（キャプション）や OCR 結果から、料理名・材料・作り方などを推測して振り分ける
 * @returns {{title:string, servings:number|null, ingredients:string, steps:string, memo:string, tags:string[], url:string}}
 */
export function parseRecipeText(input) {
  const text = toHalfWidth(String(input || '').replace(/\r/g, ''));
  const url = (text.match(/https?:\/\/[^\s<>"'）)]+/) || [])[0] || '';
  const tags = [];
  for (const m of text.matchAll(/[#＃]([^\s#＃,、。!！?？]+)/g)) {
    if (!tags.includes(m[1]) && tags.length < 10) tags.push(m[1]);
  }
  const sm = text.match(/(\d+)\s*(?:人分|人前)/);
  const servings = sm ? Number(sm[1]) : null;

  const out = { title: '', ingredients: [], steps: [], memo: [] };
  let mode = 'intro';
  let sawHeader = false;
  const loose = [];

  for (const raw of text.split('\n')) {
    let line = raw.replace(/[#＃][^\s#＃]+/g, '').replace(url, '').trim();
    if (!stripDecor(line)) continue;

    const sec = sectionOf(line);
    if (sec) {
      mode = sec.kind;
      sawHeader = true;
      if (sec.kind === 'ingredients' && sec.rest && !/人分|人前/.test(sec.rest) && QUANTITY_HINT.test(sec.rest)) {
        out.ingredients.push(cleanIngredient(sec.rest));
      }
      continue;
    }

    if (mode === 'intro') {
      if (!out.title) out.title = stripDecor(line).slice(0, 80);
      else loose.push(line);
    } else if (mode === 'ingredients') {
      // 材料のあとに見出しなしで番号付きの手順が始まるケース
      if (STEP_MARKER.test(stripDecor(line)) && looksLikeStep(cleanStep(line))) {
        mode = 'steps';
        out.steps.push(cleanStep(line));
      } else out.ingredients.push(cleanIngredient(line));
    } else if (mode === 'steps') out.steps.push(cleanStep(line));
    else out.memo.push(stripDecor(line));
  }

  // 見出しがない投稿は、行の見た目から推測する
  if (!sawHeader) {
    for (const line of loose) {
      const bare = stripDecor(line);
      if (STEP_MARKER.test(bare)) out.steps.push(cleanStep(line));
      else if (QUANTITY_HINT.test(bare) && bare.length <= 30) out.ingredients.push(cleanIngredient(line));
      else out.memo.push(bare);
    }
  } else {
    out.memo.unshift(...loose.map(stripDecor));
  }

  return {
    title: out.title,
    servings,
    ingredients: out.ingredients.filter(Boolean).join('\n'),
    steps: out.steps.filter(Boolean).join('\n'),
    memo: out.memo.filter(Boolean).join('\n'),
    tags,
    url,
  };
}
