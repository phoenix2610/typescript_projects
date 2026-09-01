// IndexedDB Offline Cache Layer
//
// A typed key/value store over IndexedDB with per-entry TTLs (checked and
// lazily cleaned up on read, not on a timer), schema migrations applied
// incrementally (opening a v1 database with a v1+v2 migration list only
// runs the NEW v2 step, leaving existing v1 data untouched), and a
// durable sync queue for writes made while offline — queued in its own
// object store so it survives a reload, replayed later via a caller-
// supplied `send` function, with only the entries that actually failed
// remaining queued for retry.
//
// Usage:
//   const db = await openDatabase('myapp', MIGRATIONS);
//   const cache = new TypedStore<string>(db, 'cache');
//   await cache.set('token', 'abc', 60_000); // expires in 60s
//   const queue = new SyncQueue(db);
//   await queue.enqueue('note:1', { text: 'hi' });
//   await queue.flush(async (item) => sendToServer(item));

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export interface Migration {
  version: number;
  migrate: (db: IDBDatabase, tx: IDBTransaction) => void;
}

export function openDatabase(name: string, migrations: Migration[]): Promise<IDBDatabase> {
  const targetVersion = Math.max(...migrations.map((m) => m.version));
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, targetVersion);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction!;
      const fromVersion = event.oldVersion;
      for (const m of migrations) {
        if (m.version > fromVersion) m.migrate(db, tx);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number | null;
}

export class TypedStore<T> {
  constructor(private db: IDBDatabase, private storeName: string) {}

  async set(key: string, value: T, ttlMs?: number): Promise<void> {
    const entry: CacheEntry<T> = { value, expiresAt: ttlMs != null ? Date.now() + ttlMs : null };
    const tx = this.db.transaction(this.storeName, 'readwrite');
    tx.objectStore(this.storeName).put(entry, key);
    await txDone(tx);
  }

  async get(key: string): Promise<T | undefined> {
    const readTx = this.db.transaction(this.storeName, 'readonly');
    const entry = await idbRequest<CacheEntry<T> | undefined>(readTx.objectStore(this.storeName).get(key));
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      const delTx = this.db.transaction(this.storeName, 'readwrite');
      delTx.objectStore(this.storeName).delete(key);
      await txDone(delTx);
      return undefined;
    }
    return entry.value;
  }

  async delete(key: string): Promise<void> {
    const tx = this.db.transaction(this.storeName, 'readwrite');
    tx.objectStore(this.storeName).delete(key);
    await txDone(tx);
  }

  async keys(): Promise<string[]> {
    const tx = this.db.transaction(this.storeName, 'readonly');
    return idbRequest(tx.objectStore(this.storeName).getAllKeys() as IDBRequest<string[]>);
  }
}

export interface QueueItem {
  id: number;
  key: string;
  value: unknown;
  timestamp: number;
}

export class SyncQueue {
  constructor(private db: IDBDatabase, private storeName = 'syncQueue') {}

  async enqueue(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction(this.storeName, 'readwrite');
    tx.objectStore(this.storeName).add({ key, value, timestamp: Date.now() });
    await txDone(tx);
  }

  async pending(): Promise<QueueItem[]> {
    const tx = this.db.transaction(this.storeName, 'readonly');
    return idbRequest(tx.objectStore(this.storeName).getAll() as IDBRequest<QueueItem[]>);
  }

  async flush(send: (item: QueueItem) => Promise<boolean>): Promise<{ succeeded: number; failed: number }> {
    const items = await this.pending();
    let succeeded = 0;
    let failed = 0;
    for (const item of items) {
      const ok = await send(item).catch(() => false);
      if (ok) {
        const tx = this.db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).delete(item.id);
        await txDone(tx);
        succeeded++;
      } else {
        failed++;
      }
    }
    return { succeeded, failed };
  }
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    migrate: (db) => {
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache');
    },
  },
  {
    version: 2,
    migrate: (db) => {
      if (!db.objectStoreNames.contains('syncQueue')) {
        const store = db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
        store.createIndex('by-timestamp', 'timestamp');
      }
    },
  },
];

// ---- Demo -----------------------------------------------------------------

export function mount(root: HTMLElement) {
  root.innerHTML = '';
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '16px';
  root.style.maxWidth = '360px';

  const status = document.createElement('div');
  status.setAttribute('data-testid', 'status');
  status.style.fontSize = '13px';
  status.style.marginBottom = '8px';
  status.textContent = 'Opening database…';
  root.appendChild(status);

  openDatabase('offline-cache-demo', MIGRATIONS).then((db) => {
    const cache = new TypedStore<string>(db, 'cache');
    const queue = new SyncQueue(db, 'syncQueue');

    status.textContent = 'Database ready.';

    const offlineToggle = document.createElement('label');
    offlineToggle.style.display = 'block';
    offlineToggle.style.fontSize = '13px';
    offlineToggle.style.marginBottom = '8px';
    offlineToggle.innerHTML = '<input type="checkbox" data-testid="offline-toggle" /> Simulate offline (sync fails)';

    const writeBtn = document.createElement('button');
    writeBtn.textContent = 'Write a note (queued for sync)';
    writeBtn.setAttribute('data-testid', 'write-btn');

    const syncBtn = document.createElement('button');
    syncBtn.textContent = 'Sync now';
    syncBtn.setAttribute('data-testid', 'sync-btn');
    syncBtn.style.marginLeft = '6px';

    const queueStatus = document.createElement('div');
    queueStatus.setAttribute('data-testid', 'queue-status');
    queueStatus.style.fontSize = '12px';
    queueStatus.style.marginTop = '8px';

    let noteCount = 0;
    async function refreshQueueStatus() {
      const pending = await queue.pending();
      queueStatus.textContent = `${pending.length} item(s) waiting to sync`;
    }

    writeBtn.addEventListener('click', async () => {
      noteCount++;
      await queue.enqueue(`note:${noteCount}`, { text: `Note ${noteCount}` });
      await refreshQueueStatus();
    });

    syncBtn.addEventListener('click', async () => {
      const offline = (offlineToggle.querySelector('input') as HTMLInputElement).checked;
      const result = await queue.flush(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return !offline;
      });
      queueStatus.textContent = `Synced ${result.succeeded}, failed ${result.failed}`;
      await refreshQueueStatus();
    });

    root.appendChild(offlineToggle);
    root.appendChild(writeBtn);
    root.appendChild(syncBtn);
    root.appendChild(queueStatus);
    void refreshQueueStatus();
  });
}

export default mount;
