"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { nowIso } = require("./utils");

const auditPath = path.join(__dirname, "..", "..", "data", "audit.log");

async function appendAuditLog(entry) {
  const line = JSON.stringify({
    createdAt: nowIso(),
    ...entry
  });
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  await fs.appendFile(auditPath, `${line}\n`, "utf8");
}

module.exports = {
  appendAuditLog,
  auditPath
};
