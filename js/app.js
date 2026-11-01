import * as db from './db.js';
import { processImage } from './image.js';

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

async function renderForm(recipe, params) {
  const isNew = !recipe;
  const all = await db.getAll();
  const knownTags = tagCounts(all).map(([t]) => t);

  const draft = recipe
    ? structuredClone({ ...recipe, images: [] })
    : { title: '', url: '', source: '', author: '', tags: [], ingredients: '', steps: '', memo: '' };
  // 画像は Blob のまま扱う（structuredClone を避けてそのまま参照）
  const images = recipe ? [...recipe.images] : [];

  // 他アプリの「共有」から来た場合
  if (isNew && params.get('shared')) {
    const shared = await db.takeInbox();
    if (shared) {
      const url = safeUrl(shared.url) || extractUrl(shared.text) || extractUrl(shared.title);
      draft.url = url;
      draft.source = detectSource(url);
      const text = [shared.title, shared.text].filter(Boolean).join('\n').replace(url, '').trim();
      if (text) draft.memo = text;
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

  view.innerHTML = `
    <form class="form" id="form" novalidate>
      <div class="form-head">
        <h1>${isNew ? 'レシピを登録' : 'レシピを編集'}</h1>
        <p class="hint">${isNew ? '写真だけで保存できます。ほかの項目はあとから追加してもOK。' : ''}</p>
      </div>

      <section class="field">
        <span class="label">写真 <em>（SNSのスクショなど・複数枚OK）</em></span>
        <div class="drop" id="drop" tabindex="0" role="button" aria-label="写真を選ぶ">
          <input type="file" id="file" accept="image/*" multiple hidden>
          <div class="drop-inner">
            <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><path fill="currentColor" d="M9 3 7.2 5H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9Zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>
            <b>タップして写真を選ぶ</b>
            <span class="desktop-only">ドラッグ＆ドロップ・貼り付け（Ctrl+V）もできます</span>
          </div>
        </div>
        <div class="previews" id="previews"></div>
        <div class="ocr-row" id="ocrRow" hidden>
          <button type="button" class="btn btn-ghost" id="ocrBtn">🔍 写真から文字を読み取る</button>
          <span class="hint">材料や作り方が画像に書かれているときに便利です</span>
        </div>
        <div class="ocr-result" id="ocrResult" hidden>
          <div class="progress" id="ocrProgress" hidden><div></div><span></span></div>
          <textarea id="ocrText" rows="6" aria-label="読み取ったテキスト"></textarea>
          <div class="ocr-actions">
            <span class="hint">選択した部分（未選択なら全文）を追加：</span>
            <button type="button" class="btn btn-small" data-ocr-to="title">タイトルへ</button>
            <button type="button" class="btn btn-small" data-ocr-to="ingredients">材料へ</button>
            <button type="button" class="btn btn-small" data-ocr-to="steps">作り方へ</button>
            <button type="button" class="btn btn-small" data-ocr-to="memo">メモへ</button>
          </div>
        </div>
      </section>

      <label class="field">
        <span class="label">料理名</span>
        <input name="title" value="${esc(draft.title)}" placeholder="例：レンジで5分！やみつき無限キャベツ" maxlength="120">
      </label>

      <label class="field">
        <span class="label">元の投稿のURL</span>
        <input name="url" type="url" inputmode="url" value="${esc(draft.url)}" placeholder="https://www.instagram.com/p/..." autocomplete="off">
      </label>

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
        <span class="label">材料 <em>（1行に1つ）</em></span>
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
  const fileInput = $('#file');
  const drop = $('#drop');
  let processing = 0;

  const drawPreviews = () => {
    $('#previews').innerHTML = images
      .map(
        (im, i) => `
        <figure class="preview">
          <img src="${blobUrl(im.thumb)}" alt="写真${i + 1}">
          ${i === 0 ? '<span class="cover">表紙</span>' : `<button type="button" class="mini" data-cover="${i}" title="表紙にする">表紙に</button>`}
          <button type="button" class="remove" data-remove="${i}" aria-label="写真${i + 1}を削除">×</button>
        </figure>`
      )
      .join('') + (processing ? `<div class="preview loading" aria-label="処理中"><span class="spinner"></span></div>` : '');
    $('#ocrRow').hidden = images.length === 0;
  };

  const addFiles = async (files) => {
    const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
    if (!list.length) return;
    processing += list.length;
    drawPreviews();
    for (const f of list) {
      try {
        images.push(await processImage(f));
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
    addFiles(fileInput.files);
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
    addFiles(e.dataTransfer.files);
  });
  const onPaste = (e) => {
    if (!document.body.contains(form)) return document.removeEventListener('paste', onPaste);
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
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
  const urlInput = form.elements.url;
  const setSource = (s) => {
    draft.source = s;
    $$('#sourceChips .chip').forEach((c) => {
      c.classList.toggle('on', c.dataset.source === s);
      c.setAttribute('aria-checked', c.dataset.source === s);
    });
  };
  urlInput.addEventListener('input', () => {
    const s = detectSource(urlInput.value.trim());
    if (s) setSource(s);
  });
  $('#sourceChips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-source]');
    if (c) setSource(draft.source === c.dataset.source ? '' : c.dataset.source);
  });

  $('#tagSuggest')?.addEventListener('click', (e) => {
    const c = e.target.closest('[data-addtag]');
    if (!c) return;
    const input = $('#tagsInput');
    const tags = parseTags(input.value);
    if (!tags.includes(c.dataset.addtag)) tags.push(c.dataset.addtag);
    input.value = tags.join(' ');
  });

  // 文字読み取り
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
        images.map((im) => im.full),
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
  $('#ocrResult').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ocr-to]');
    if (!b) return;
    const ta = $('#ocrText');
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim() || ta.value.trim();
    if (!sel) return;
    const field = form.elements[b.dataset.ocrTo];
    if (b.dataset.ocrTo === 'title') field.value = sel.split('\n')[0].slice(0, 120);
    else field.value = field.value ? `${field.value.replace(/\s+$/, '')}\n${sel}` : sel;
    field.focus();
    toast('追加しました');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (processing) return toast('写真を処理中です。少しお待ちください');
    const f = form.elements;
    const title = f.title.value.trim();
    if (!images.length && !title) {
      toast('写真か料理名のどちらかを入れてください');
      return;
    }
    const url = safeUrl(f.url.value.trim());
    if (f.url.value.trim() && !url) return toast('URLの形式が正しくありません');
    const now = Date.now();
    const saved = {
      ...(recipe || { id: uid(), createdAt: now, favorite: false, cookedCount: 0, lastCookedAt: null }),
      title: title || `${formatDate(now)} のレシピ`,
      url,
      source: draft.source || detectSource(url) || '',
      author: f.author.value.trim(),
      tags: parseTags(f.tags.value),
      ingredients: f.ingredients.value.trim(),
      steps: f.steps.value.trim(),
      memo: f.memo.value.trim(),
      images,
      updatedAt: now,
    };
    $('#saveBtn').disabled = true;
    try {
      await db.put(saved);
      toast(isNew ? '保存しました' : '更新しました');
      go(`#/r/${saved.id}`);
    } catch (err) {
      console.error(err);
      toast(`保存できませんでした：${err.message}`, 5000);
      $('#saveBtn').disabled = false;
    }
  });

  if (isNew && !images.length) form.elements.title.blur();
}

// ---------- 詳細 ----------

function lines(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function renderDetail(r) {
  const url = safeUrl(r.url);
  const ingredients = lines(r.ingredients);
  const steps = lines(r.steps).map((s) => s.replace(/^(?:\d+\s*[.)．、:：]|[①-⑳]|step\s*\d+[.:：]?)\s*/i, ''));

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
            ? `<section class="block"><h2>材料</h2><ul class="checklist">${ingredients
                .map((l, i) => `<li><label><input type="checkbox" id="ing${i}"><span>${esc(l)}</span></label></li>`)
                .join('')}</ul></section>`
            : ''
        }
        ${steps.length ? `<section class="block"><h2>作り方</h2><ol class="steps">${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></section>` : ''}
        ${r.memo ? `<section class="block"><h2>メモ</h2><p class="memo">${esc(r.memo)}</p></section>` : ''}
        ${
          !ingredients.length && !steps.length && !r.memo
            ? `<p class="hint">材料や作り方を書いておくと、検索で見つけやすくなります。<a href="#/r/${esc(r.id)}/edit">追加する</a></p>`
            : ''
        }

        <div class="detail-foot">
          <a class="btn" href="#/r/${esc(r.id)}/edit">編集</a>
          <button type="button" class="btn btn-danger" id="delBtn">削除</button>
        </div>
      </div>
    </article>
    <dialog id="zoom" class="zoom"><form method="dialog"><button aria-label="閉じる">×</button></form><img alt=""></dialog>`;

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
