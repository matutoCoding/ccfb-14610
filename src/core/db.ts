// ============================================================
// IndexedDB 持久化:工件 / WPS / 排道方案 / 程序 / 机器人 / 变位机
// 轻量 Promise 封装,单库多 store,带版本升级
// ============================================================

import type { DBShape, StoreName } from './types';

const DB_NAME = 'weld-offline-db';
const DB_VERSION = 1;
const STORES: StoreName[] = ['workpieces', 'wps', 'plans', 'programs', 'robots', 'positioners'];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function putRecord<K extends StoreName>(store: K, record: DBShape[K]): Promise<void> {
  await tx(store, 'readwrite', (s) => s.put(record as any));
}
export async function getRecord<K extends StoreName>(store: K, id: string): Promise<DBShape[K] | undefined> {
  return tx(store, 'readonly', (s) => s.get(id) as IDBRequest<DBShape[K] | undefined>);
}
export async function deleteRecord(store: StoreName, id: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.delete(id));
}
export async function listRecords<K extends StoreName>(store: K): Promise<DBShape[K][]> {
  return tx(store, 'readonly', (s) => s.getAll() as IDBRequest<DBShape[K][]>);
}
export async function clearStore(store: StoreName): Promise<void> {
  await tx(store, 'readwrite', (s) => s.clear());
}

export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
