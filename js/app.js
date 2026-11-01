import * as db from './db.js';
import { processImage } from './image.js';
import { scaleText, firstAmount, formatAmount, parseUserAmount, parseRecipeText, toHalfWidth } from './recipe-text.js';
import { makeRecipeCard } from './card.js';
import { extractRecipe, getApiKey, setApiKey } from './ai.js';
import { importFromUrl, getImportSettings, setImportSettings } from './importer.js';

// ---------- 定数・ユーティリティ ----------

const SOURCES = {
  instagram: 'Instagram',
  x: 'X',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  web: 'Web',
  other: 'その他',
};

const SORTS = {
  new: '新しい順',
  old: '古い順',
  title: 'タイトル順',
  cooked: 'よく作る順',
};

const view = document.getElementById('view');
const $ = (sel, root = view) => root.querySelector(sel);
const $$ = (sel, root = view) => [...root.querySelectorAll(sel)];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

export function detectSource(url) {
  try {
    const h = new URL(url).hostname.replace(/^(www|m|mobile|vt|vm)\./, '');
    if (/(^|\.)instagram\.com$/.test(h)) return 'instagram';
    if (/(^|\.)(x|twitter)\.com$/.test(h)) return 'x';
    if (/(^|\.)tiktok\.com$/.test(h)) return 'tiktok';
    if (/(^|\.)(youtube\.com|youtu\.be)$/.test(h)) return 'youtube';
    return 'web';
  } catch {
    return '';
  }
}

const extractUrl = (text) => (String(text || '').match(/https?:\/\/[^\s<>"'）)]+/) || [])[0] || '';

function parseTags(text) {
  const tags = String(text || '')
    .split(/[,、，\s#＃]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return [...new Set(tags)];
}

function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function toast(msg, ms = 2400) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), ms);
}

// 画面ごとに作った blob URL は次の描画で解放する
let objectUrls = [];
function blobUrl(blob) {
  const u = URL.createObjectURL(blob);
  objectUrls.push(u);
  return u;
}
function releaseUrls() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
}

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* プライベートモード等では保存しない */
    }
  },
};

// ---------- ルーティング ----------

function parseRoute() {
  const hash = location.hash.slice(1) || '/';
  const [path, query] = hash.split('?');
  return { parts: path.split('/').filter(Boolean), params: new URLSearchParams(query || '') };
}

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  releaseUrls();
  const { parts, params } = parseRoute();
  document.body.dataset.route = parts[0] || 'list';
  try {
    if (parts[0] === 'new') return await renderForm(null, params);
    if (parts[0] === 'settings') return await renderSettings();
    if (parts[0] === 'r' && parts[1]) {
      const recipe = await db.get(parts[1]);
      if (seq !== renderSeq) return;
      if (!recipe) {
        view.innerHTML = `<div class="empty"><p>レシピが見つかりませんでした。</p><a class="btn" href="#/">一覧へ戻る</a></div>`;
        return;
      }
      return parts[2] === 'edit' ? await renderForm(recipe, params) : renderDetail(recipe);
    }
    return await renderList(seq);
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="empty"><p>エラーが発生しました：${esc(err.message)}</p><a class="btn" href="#/">一覧へ戻る</a></div>`;
  }
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

// ---------- 一覧 ----------

const listState = store.get('listState', { q: '', filter: 'all', tag: '', sort: 'new' });

function matches(r, q) {
  if (!q) return true;
  const hay = [r.title, r.author, r.memo, r.ingredients, r.steps, SOURCES[r.source], ...(r.tags || [])]
    .join('\n')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function applyFilters(recipes) {
  const { q, filter, tag, sort } = listState;
  let list = recipes.filter((r) => {
    if (filter === 'fav' && !r.favorite) return false;
    if (filter === 'todo' && r.cookedCount > 0) return false;
    if (filter === 'done' && !(r.cookedCount > 0)) return false;
    if (SOURCES[filter] && r.source !== filter) return false;
    if (tag && !(r.tags || []).includes(tag)) return false;
    return matches(r, q);
  });
  const by = {
    new: (a, b) => b.createdAt - a.createdAt,
    old: (a, b) => a.createdAt - b.createdAt,
    title: (a, b) => (a.title || '').localeCompare(b.title || '', 'ja'),
    cooked: (a, b) => (b.cookedCount || 0) - (a.cookedCount || 0) || (b.lastCookedAt || 0) - (a.lastCookedAt || 0),
  }[sort] || ((a, b) => b.createdAt - a.createdAt);
  return list.sort(by);
}

function tagCounts(recipes) {
  const counts = new Map();
  recipes.forEach((r) => (r.tags || []).forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'));
}

async function renderList(seq) {
  const recipes = await db.getAll();
  if (seq !== renderSeq) return;

  if (recipes.length === 0) {
    view.innerHTML = `
      <section class="welcome">
        <div class="welcome-art" aria-hidden="true">📸🍳</div>
        <h1>SNSで見つけたレシピを、<br>写真1枚で保存。</h1>
        <p>InstagramやXのレシピ投稿をスクリーンショットして、ここにアップロードするだけ。タイトルやタグはあとからでもOKです。</p>
        <a class="btn btn-primary btn-lg" href="#/new">写真から登録する</a>
        <ol class="howto">
          <li><b>スクショ</b>：気になるレシピ投稿をスクリーンショット</li>
          <li><b>アップロード</b>：「＋登録」から写真を選ぶ（複数枚OK）</li>
          <li><b>見返す</b>：タグやSNS別に絞り込んで、作った回数も記録</li>
        </ol>
      </section>`;
    return;
  }

  const sourcesUsed = Object.keys(SOURCES).filter((s) => recipes.some((r) => r.source === s));
  const tags = tagCounts(recipes);
  if (listState.tag && !tags.some(([t]) => t === listState.tag)) listState.tag = '';

  const chip = (value, label, current, attr = 'filter') =>
    `<button type="button" class="chip${current === value ? ' on' : ''}" data-${attr}="${esc(value)}" aria-pressed="${current === value}">${label}</button>`;

  view.innerHTML = `
    <section class="list-tools">
      <div class="search">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M10 4a6 6 0 1 0 3.7 10.7l4.8 4.8 1.4-1.4-4.8-4.8A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/></svg>
        <input id="q" type="search" placeholder="料理名・材料・タグで検索" value="${esc(listState.q)}" autocomplete="off" enterkeyhint="search">
      </div>
      <div class="chips" role="group" aria-label="絞り込み">
        ${chip('all', 'すべて', listState.filter)}
        ${chip('fav', '★ お気に入り', listState.filter)}
        ${chip('todo', 'まだ作ってない', listState.filter)}
        ${chip('done', '作った', listState.filter)}
        ${sourcesUsed.map((s) => chip(s, SOURCES[s], listState.filter)).join('')}
      </div>
      ${
        tags.length
          ? `<div class="chips tags" role="group" aria-label="タグ">
              ${tags.map(([t, n]) => chip(t, `#${esc(t)} <small>${n}</small>`, listState.tag, 'tag')).join('')}
            </div>`
          : ''
      }
      <div class="list-meta">
        <span id="count"></span>
        <label class="sort">並び順
          <select id="sort">${Object.entries(SORTS)
            .map(([k, v]) => `<option value="${k}"${listState.sort === k ? ' selected' : ''}>${v}</option>`)
            .join('')}</select>
        </label>
      </div>
    </section>
    <section id="grid" class="grid" aria-live="polite"></section>
    <a href="#/new" class="fab" aria-label="レシピを登録">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>
      <span>登録</span>
    </a>`;

  const drawGrid = () => {
    store.set('listState', listState);
    const list = applyFilters(recipes);
    $('#count').textContent = `${list.length} / ${recipes.length} 件`;
    $('#grid').innerHTML = list.length
      ? list.map(cardHtml).join('')
      : `<p class="empty-inline">条件に合うレシピがありません。</p>`;
  };

  const cardHtml = (r) => {
    const thumb = r.images?.[0]?.thumb;
    return `
      <a class="card" href="#/r/${esc(r.id)}">
        <div class="card-img">
          ${thumb ? `<img src="${blobUrl(thumb)}" alt="" loading="lazy">` : '<div class="noimg">🍽</div>'}
          ${r.source ? `<span class="badge src-${esc(r.source)}">${esc(SOURCES[r.source] || '')}</span>` : ''}
          ${r.favorite ? '<span class="fav" aria-label="お気に入り">★</span>' : ''}
          ${r.images?.length > 1 ? `<span class="pages">${r.images.length}枚</span>` : ''}
        </div>
        <div class="card-body">
          <h2>${esc(r.title)}</h2>
          <div class="card-sub">
            ${r.cookedCount ? `<span class="cooked">作った ${r.cookedCount}回</span>` : ''}
            ${(r.tags || []).slice(0, 3).map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}
          </div>
        </div>
      </a>`;
  };

  drawGrid();

  let t;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      listState.q = e.target.value.trim();
      drawGrid();
    }, 150);
  });
  $('#sort').addEventListener('change', (e) => {
    listState.sort = e.target.value;
    drawGrid();
  });
  $('.list-tools').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const group = btn.parentElement;
    if (btn.dataset.filter !== undefined) listState.filter = btn.dataset.filter;
    if (btn.dataset.tag !== undefined) listState.tag = listState.tag === btn.dataset.tag ? '' : btn.dataset.tag;
    $$('.chip', group).forEach((c) => {
      const on = c.dataset.filter !== undefined ? c.dataset.filter === listState.filter : c.dataset.tag === listState.tag;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on);
    });
    drawGrid();
  });
}

// ---------- 登録・編集フォーム ----------

const linesToText = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean).join('\n') : String(v || '').trim());

async function renderForm(recipe, params) {
  const isNew = !recipe;
  const all = await db.getAll();
  const knownTags = tagCounts(all).map(([t]) => t);

  const draft = recipe
    ? { ...recipe, images: [] }
    : { title: '', url: '', source: '', author: '', tags: [], servings: null, ingredients: '', steps: '', memo: '' };
  // 画像は Blob のまま扱う。generated: true は文章から自動で作ったカード画像
  let images = recipe ? [...recipe.images] : [];
  let pasteInit = '';

  // 他アプリの「共有」から来た場合
  if (isNew && params.get('shared')) {
    const shared = await db.takeInbox();
    if (shared) {
      const url = safeUrl(shared.url) || extractUrl(shared.text) || extractUrl(shared.title);
      draft.url = url;
      draft.source = detectSource(url);
      pasteInit = [shared.title, shared.text].filter(Boolean).join('\n').replace(url, '').trim();
      for (const f of shared.files || []) {
        try {
          images.push(await processImage(f));
        } catch (err) {
          toast(err.message, 4000);
        }
      }
      history.replaceState(null, '', '#/new');
    }
  }

  const hasAiKey = Boolean(getApiKey());
  const hasImporter = Boolean(getImportSettings().url);

  view.innerHTML = `
    <form class="form" id="form" novalidate>
      <div class="form-head">
        <h1>${isNew ? 'レシピを登録' : 'レシピを編集'}</h1>
        <p class="hint">${isNew ? '写真か投稿文のどちらかだけで保存できます。ほかの項目はあとから追加してもOK。' : ''}</p>
      </div>

      <section class="field">
        <span class="label">写真 <em>（SNSのスクショ・料理写真など・複数枚OK）</em></span>
        <div class="drop" id="drop" tabindex="0" role="button" aria-label="写真を選ぶ">
          <input type="file" id="file" accept="image/*" multiple hidden>
          <div class="drop-inner">
            <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><path fill="currentColor" d="M9 3 7.2 5H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9Zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>
            <b>タップして写真を選ぶ</b>
            <span class="desktop-only">ドラッグ＆ドロップ・貼り付け（Ctrl+V）もできます</span>
          </div>
        </div>
        <div class="previews" id="previews"></div>
        <div class="tool-row" id="photoTools">
          <button type="button" class="btn btn-ai" id="aiBtn">✨ AIでレシピを書き起こす</button>
          <button type="button" class="btn btn-ghost" id="ocrBtn">🔍 写真の文字を読み取る</button>
          <button type="button" class="btn btn-ghost" id="cardBtn">🎨 文章から画像を作る</button>
        </div>
        <p class="hint" id="photoHint"></p>
        <div class="ocr-result" id="ocrResult" hidden>
          <div class="progress" id="ocrProgress" hidden><div></div><span></span></div>
          <textarea id="ocrText" rows="6" aria-label="読み取ったテキスト"></textarea>
          <div class="ocr-actions">
            <button type="button" class="btn btn-small btn-primary" id="ocrSplit">自動で振り分ける</button>
            <span class="hint">または選択した部分を：</span>
            <button type="button" class="btn btn-small" data-ocr-to="title">料理名へ</button>
            <button type="button" class="btn btn-small" data-ocr-to="ingredients">材料へ</button>
            <button type="button" class="btn btn-small" data-ocr-to="steps">作り方へ</button>
            <button type="button" class="btn btn-small" data-ocr-to="memo">メモへ</button>
          </div>
        </div>
      </section>

      <section class="field import-box">
        <span class="label">📝 SNSの投稿文から登録</span>
        <textarea id="pasteText" rows="4" placeholder="InstagramやXの投稿文（キャプション）をコピーして貼り付けると、料理名・材料・作り方・タグに自動で振り分けます">${esc(pasteInit)}</textarea>
        <div class="tool-row">
          ${navigator.clipboard?.readText ? '<button type="button" class="btn btn-small" id="clipBtn">📋 コピーした文章を貼り付け</button>' : ''}
          <button type="button" class="btn btn-small btn-primary" id="splitBtn">自動で振り分ける</button>
        </div>
      </section>

      <div class="field">
        <label class="label" for="urlInput">元の投稿のURL</label>
        <input name="url" id="urlInput" type="url" inputmode="url" value="${esc(draft.url)}" placeholder="https://www.instagram.com/p/..." autocomplete="off">
        <div class="tool-row">
          <button type="button" class="btn btn-small" id="importBtn">📥 このURLから写真と文章を取り込む</button>
          ${hasImporter ? '' : '<span class="hint">（設定画面で取り込みサーバーを登録すると使えます）</span>'}
        </div>
      </div>

      <div class="field-row">
        <label class="field grow">
          <span class="label">料理名</span>
          <input name="title" value="${esc(draft.title)}" placeholder="例：レンジで5分！やみつき無限キャベツ" maxlength="120">
        </label>
        <label class="field servings">
          <span class="label">何人分</span>
          <input name="servings" type="number" inputmode="numeric" min="1" max="99" value="${draft.servings || ''}" placeholder="2">
        </label>
      </div>

      <div class="field">
        <span class="label">どこで見つけた？</span>
        <div class="chips" id="sourceChips" role="radiogroup">
          ${Object.entries(SOURCES)
            .map(
              ([k, v]) =>
                `<button type="button" role="radio" class="chip${draft.source === k ? ' on' : ''}" data-source="${k}" aria-checked="${draft.source === k}">${v}</button>`
            )
            .join('')}
        </div>
      </div>

      <label class="field">
        <span class="label">投稿者</span>
        <input name="author" value="${esc(draft.author)}" placeholder="@アカウント名" autocomplete="off">
      </label>

      <label class="field">
        <span class="label">タグ <em>（スペースか「、」区切り）</em></span>
        <input name="tags" id="tagsInput" value="${esc((draft.tags || []).join(' '))}" placeholder="例：作り置き 時短 鶏むね" autocomplete="off">
      </label>
      ${
        knownTags.length
          ? `<div class="chips small" id="tagSuggest" aria-label="これまでのタグ">${knownTags
              .slice(0, 24)
              .map((t) => `<button type="button" class="chip" data-addtag="${esc(t)}">#${esc(t)}</button>`)
              .join('')}</div>`
          : ''
      }

      <label class="field">
        <span class="label">材料 <em>（1行に1つ。「鶏むね肉 300g」のように書くと分量を自動計算できます）</em></span>
        <textarea name="ingredients" rows="5" placeholder="キャベツ 1/4玉&#10;鶏ガラスープの素 小さじ1&#10;ごま油 大さじ1">${esc(draft.ingredients)}</textarea>
      </label>

      <label class="field">
        <span class="label">作り方 <em>（1行に1ステップ）</em></span>
        <textarea name="steps" rows="5" placeholder="キャベツをちぎって耐熱容器に入れる&#10;ラップをしてレンジ600Wで3分">${esc(draft.steps)}</textarea>
      </label>

      <label class="field">
        <span class="label">メモ</span>
        <textarea name="memo" rows="3" placeholder="アレンジしたいこと、感想など">${esc(draft.memo)}</textarea>
      </label>

      <div class="form-actions">
        <a class="btn" href="${isNew ? '#/' : `#/r/${esc(recipe.id)}`}">キャンセル</a>
        <button type="submit" class="btn btn-primary" id="saveBtn">${isNew ? '保存する' : '変更を保存'}</button>
      </div>
    </form>`;

  const form = $('#form');
  const f = form.elements;
  const fileInput = $('#file');
  const drop = $('#drop');
  const pasteText = $('#pasteText');
  let processing = 0;
  let appliedPaste = '';

  const realImages = () => images.filter((im) => !im.generated);

  const drawPreviews = () => {
    $('#previews').innerHTML =
      images
        .map(
          (im, i) => `
        <figure class="preview">
          <img src="${blobUrl(im.thumb)}" alt="写真${i + 1}">
          ${im.generated ? '<span class="cover gen">自動作成</span>' : i === 0 ? '<span class="cover">表紙</span>' : `<button type="button" class="mini" data-cover="${i}" title="表紙にする">表紙に</button>`}
          <button type="button" class="remove" data-remove="${i}" aria-label="写真${i + 1}を削除">×</button>
        </figure>`
        )
        .join('') + (processing ? `<div class="preview loading" aria-label="処理中"><span class="spinner"></span></div>` : '');
    const hasPhotos = realImages().length > 0;
    $('#ocrBtn').hidden = !hasPhotos;
    $('#cardBtn').hidden = hasPhotos;
    $('#photoHint').textContent = hasPhotos
      ? hasAiKey
        ? 'AIなら、レシピが書かれていない料理写真からも作り方を推測できます'
        : '「写真の文字を読み取る」で、画像に書かれた材料や作り方を文字にできます'
      : '写真がないときは、保存時に文章からカード画像を自動で作ります';
  };

  const addBlobs = async (blobs) => {
    const list = [...blobs].filter((b) => (b.type || '').startsWith('image/') || /\.(heic|heif)$/i.test(b.name || ''));
    if (!list.length) return;
    images = realImages(); // 本物の写真が来たら自動作成のカードは外す
    processing += list.length;
    drawPreviews();
    for (const b of list) {
      try {
        images.push(await processImage(b));
      } catch (err) {
        toast(err.message, 4000);
      } finally {
        processing--;
        drawPreviews();
      }
    }
  };

  drawPreviews();

  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    addBlobs(fileInput.files);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    addBlobs(e.dataTransfer.files);
  });
  const onPaste = (e) => {
    if (!document.body.contains(form)) return document.removeEventListener('paste', onPaste);
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addBlobs(files);
    }
  };
  document.addEventListener('paste', onPaste);

  $('#previews').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    const cv = e.target.closest('[data-cover]');
    if (rm) images.splice(Number(rm.dataset.remove), 1);
    if (cv) images.unshift(...images.splice(Number(cv.dataset.cover), 1));
    if (rm || cv) drawPreviews();
  });

  // URL を入れたら SNS を自動判定
  const setSource = (s) => {
    draft.source = s;
    $$('#sourceChips .chip').forEach((c) => {
      c.classList.toggle('on', c.dataset.source === s);
      c.setAttribute('aria-checked', c.dataset.source === s);
    });
  };
  f.url.addEventListener('input', () => {
    const s = detectSource(f.url.value.trim());
    if (s) setSource(s);
  });
  $('#sourceChips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-source]');
    if (c) setSource(draft.source === c.dataset.source ? '' : c.dataset.source);
  });

  $('#tagSuggest')?.addEventListener('click', (e) => {
    const c = e.target.closest('[data-addtag]');
    if (!c) return;
    const tags = parseTags(f.tags.value);
    if (!tags.includes(c.dataset.addtag)) tags.push(c.dataset.addtag);
    f.tags.value = tags.join(' ');
  });

  /**
   * 読み取った内容を各欄に入れる。入力済みの欄があれば上書きするか確認する（ask=false なら空欄だけ埋める）
   */
  const applyRecipe = (p, { ask = true } = {}) => {
    const incoming = {
      title: String(p.title || '').trim(),
      ingredients: linesToText(p.ingredients),
      steps: linesToText(p.steps),
    };
    const conflicts = Object.entries(incoming).filter(([k, v]) => v && f[k].value.trim() && f[k].value.trim() !== v);
    const overwrite =
      ask && conflicts.length
        ? confirm('入力済みの項目があります。読み取った内容で置き換えますか？\n（キャンセルすると空欄だけ埋めます）')
        : false;
    const changed = [];
    const set = (name, v) => {
      if (!v || (f[name].value.trim() && !overwrite) || f[name].value.trim() === v) return;
      f[name].value = v;
      changed.push(f[name]);
    };
    set('title', incoming.title);
    set('ingredients', incoming.ingredients);
    set('steps', incoming.steps);
    if (p.servings > 0) set('servings', String(p.servings));
    set('author', String(p.author || '').trim());
    const memo = linesToText(p.memo);
    if (memo && !f.memo.value.includes(memo)) {
      f.memo.value = [f.memo.value.trim(), memo].filter(Boolean).join('\n');
      changed.push(f.memo);
    }
    if (p.tags?.length) {
      const tags = parseTags(f.tags.value);
      const before = tags.length;
      for (const t of p.tags) if (!tags.includes(t)) tags.push(String(t).replace(/^[#＃]/, ''));
      if (tags.length !== before) {
        f.tags.value = tags.join(' ');
        changed.push(f.tags);
      }
    }
    if (p.url && !f.url.value.trim()) {
      f.url.value = p.url;
      setSource(detectSource(p.url));
      changed.push(f.url);
    }
    changed.forEach((el) => {
      el.classList.remove('filled');
      void el.offsetWidth;
      el.classList.add('filled');
    });
    return changed.length;
  };

  // 投稿文の振り分け
  const splitPaste = (opts) => {
    const text = pasteText.value.trim();
    if (!text) return 0;
    appliedPaste = pasteText.value;
    return applyRecipe(parseRecipeText(text), opts);
  };
  $('#splitBtn').addEventListener('click', () => {
    if (!pasteText.value.trim()) return toast('投稿文を貼り付けてください');
    const n = splitPaste();
    toast(n ? '振り分けました。内容を確認してください' : '振り分けられる項目が見つかりませんでした');
  });
  $('#clipBtn')?.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) return toast('コピーされた文章がありません');
      pasteText.value = text;
      const url = extractUrl(text);
      if (url && !f.url.value.trim()) {
        f.url.value = url;
        setSource(detectSource(url));
      }
      const n = splitPaste();
      toast(n ? '貼り付けて振り分けました' : '貼り付けました');
    } catch {
      toast('貼り付けを許可してください（または入力欄に直接貼り付けてください）', 4000);
    }
  });

  // URL から取り込み（取り込みサーバー経由）
  $('#importBtn').addEventListener('click', async () => {
    const url = safeUrl(f.url.value.trim());
    if (!url) return toast('先に元の投稿のURLを入力してください');
    const btn = $('#importBtn');
    btn.disabled = true;
    btn.textContent = '取り込み中…';
    try {
      const data = await importFromUrl(url);
      if (data.images.length) await addBlobs(data.images);
      const text = [data.title, data.text].filter(Boolean).join('\n');
      if (text) {
        pasteText.value = text;
        appliedPaste = text;
        applyRecipe({ ...parseRecipeText(text), author: data.author }, { ask: true });
      } else if (data.author) applyRecipe({ author: data.author });
      const msg = [];
      if (data.images.length) msg.push(`写真${data.images.length}枚`);
      if (text) msg.push('投稿文');
      toast(msg.length ? `${msg.join('と')}を取り込みました${data.failedImages ? `（写真${data.failedImages}枚は取得できませんでした）` : ''}` : '取り込める内容が見つかりませんでした', 4000);
    } catch (err) {
      toast(err.message, 5000);
    } finally {
      btn.disabled = false;
      btn.textContent = '📥 このURLから写真と文章を取り込む';
    }
  });

  // AI で書き起こし
  $('#aiBtn').addEventListener('click', async () => {
    const photos = realImages();
    const text = pasteText.value.trim();
    if (!photos.length && !text) return toast('写真を選ぶか、投稿文を貼り付けてください');
    if (!getApiKey()) return toast('設定画面でClaudeのAPIキーを登録すると使えます', 4000);
    const btn = $('#aiBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner small"></span> AIが書き起こし中…';
    try {
      const r = await extractRecipe({ images: photos.map((im) => im.full), text, url: f.url.value.trim() });
      if (text) appliedPaste = pasteText.value;
      const n = applyRecipe(r);
      toast(r.estimated ? '写真から作り方を推測しました。内容を確認してください' : n ? '書き起こしました。内容を確認してください' : '新しく入る内容はありませんでした', 4000);
    } catch (err) {
      console.error(err);
      toast(err.message, 5000);
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ AIでレシピを書き起こす';
    }
  });

  // 文字読み取り（OCR）
  $('#ocrBtn').addEventListener('click', async () => {
    const btn = $('#ocrBtn');
    const box = $('#ocrResult');
    const prog = $('#ocrProgress');
    btn.disabled = true;
    box.hidden = false;
    prog.hidden = false;
    try {
      const { recognizeText } = await import('./ocr.js');
      const text = await recognizeText(
        realImages().map((im) => im.full),
        (ratio, label) => {
          prog.firstElementChild.style.width = `${Math.round(ratio * 100)}%`;
          prog.lastElementChild.textContent = label;
        }
      );
      $('#ocrText').value = text || '（文字が見つかりませんでした）';
    } catch (err) {
      toast(err.message, 4000);
      box.hidden = !$('#ocrText').value;
    } finally {
      prog.hidden = true;
      btn.disabled = false;
    }
  });
  $('#ocrSplit').addEventListener('click', () => {
    const n = applyRecipe(parseRecipeText($('#ocrText').value));
    toast(n ? '振り分けました。内容を確認してください' : '振り分けられる項目が見つかりませんでした');
  });
  $('#ocrResult').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ocr-to]');
    if (!b) return;
    const ta = $('#ocrText');
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim() || ta.value.trim();
    if (!sel) return;
    const field = f[b.dataset.ocrTo];
    if (b.dataset.ocrTo === 'title') field.value = sel.split('\n')[0].slice(0, 120);
    else field.value = field.value ? `${field.value.replace(/\s+$/, '')}\n${sel}` : sel;
    field.focus();
    toast('追加しました');
  });

  // 文章からカード画像
  const buildCard = async (title) => {
    const blob = await makeRecipeCard({ title, ingredients: f.ingredients.value, tags: parseTags(f.tags.value) });
    const im = await processImage(blob);
    return { ...im, generated: true };
  };
  $('#cardBtn').addEventListener('click', async () => {
    const title = f.title.value.trim();
    if (!title && !f.ingredients.value.trim()) return toast('料理名か材料を入れると画像を作れます');
    images = [await buildCard(title || 'レシピ')];
    drawPreviews();
    toast('カード画像を作りました');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (processing) return toast('写真を処理中です。少しお待ちください');
    // 貼り付けたまま振り分けていない投稿文は、空欄にだけ自動で入れる
    if (pasteText.value.trim() && pasteText.value !== appliedPaste) splitPaste({ ask: false });

    const title = f.title.value.trim();
    const hasText = title || f.ingredients.value.trim() || f.steps.value.trim() || f.memo.value.trim();
    if (!realImages().length && !hasText) {
      toast('写真か投稿文（または料理名）を入れてください');
      return;
    }
    const url = safeUrl(f.url.value.trim());
    if (f.url.value.trim() && !url) return toast('URLの形式が正しくありません');
    const now = Date.now();
    const finalTitle = title || `${formatDate(now)} のレシピ`;
    $('#saveBtn').disabled = true;
    try {
      // 写真がなければ（または自動作成のカードだけなら最新の内容で）カード画像を作る
      if (!realImages().length) {
        try {
          images = [await buildCard(finalTitle)];
        } catch (err) {
          console.warn(err);
          images = [];
        }
      }
      const servings = parseInt(toHalfWidth(f.servings.value), 10);
      const saved = {
        ...(recipe || { id: uid(), createdAt: now, favorite: false, cookedCount: 0, lastCookedAt: null }),
        title: finalTitle,
        url,
        source: draft.source || detectSource(url) || '',
        author: f.author.value.trim(),
        tags: parseTags(f.tags.value),
        servings: servings > 0 ? servings : null,
        ingredients: f.ingredients.value.trim(),
        steps: f.steps.value.trim(),
        memo: f.memo.value.trim(),
        images,
        updatedAt: now,
      };
      await db.put(saved);
      toast(isNew ? '保存しました' : '更新しました');
      go(`#/r/${saved.id}`);
    } catch (err) {
      console.error(err);
      toast(`保存できませんでした：${err.message}`, 5000);
      $('#saveBtn').disabled = false;
    }
  });
}

// ---------- 詳細 ----------

function lines(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

const RATIOS = [
  [0.5, '×1/2'],
  [1, '×1'],
  [1.5, '×1.5'],
  [2, '×2'],
  [3, '×3'],
];

function formatRatio(r) {
  const x = Math.round(r * 100) / 100;
  return `×${x}`;
}

function renderDetail(r) {
  const url = safeUrl(r.url);
  const ingredients = lines(r.ingredients);
  const steps = lines(r.steps).map((s) => s.replace(/^(?:\d+\s*[.)．、:：]|[①-⑳]|step\s*\d+[.:：]?)\s*/i, ''));
  const baseServings = r.servings || null;
  const scalable = ingredients.some((l) => firstAmount(l)) || steps.some((s) => scaleText(s, 2, 'step').some((p) => p.scaled));

  view.innerHTML = `
    <article class="detail">
      ${
        r.images?.length
          ? `<div class="gallery" id="gallery">
              ${r.images.map((im, i) => `<img src="${blobUrl(im.full)}" alt="写真${i + 1}" data-zoom="${i}">`).join('')}
            </div>
            ${r.images.length > 1 ? `<div class="dots">${r.images.map((_, i) => `<span${i === 0 ? ' class="on"' : ''}></span>`).join('')}</div>` : ''}`
          : ''
      }
      <div class="detail-body">
        <div class="detail-meta">
          ${r.source ? `<span class="badge src-${esc(r.source)}">${esc(SOURCES[r.source])}</span>` : ''}
          ${r.author ? `<span class="author">${esc(r.author)}</span>` : ''}
          <span class="date">${formatDate(r.createdAt)} 保存</span>
        </div>
        <h1>${esc(r.title)}</h1>
        ${r.tags?.length ? `<div class="tag-row">${r.tags.map((t) => `<a class="tag" href="#/" data-tag="${esc(t)}">#${esc(t)}</a>`).join('')}</div>` : ''}

        <div class="actions">
          <button type="button" class="btn${r.favorite ? ' on' : ''}" id="favBtn" aria-pressed="${!!r.favorite}">${r.favorite ? '★ お気に入り' : '☆ お気に入り'}</button>
          <button type="button" class="btn btn-primary" id="cookBtn">🍳 作った！${r.cookedCount ? `（${r.cookedCount}回）` : ''}</button>
          ${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">元の投稿を開く ↗</a>` : ''}
        </div>
        ${r.lastCookedAt ? `<p class="hint">最後に作った日：${formatDate(r.lastCookedAt)} <button type="button" class="link" id="undoCook">1回取り消す</button></p>` : ''}

        ${
          ingredients.length
            ? `<section class="block">
                <div class="block-head">
                  <h2>材料</h2>
                  ${
                    baseServings
                      ? `<div class="stepper" role="group" aria-label="人数">
                          <button type="button" data-serv="-1" aria-label="1人分減らす">−</button>
                          <span id="servLabel"></span>
                          <button type="button" data-serv="1" aria-label="1人分増やす">＋</button>
                        </div>`
                      : ''
                  }
                </div>
                ${
                  scalable
                    ? `<div class="scale-bar">
                        <div class="chips small" id="ratioChips">${RATIOS.map(([v, l]) => `<button type="button" class="chip" data-ratio="${v}">${l}</button>`).join('')}</div>
                        <span class="ratio-now" id="ratioNow" hidden></span>
                      </div>
                      <p class="hint">下線の分量をタップして手元の量を入れると、ほかの材料も同じ割合で計算し直します</p>`
                    : ''
                }
                <ul class="checklist" id="ingList"></ul>
              </section>`
            : ''
        }
        ${steps.length ? `<section class="block"><h2>作り方</h2><ol class="steps" id="stepList"></ol></section>` : ''}
        ${r.memo ? `<section class="block"><h2>メモ</h2><p class="memo">${esc(r.memo)}</p></section>` : ''}
        ${
          !ingredients.length && !steps.length && !r.memo
            ? `<p class="hint">材料や作り方を書いておくと、検索で見つけやすくなり、分量の計算もできます。<a href="#/r/${esc(r.id)}/edit">追加する</a></p>`
            : ''
        }

        <div class="detail-foot">
          <a class="btn" href="#/r/${esc(r.id)}/edit">編集</a>
          <button type="button" class="btn btn-danger" id="delBtn">削除</button>
        </div>
      </div>
    </article>
    <dialog id="zoom" class="zoom"><form method="dialog"><button aria-label="閉じる">×</button></form><img alt=""></dialog>`;

  // --- 分量の計算 ---
  let ratio = 1;
  const checked = new Set();
  const segHtml = (parts, lineIndex) => {
    let tappable = lineIndex != null;
    return parts
      .map((p) => {
        if (!p.amount) return esc(p.text);
        if (tappable) {
          tappable = false; // 1行につき最初の分量だけをタップ対象にする
          return `<button type="button" class="amt${p.scaled ? ' scaled' : ''}" data-line="${lineIndex}">${esc(p.text)}</button>`;
        }
        return p.scaled ? `<b class="scaled">${esc(p.text)}</b>` : esc(p.text);
      })
      .join('');
  };
  const drawScaled = () => {
    const ing = $('#ingList');
    if (ing) {
      ing.innerHTML = ingredients
        .map(
          (l, i) =>
            `<li><label><input type="checkbox" data-i="${i}"${checked.has(i) ? ' checked' : ''}><span class="ing-text">${segHtml(scaleText(l, ratio), firstAmount(l) ? i : null)}</span></label></li>`
        )
        .join('');
    }
    const st = $('#stepList');
    if (st) st.innerHTML = steps.map((s) => `<li>${segHtml(scaleText(s, ratio, 'step'), null)}</li>`).join('');
    const label = $('#servLabel');
    if (label) {
      const n = baseServings * ratio;
      label.textContent = Number.isInteger(Math.round(n * 100) / 100) ? `${Math.round(n)}人分` : `約${Math.round(n * 10) / 10}人分`;
    }
    $$('#ratioChips .chip').forEach((c) => c.classList.toggle('on', Math.abs(Number(c.dataset.ratio) - ratio) < 1e-9));
    const now = $('#ratioNow');
    if (now) {
      now.hidden = ratio === 1;
      now.innerHTML = `${formatRatio(ratio)}で表示中 <button type="button" class="link" id="ratioReset">元に戻す</button>`;
    }
  };
  const setRatio = (v) => {
    if (!Number.isFinite(v) || v <= 0) return;
    ratio = Math.min(50, Math.max(0.05, v));
    drawScaled();
  };
  drawScaled();

  view.querySelector('.detail').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-ratio]');
    if (chip) return setRatio(Number(chip.dataset.ratio));
    if (e.target.closest('#ratioReset')) return setRatio(1);
    const serv = e.target.closest('[data-serv]');
    if (serv) {
      const cur = Math.round(baseServings * ratio);
      const next = Math.max(1, cur + Number(serv.dataset.serv));
      return setRatio(next / baseServings);
    }
    const amt = e.target.closest('.amt');
    if (amt) {
      e.preventDefault();
      const line = ingredients[Number(amt.dataset.line)];
      const base = firstAmount(line);
      const name = line.slice(0, toHalfWidth(line).indexOf(base.raw)).replace(/[\s:：…]+$/, '') || 'この材料';
      const shown = formatAmount(base.value * ratio, base.unit);
      const unitLabel = base.prefix ? `${base.unit}` : '';
      const unitSuffix = base.prefix ? '' : base.unit;
      const answer = prompt(`手元の「${name}」の量を入れてください（${unitLabel}${shown}${unitSuffix} → ？）\nほかの材料も同じ割合で計算し直します。`, shown);
      if (answer == null) return;
      const v = parseUserAmount(answer);
      if (!Number.isFinite(v) || v <= 0) return toast('数字で入力してください（例：450、1と1/2）');
      setRatio(v / base.value);
      toast(`${formatRatio(ratio)}で計算しました`);
    }
  });
  $('#ingList')?.addEventListener('change', (e) => {
    const i = Number(e.target.dataset.i);
    if (e.target.checked) checked.add(i);
    else checked.delete(i);
  });

  const update = async (patch, msg) => {
    Object.assign(r, patch, { updatedAt: Date.now() });
    await db.put(r);
    if (msg) toast(msg);
    renderDetail(r);
  };

  $('#favBtn').addEventListener('click', () => update({ favorite: !r.favorite }, r.favorite ? 'お気に入りを外しました' : 'お気に入りに追加しました'));
  $('#cookBtn').addEventListener('click', () =>
    update({ cookedCount: (r.cookedCount || 0) + 1, lastCookedAt: Date.now() }, 'おつかれさまでした！記録しました')
  );
  $('#undoCook')?.addEventListener('click', () => {
    const n = Math.max(0, (r.cookedCount || 0) - 1);
    update({ cookedCount: n, lastCookedAt: n ? r.lastCookedAt : null }, '取り消しました');
  });
  $('#delBtn').addEventListener('click', async () => {
    if (!confirm(`「${r.title}」を削除しますか？\nこの操作は元に戻せません。`)) return;
    await db.remove(r.id);
    toast('削除しました');
    go('#/');
  });
  $$('.tag-row [data-tag]').forEach((a) =>
    a.addEventListener('click', () => {
      Object.assign(listState, { tag: a.dataset.tag, filter: 'all', q: '' });
      store.set('listState', listState);
    })
  );

  const gallery = $('#gallery');
  if (gallery) {
    const dots = $$('.dots span');
    gallery.addEventListener(
      'scroll',
      () => {
        const i = Math.round(gallery.scrollLeft / gallery.clientWidth);
        dots.forEach((d, j) => d.classList.toggle('on', i === j));
      },
      { passive: true }
    );
    const zoom = $('#zoom');
    gallery.addEventListener('click', (e) => {
      const img = e.target.closest('img');
      if (!img || !zoom.showModal) return;
      zoom.querySelector('img').src = img.src;
      zoom.showModal();
    });
    zoom.addEventListener('click', (e) => {
      if (e.target === zoom) zoom.close();
    });
  }
}

// ---------- 設定・バックアップ ----------

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
const dataUrlToBlob = (url) => fetch(url).then((r) => r.blob());

function formatBytes(n) {
  if (!n) return '0 MB';
  return n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`;
}

async function renderSettings() {
  const recipes = await db.getAll();
  const est = (await navigator.storage?.estimate?.()) || {};
  const persisted = await navigator.storage?.persisted?.();
  const aiKey = getApiKey();
  const imp = getImportSettings();

  view.innerHTML = `
    <section class="settings">
      <h1>設定・バックアップ</h1>

      <div class="panel">
        <h2>保存状況</h2>
        <p>レシピ <b>${recipes.length}</b> 件 ／ 使用量 ${formatBytes(est.usage)}${est.quota ? `（上限の目安 ${formatBytes(est.quota)}）` : ''}</p>
        <p class="hint">データはこの端末のブラウザ内にだけ保存されます。サーバーには送信されません。</p>
        ${
          navigator.storage?.persist
            ? persisted
              ? '<p class="ok">✓ データ保護が有効です（ブラウザが自動でデータを消しにくくなっています）</p>'
              : '<button type="button" class="btn" id="persistBtn">データを消えにくくする</button>'
            : ''
        }
      </div>

      <div class="panel">
        <h2>バックアップ</h2>
        <p class="hint">機種変更やブラウザのデータ削除に備えて、ときどき書き出しておくと安心です。書き出したファイルを別の端末で読み込めば、レシピを移せます。</p>
        <div class="row">
          <button type="button" class="btn btn-primary" id="exportBtn"${recipes.length ? '' : ' disabled'}>書き出す（.json）</button>
          <button type="button" class="btn" id="importBtn">読み込む</button>
          <input type="file" id="importFile" accept="application/json,.json" hidden>
        </div>
        <p class="hint" id="backupStatus"></p>
      </div>

      <div class="panel">
        <h2>✨ AIで書き起こし（Claude）</h2>
        <p class="hint">写真や投稿文から、料理名・材料・作り方をAIが書き起こします。レシピが書かれていない料理写真からも作り方を推測できます。AnthropicのAPIキーが必要で、使った分だけ料金がかかります（1回あたり数円〜十数円程度）。</p>
        ${
          aiKey
            ? `<p class="ok">✓ APIキー登録済み（…${esc(aiKey.slice(-4))}）</p>
               <div class="row"><button type="button" class="btn btn-danger" id="aiKeyDel">キーを削除</button></div>`
            : `<div class="row">
                 <input type="password" id="aiKey" placeholder="sk-ant-..." autocomplete="off" spellcheck="false">
                 <button type="button" class="btn btn-primary" id="aiKeySave">保存</button>
               </div>`
        }
        <p class="hint">キーはこの端末のブラウザ内にだけ保存され、AnthropicのAPIを呼び出すときにだけ使います。キーは <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">Claude Console</a> で発行できます。使いすぎ防止に、Console側で月の上限額を設定しておくと安心です。</p>
      </div>

      <div class="panel">
        <h2>📥 SNS取り込みサーバー</h2>
        <p class="hint">Instagram・X・TikTok・YouTubeの投稿URLから写真と文章を取り込むための中継サーバーです（SNSはブラウザから直接読み込めないため必要です）。Cloudflare Workers に無料で設置できます。手順はリポジトリの README を見てください。</p>
        <div class="stack">
          <label class="field"><span class="label">サーバーのURL</span>
            <input type="url" id="impUrl" placeholder="https://buzz-import.xxxx.workers.dev" value="${esc(imp.url || '')}" autocomplete="off"></label>
          <label class="field"><span class="label">合言葉（設定した場合）</span>
            <input type="password" id="impToken" value="${esc(imp.token || '')}" autocomplete="off"></label>
          <div class="row">
            <button type="button" class="btn btn-primary" id="impSave">保存</button>
            ${imp.url ? '<button type="button" class="btn btn-danger" id="impDel">削除</button>' : ''}
          </div>
        </div>
      </div>

      <div class="panel">
        <h2>スマホで使うには</h2>
        <ul class="tips">
          <li><b>iPhone（Safari）</b>：共有ボタン →「ホーム画面に追加」</li>
          <li><b>Android（Chrome）</b>：メニュー →「ホーム画面に追加」または「アプリをインストール」。インストール後は、ギャラリーやSNSアプリの「共有」からこのアプリへ写真やURLを直接送れます。</li>
        </ul>
      </div>
      <p><a class="btn" href="#/">← 一覧へ戻る</a></p>
    </section>`;

  $('#persistBtn')?.addEventListener('click', async () => {
    const ok = await navigator.storage.persist();
    toast(ok ? 'データ保護を有効にしました' : 'ブラウザに許可されませんでした。ホーム画面に追加すると有効になりやすいです', 4000);
    if (ok) renderSettings();
  });

  $('#aiKeySave')?.addEventListener('click', () => {
    const key = $('#aiKey').value.trim();
    if (!/^sk-ant-/.test(key)) return toast('「sk-ant-」で始まるAPIキーを入力してください');
    setApiKey(key);
    toast('APIキーを保存しました');
    renderSettings();
  });
  $('#aiKeyDel')?.addEventListener('click', () => {
    if (!confirm('この端末からAPIキーを削除しますか？')) return;
    setApiKey('');
    toast('削除しました');
    renderSettings();
  });
  $('#impSave').addEventListener('click', () => {
    const url = safeUrl($('#impUrl').value.trim());
    if (!url) return toast('サーバーのURLを入力してください');
    setImportSettings({ url, token: $('#impToken').value.trim() });
    toast('保存しました');
    renderSettings();
  });
  $('#impDel')?.addEventListener('click', () => {
    setImportSettings({});
    toast('削除しました');
    renderSettings();
  });

  const status = $('#backupStatus');
  $('#exportBtn').addEventListener('click', async () => {
    status.textContent = '書き出し中…';
    const out = {
      app: 'buzz-recipe-book',
      version: 1,
      exportedAt: new Date().toISOString(),
      recipes: await Promise.all(
        recipes.map(async (r) => ({
          ...r,
          images: await Promise.all(
            (r.images || []).map(async (im) => ({ full: await blobToDataUrl(im.full), thumb: await blobToDataUrl(im.thumb) }))
          ),
        }))
      ),
    };
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `buzz-recipes-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    status.textContent = `${recipes.length} 件を書き出しました（${formatBytes(blob.size)}）`;
  });

  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    status.textContent = '読み込み中…';
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data?.recipes)) throw new Error('バズレシピ帳のバックアップファイルではありません');
      const existing = new Map(recipes.map((r) => [r.id, r]));
      let added = 0;
      let updated = 0;
      for (const r of data.recipes) {
        if (!r?.id) continue;
        const cur = existing.get(r.id);
        if (cur && (cur.updatedAt || 0) >= (r.updatedAt || 0)) continue;
        const images = await Promise.all(
          (r.images || []).map(async (im) => ({ full: await dataUrlToBlob(im.full), thumb: await dataUrlToBlob(im.thumb) }))
        );
        await db.put({
          ...r,
          title: String(r.title || '無題のレシピ'),
          tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
          url: safeUrl(r.url),
          source: SOURCES[r.source] ? r.source : '',
          images,
        });
        cur ? updated++ : added++;
      }
      toast(`読み込み完了：追加 ${added} 件・更新 ${updated} 件`, 4000);
      await renderSettings();
    } catch (err) {
      console.error(err);
      status.textContent = `読み込めませんでした：${err.message}`;
    }
  });
}

// ---------- 起動 ----------

window.addEventListener('hashchange', render);
render();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service Worker 登録失敗', err));
  });
}
