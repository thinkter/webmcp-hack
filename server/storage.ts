/**
 * SQLite storage and persistence layer for RoomDurableObject.
 */

import * as Y from 'yjs'

export class RoomStorage {
  private readonly storage: DurableObjectStorage
  private isInitialized = false

  constructor(storage: DurableObjectStorage) {
    this.storage = storage
  }

  async init(): Promise<void> {
    if (this.isInitialized) return
    this.isInitialized = true

    if (this.storage.sql) {
      this.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS yjs_document (
          id INTEGER PRIMARY KEY,
          data BLOB NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
    }
  }

  async loadDocument(doc: Y.Doc): Promise<boolean> {
    await this.init()

    if (this.storage.sql) {
      try {
        const row = this.storage.sql
          .exec<{ data: ArrayBuffer }>('SELECT data FROM yjs_document WHERE id = 1')
          .one()
        if (row?.data) {
          Y.applyUpdate(doc, new Uint8Array(row.data))
          return true
        }
      } catch {
        // Table may be empty
      }
    } else {
      const data = await this.storage.get<Uint8Array>('yjs:doc')
      if (data) {
        Y.applyUpdate(doc, data)
        return true
      }
    }
    return false
  }

  async saveDocument(doc: Y.Doc): Promise<void> {
    await this.init()
    const update = Y.encodeStateAsUpdate(doc)

    if (this.storage.sql) {
      this.storage.sql.exec(
        `INSERT INTO yjs_document (id, data, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        update,
        Date.now(),
      )
    } else {
      await this.storage.put('yjs:doc', update)
    }
  }
}
