import { BufferJSON, initAuthCreds, WAProto } from 'baileys';
import type {
  AuthenticationCreds,
  SignalKeyStore,
  SignalDataSet,
  SignalDataTypeMap,
} from 'baileys';
import { assertType, SQLiteStore, toError } from './utils/index.js';
import { join, isAbsolute, resolve } from 'node:path';

/**
 * High-performance database-driven authentication manager for Baileys.
 * Serializes and stores standard session credentials (`creds`) and E2EE token keys of various types.
 * Uses a custom SQLite database driver instead of multi-file JSON storage.
 */
export class Auth {
  #decoder = new TextDecoder('utf-8');
  #encoder = new TextEncoder();
  #store: SQLiteStore;
  #creds?: AuthenticationCreds;
  #keys?: SignalKeyStore;
  #loaded = false;
  #loading = false;
  constructor(path: string) {
    assertType(path, 'path', 'string');
    const filepath = join(isAbsolute(path) ? path : resolve(path), 'auth.db');
    this.#store = new SQLiteStore(filepath);
  }
  /** Gets the primary {@link AuthenticationCreds} object */
  get creds() {
    if (!this.#creds) {
      throw new Error('unloaded, calling .load() first');
    }
    return this.#creds;
  }
  /** Gets the active pre-key crypto store interface required for End-to-End Encryption tracking */
  get keys() {
    if (!this.#keys) {
      throw new Error('unloaded, calling .load() first');
    }
    return this.#keys;
  }
  /**
   * Gets the stored value of a key.
   * Leverages {@link BufferJSON.reviver} to safely reconstruct native Buffer/Uint8Array instances.
   */
  get<T>(key: string) {
    assertType(key, 'key', 'string');
    const arr = this.#store.get(key);
    if (!(arr instanceof Uint8Array)) {
      return undefined;
    }
    const str = this.#decoder.decode(arr);
    return JSON.parse(str, BufferJSON.reviver) as T;
  }
  /**
   * Insert a key and its value into the store.
   * Leverages {@link BufferJSON.replacer} to safely serialize native Buffer data blobs.
   */
  set(key: string, value: object | string) {
    assertType(key, 'key', 'string');
    const str = JSON.stringify(value, BufferJSON.replacer);
    const arr = this.#encoder.encode(str);
    this.#store.set(key, arr);
  }
  /** Deletes the stored value of a key from the store */
  del(key: string) {
    assertType(key, 'key', 'string');
    this.#store.del(key);
  }
  /** Load the authentication credentials and signal keys, or initialize them if they do not exist */
  load() {
    try {
      if (this.#loaded || this.#loading) {
        return;
      }
      this.#loading = true;
      this.#store.initialize();
      this.#creds = this.get('creds') || initAuthCreds();
      this.#keys = {
        get: (type, ids) => {
          const data: Record<string, SignalDataTypeMap[typeof type]> = {};
          ids.forEach((i) => {
            const key = `${type}:${i}`;
            let value = this.get(key);
            if (type === 'app-state-sync-key' && value) {
              value = WAProto.Message.AppStateSyncKeyData.create(value);
            }
            data[i] = value as SignalDataTypeMap[typeof type];
          });
          return data;
        },
        set: (data) => {
          this.#store.transaction(() => {
            (Object.keys(data) as (keyof SignalDataSet)[]).forEach((t) => {
              Object.keys(data[t] || {}).forEach((i) => {
                const key = `${t}:${i}`;
                const value = data[t]?.[i];
                value ? this.set(key, value) : this.del(key);
              });
            });
          })();
        },
      };
      this.#loaded = true;
    } catch (e) {
      this.#loaded = false;
      throw toError(e);
    } finally {
      this.#loading = false;
    }
  }
  /** Removes authentication credentials and signal keys */
  drop() {
    this.#store.drop();
    this.#creds = undefined;
    this.#keys = undefined;
    this.#loaded = false;
  }
  /** Save the authentication credentials */
  save() {
    this.set('creds', this.creds);
  }
  /** Close the authentication without deleting the authentication credentials and signal keys */
  close() {
    this.#store.close();
    this.#creds = undefined;
    this.#keys = undefined;
    this.#loaded = false;
  }
}
