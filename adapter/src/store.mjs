// adapter/src/store.mjs -- tiny JSON-file store helper.
//
// All adapter state is plain JSON on disk under $AMIRO_HOME:
//   $AMIRO_HOME/users.json            (auth.mjs)
//   $AMIRO_HOME/sessions.json         (auth.mjs)
//   $AMIRO_HOME/threads.json          (threads.mjs)
//   $AMIRO_HOME/store/*.json          (everything else)
//   $AMIRO_HOME/storage/<token>       (uploaded files, worker 2)
//
// Writes are atomic (write to a temp file, then rename) so a crash mid-write
// cannot leave a truncated JSON file. Directory creation is implicit.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export function createStore(home) {
  const storeDir = path.join(home, 'store');

  async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
  }

  // Read a JSON file, returning `fallback` when it is missing or empty.
  async function readJson(file, fallback) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      if (!raw.trim()) return fallback;
      return JSON.parse(raw);
    } catch (err) {
      if (err && err.code === 'ENOENT') return fallback;
      throw err;
    }
  }

  // Atomically write a JSON file (pretty-printed, no trailing-newline games).
  async function writeJson(file, value) {
    await ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(tmp, file);
  }

  // Read-modify-write under a single call. `mutate` may return a new value or
  // mutate in place; returning undefined keeps the (possibly mutated) current.
  async function updateJson(file, fallback, mutate) {
    const current = await readJson(file, fallback);
    const next = await mutate(current);
    const out = next === undefined ? current : next;
    await writeJson(file, out);
    return out;
  }

  return {
    home,
    storeDir,
    ensureDir,
    readJson,
    writeJson,
    updateJson,
    // Convenience bound to $AMIRO_HOME/store/<name>.
    path(name) {
      return path.join(storeDir, name);
    },
    read(name, fallback) {
      return readJson(path.join(storeDir, name), fallback);
    },
    write(name, value) {
      return writeJson(path.join(storeDir, name), value);
    },
    update(name, fallback, mutate) {
      return updateJson(path.join(storeDir, name), fallback, mutate);
    },
  };
}
