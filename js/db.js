// IndexedDB による端末内保存。sw.js にも同じスキーマ定義があるので、変更時は両方そろえること。
export const DB_NAME = 'buzz-recipes';
export const DB_VERSION = 1;
const RECIPES = 'recipes';
const INBOX = 'inbox'; // 他アプリからの「共有」で受け取ったデータの一時置き場

let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECIPES)) {
        const store = db.createObjectStore(RECIPES, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(INBOX)) db.createObjectStore(INBOX, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('保存が中断されました（容量不足の可能性があります）'));
  });
}

export const getAll = () => tx(RECIPES, 'readonly', (s) => s.getAll());
export const get = (id) => tx(RECIPES, 'readonly', (s) => s.get(id));
export const put = (recipe) => tx(RECIPES, 'readwrite', (s) => s.put(recipe));
export const remove = (id) => tx(RECIPES, 'readwrite', (s) => s.delete(id));

export async function takeInbox() {
  const item = await tx(INBOX, 'readonly', (s) => s.get('shared'));
  if (item) await tx(INBOX, 'readwrite', (s) => s.delete('shared'));
  return item;
}
