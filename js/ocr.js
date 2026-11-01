// 画像の文字読み取り（任意機能）。初回使用時にだけ Tesseract.js を CDN から読み込む。
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let loading;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_URL;
    s.onload = resolve;
    s.onerror = () => {
      loading = null;
      reject(new Error('文字読み取りの準備に失敗しました。ネット接続を確認してください'));
    };
    document.head.append(s);
  });
  return loading;
}

// Tesseract は日本語の文字間に空白を入れがちなので詰める
const CJK = '　-ヿ㐀-鿿＀-￯';
function tidy(text) {
  return text
    .replace(new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'g'), '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {Blob[]} blobs
 * @param {(ratio:number, label:string)=>void} onProgress
 */
export async function recognizeText(blobs, onProgress) {
  onProgress?.(0, '準備中（初回は少し時間がかかります）');
  await loadTesseract();
  let index = 0;
  const worker = await window.Tesseract.createWorker(['jpn', 'eng'], 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') {
        onProgress?.((index + m.progress) / blobs.length, `読み取り中 ${index + 1}/${blobs.length}`);
      }
    },
  });
  try {
    const out = [];
    for (; index < blobs.length; index++) {
      const { data } = await worker.recognize(blobs[index]);
      const t = tidy(data.text || '');
      if (t) out.push(t);
    }
    return out.join('\n\n');
  } finally {
    await worker.terminate();
  }
}
