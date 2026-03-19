"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createSeedData } = require("../seed");
const { clone } = require("./utils");

const dataDir = path.join(__dirname, "..", "..", "data");
const dbPath = path.join(dataDir, "dcms-db.json");

let writeChain = Promise.resolve();

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

async function ensureDb() {
  await ensureDataDir();
  try {
    await fs.access(dbPath);
  } catch {
    const seed = createSeedData();
    await fs.writeFile(dbPath, JSON.stringify(seed, null, 2), "utf8");
  }
}

async function loadDb() {
  await ensureDb();
  const content = await fs.readFile(dbPath, "utf8");
  return JSON.parse(content);
}

async function saveDb(db) {
  await ensureDataDir();
  writeChain = writeChain.then(() => fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8"));
  return writeChain;
}

async function mutateDb(mutator) {
  const db = await loadDb();
  const result = await mutator(db);
  await saveDb(db);
  return result;
}

async function resetDb(db) {
  await saveDb(clone(db));
}

module.exports = {
  dbPath,
  ensureDb,
  loadDb,
  mutateDb,
  resetDb,
  saveDb
};
