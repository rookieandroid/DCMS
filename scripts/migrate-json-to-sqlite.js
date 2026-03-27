"use strict";

const fs = require("node:fs/promises");
const { dbPath, ensureDb, legacyDbPath, saveDb } = require("../src/lib/db");

async function main() {
  await ensureDb();

  const content = await fs.readFile(legacyDbPath, "utf8");
  const snapshot = JSON.parse(content);
  await saveDb(snapshot);

  console.log(`Migrated legacy JSON snapshot from ${legacyDbPath} into ${dbPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
