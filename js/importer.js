// 取り込みサーバー（server/import-worker.js）経由で、SNS投稿の写真と文章を取ってくる
// Instagram や X はブラウザから直接読めない（CORS・ログイン制限）ため、中継サーバーが必要。

export function getImportSettings() {
  try {
    return JSON.parse(localStorage.getItem('importServer') || '{}');
  } catch {
    return {};
  }
}
export function setImportSettings(s) {
  try {
    if (s.url) localStorage.setItem('importServer', JSON.stringify(s));
    else localStorage.removeItem('importServer');
  } catch {
    /* 保存できない環境では何もしない */
  }
}

/**
 * @returns {Promise<{title:string, text:string, author:string, images:Blob[], failedImages:number}>}
 */
export async function importFromUrl(postUrl) {
  const { url: server, token } = getImportSettings();
  if (!server) throw new Error('設定画面で「SNS取り込みサーバー」を登録すると使えます');
  const headers = token ? { 'X-Import-Token': token } : {};
  const base = server.replace(/\/+$/, '');

  let res;
  try {
    res = await fetch(`${base}/?url=${encodeURIComponent(postUrl)}`, { headers });
  } catch {
    throw new Error('取り込みサーバーに接続できませんでした');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('取り込みサーバーの合言葉が違います');
  if (!res.ok || data.error) throw new Error(data.error || `取り込みに失敗しました（${res.status}）`);

  const images = [];
  let failedImages = 0;
  for (const imgUrl of (data.images || []).slice(0, 6)) {
    try {
      const r = await fetch(`${base}/image?url=${encodeURIComponent(imgUrl)}`, { headers });
      if (!r.ok) throw new Error();
      images.push(await r.blob());
    } catch {
      failedImages++;
    }
  }
  return { title: data.title || '', text: data.text || '', author: data.author || '', images, failedImages };
}
