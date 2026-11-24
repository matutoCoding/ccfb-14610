// IndexedDB 轻封装：版本化仓库，工件/工艺/方案/程序统一存取
import type { PlanScheme, Workpiece, WpsParams } from './types';
import { uid } from './wps';

const DB_NAME = 'weld-offline-db';
const DB_VERSION = 1;

export type StoreName = 'workpieces' | 'wps' | 'schemes' | 'programs' | 'gaps';

const STORES: { name: StoreName; keyPath: string; indexes: Array<[string, string]> }[] = [
  { name: 'workpieces', keyPath: 'id', indexes: [['name', 'name']] },
  { name: 'wps', keyPath: 'id', indexes: [['role', 'role']] },
  { name: 'schemes', keyPath: 'id', indexes: [['seamId', 'seamId'], ['workpieceId', 'workpieceId']] },
  { name: 'programs', keyPath: 'id', indexes: [['schemeId', 'schemeId']] },
  { name: 'gaps', keyPath: 'id', indexes: [['seamId', 'seamId']] },
];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s.name)) {
          const os = db.createObjectStore(s.name, { keyPath: s.keyPath });
          for (const [idx, key] of s.indexes) os.createIndex(idx, key, { unique: false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) => new Promise<T>((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }),
  );
}

export const repo = {
  async put<T>(store: StoreName, value: T): Promise<T> {
    await tx(store, 'readwrite', (os) => os.put(value as unknown as object));
    return value;
  },
  async get<T>(store: StoreName, id: string): Promise<T | undefined> {
    return tx<T | undefined>(store, 'readonly', (os) => os.get(id) as IDBRequest<T | undefined>);
  },
  async all<T>(store: StoreName): Promise<T[]> {
    return tx<T[]>(store, 'readonly', (os) => os.getAll() as IDBRequest<T[]>);
  },
  async delete(store: StoreName, id: string): Promise<void> {
    await tx(store, 'readwrite', (os) => os.delete(id));
  },
  async clear(store: StoreName): Promise<void> {
    await tx(store, 'readwrite', (os) => os.clear());
  },
};

export interface StoredProgram {
  id: string;
  schemeId: string;
  name: string;
  text: string;
  createdAt: number;
}

export interface StoredGapSeries {
  id: string;
  seamId: string;
  name: string;
  stations: { s: number; gap: number }[];
  createdAt: number;
}

export const newId = uid;

export type { Workpiece, WpsParams, PlanScheme };
