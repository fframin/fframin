// Claude API で写真・文章からレシピを書き起こす（任意機能・APIキーは利用者が設定）
// SDK は使うときだけ CDN から読み込む。キーはこの端末の localStorage にだけ保存される。
export const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.135.0/+esm';
const MODEL = 'claude-opus-5-5';
const MAX_IMAGES = 6;

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '料理名。簡潔に' },
    servings: { type: 'integer', description: '何人分か。わからなければ 0' },
    ingredients: {
      type: 'array',
      items: { type: 'string' },
      description: '材料。1要素に1つ、「材料名 分量」の形（例: 鶏むね肉 300g / 醤油 大さじ1）',
    },
    steps: { type: 'array', items: { type: 'string' }, description: '作り方。1要素に1ステップ。先頭に番号は付けない' },
    tags: { type: 'array', items: { type: 'string' }, description: '短いタグ2〜5個（主な食材・料理のジャンル・調理法など）' },
    memo: { type: 'string', description: 'コツ・保存方法・アレンジなど。なければ空文字' },
    estimated: {
      type: 'boolean',
      description: '画像や文章にレシピが書かれておらず、料理の見た目などから推測して作った場合は true',
    },
  },
  required: ['title', 'servings', 'ingredients', 'steps', 'tags', 'memo', 'estimated'],
  additionalProperties: false,
};

const SYSTEM = `あなたはSNS（Instagram・X・TikTokなど）のレシピ投稿を、家庭で見返しやすいレシピに整理するアシスタントです。
入力はスクリーンショット・料理写真・投稿文のいずれか、または組み合わせです。すべて日本語で出力してください。

- 画像や文章にレシピ（材料・分量・手順）が書かれている場合は、書かれている内容を忠実に書き起こしてください。分量や手順を勝手に変えないでください。
- 画像が料理の写真だけでレシピが書かれていない場合は、見た目から一般的な作り方を推測して作り、estimated を true にしてください。その場合は memo の冒頭に「写真から推測したレシピです。」と書いてください。
- いいね・フォロー・保存のお願いなど、レシピと関係のない呼びかけは含めないでください。
- 材料の分量は「大さじ1」「1/2個」「200g」のように、元の表記に近い形で書いてください。`;

export function getApiKey() {
  try {
    return localStorage.getItem('anthropicApiKey') || '';
  } catch {
    return '';
  }
}
export function setApiKey(key) {
  try {
    if (key) localStorage.setItem('anthropicApiKey', key);
    else localStorage.removeItem('anthropicApiKey');
  } catch {
    /* 保存できない環境では何もしない */
  }
}

let sdkPromise;
function loadSdk() {
  sdkPromise ??= import(SDK_URL).catch((err) => {
    sdkPromise = null;
    throw new Error('AIの準備に失敗しました。ネット接続を確認してください');
  });
  return sdkPromise;
}

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });

/**
 * @param {{images?: Blob[], text?: string, url?: string}} input
 * @returns {Promise<{title:string, servings:number, ingredients:string[], steps:string[], tags:string[], memo:string, estimated:boolean}>}
 */
export async function extractRecipe({ images = [], text = '', url = '' }) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('設定画面でClaudeのAPIキーを登録すると使えます');
  const { default: Anthropic } = await loadSdk();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const content = [];
  for (const blob of images.slice(0, MAX_IMAGES)) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: blob.type || 'image/jpeg', data: await blobToBase64(blob) },
    });
  }
  const notes = [];
  if (images.length) notes.push(`上の画像${Math.min(images.length, MAX_IMAGES)}枚はSNSのレシピ投稿（またはその料理）です。`);
  if (text.trim()) notes.push(`投稿の文章:\n"""\n${text.trim()}\n"""`);
  if (url) notes.push(`元の投稿のURL: ${url}`);
  notes.push('このレシピを整理してください。');
  content.push({ type: 'text', text: notes.join('\n\n') });

  let res;
  try {
    res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('APIキーが正しくありません。設定画面で確認してください');
    if (err instanceof Anthropic.PermissionDeniedError) throw new Error('このAPIキーでは利用できません（権限・残高を確認してください）');
    if (err instanceof Anthropic.RateLimitError) throw new Error('混み合っています。少し時間をおいて試してください');
    if (err instanceof Anthropic.BadRequestError) throw new Error(`リクエストが受け付けられませんでした：${err.message}`);
    if (err instanceof Anthropic.APIConnectionError) throw new Error('AIに接続できませんでした。ネット接続を確認してください');
    if (err instanceof Anthropic.APIError) throw new Error(`AIでエラーが発生しました（${err.status ?? '不明'}）`);
    throw err;
  }

  if (res.stop_reason === 'refusal') throw new Error('この内容はAIで処理できませんでした');
  if (res.stop_reason === 'max_tokens') throw new Error('内容が長すぎて書き起こしきれませんでした');
  const out = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(out);
  } catch {
    throw new Error('AIの結果を読み取れませんでした。もう一度試してください');
  }
}
