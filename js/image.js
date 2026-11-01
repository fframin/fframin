// アップロード画像を縮小して JPEG にする（端末の容量節約のため）

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}

async function decode(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bmp, w: bmp.width, h: bmp.height };
  } catch {
    try {
      const img = await loadImageElement(file);
      return { source: img, w: img.naturalWidth, h: img.naturalHeight };
    } catch {
      throw new Error(`「${file.name || '画像'}」を読み込めませんでした。HEIC形式の場合はJPEGかPNG（スクリーンショット）で試してください`);
    }
  }
}

function toJpeg(source, w, h, maxSize, quality) {
  const scale = Math.min(1, maxSize / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(source, 0, 0, cw, ch);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像の変換に失敗しました'))), 'image/jpeg', quality);
  });
}

/** 1枚の画像から、表示用(full)と一覧用サムネイル(thumb)を作る */
export async function processImage(file) {
  const { source, w, h } = await decode(file);
  try {
    // スクショの文字が読めるよう、長辺 2000px までは残す
    const full = await toJpeg(source, w, h, 2000, 0.85);
    const thumb = await toJpeg(source, w, h, 520, 0.78);
    return { full, thumb };
  } finally {
    source.close?.();
  }
}
