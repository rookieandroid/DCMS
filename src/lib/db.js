"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createSeedData } = require("../seed");
const { getAuth } = require("../services/auth");
const {
  bid,
  pauseAuction,
  serializeAuction,
  settleExpiredAuctions,
  startAuction
} = require("../services/auctions");
const { signupForEvent } = require("../services/events");
const { getSessionForEvent, makePick } = require("../services/inhouse");
const { clone } = require("./utils");

const dataDir = process.env.DCMS_DATA_DIR
  ? path.resolve(process.env.DCMS_DATA_DIR)
  : path.join(__dirname, "..", "..", "data");
const dbPath = process.env.DCMS_DB_PATH
  ? path.resolve(process.env.DCMS_DB_PATH)
  : path.join(dataDir, "dcms.sqlite");
const legacyDbPath = path.join(dataDir, "dcms-db.json");

const collectionConfigs = [
  { table: "users", getKey: (_, index) => `user_${index}` },
  { table: "sessions", getKey: (item, index) => item?.token || `session_${index}` },
  { table: "players", getKey: (item, index) => item?.id || `player_${index}` },
  { table: "events", getKey: (item, index) => item?.id || `event_${index}` },
  { table: "inhouse_sessions", field: "inhouseSessions", getKey: (item, index) => item?.id || `inhouse_${index}` },
  { table: "auction_rooms", field: "auctionRooms", getKey: (item, index) => item?.id || `auction_${index}` }
];
const collectionConfigMap = new Map(collectionConfigs.map((config) => [getFieldName(config), config]));

let dbOperationChain = Promise.resolve();
let ensureDbPromise = null;
let sqlite = null;

function queueDbOperation(operation) {
  const run = dbOperationChain.then(operation);
  dbOperationChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function getFieldName(config) {
  return config.field || config.table;
}

function getCollectionConfig(fieldName) {
  const config = collectionConfigMap.get(fieldName);
  if (!config) {
    throw new Error(`Unknown collection: ${fieldName}`);
  }
  return config;
}

function normalizeSnapshot(snapshot = {}) {
  return {
    meta: snapshot.meta || {},
    users: Array.isArray(snapshot.users) ? snapshot.users : [],
    sessions: Array.isArray(snapshot.sessions) ? snapshot.sessions : [],
    players: Array.isArray(snapshot.players) ? snapshot.players : [],
    events: Array.isArray(snapshot.events) ? snapshot.events : [],
    inhouseSessions: Array.isArray(snapshot.inhouseSessions) ? snapshot.inhouseSessions : [],
    auctionRooms: Array.isArray(snapshot.auctionRooms) ? snapshot.auctionRooms : []
  };
}

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

function getDatabase() {
  if (sqlite) {
    return sqlite;
  }

  sqlite = new DatabaseSync(dbPath);
  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  for (const config of collectionConfigs) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS ${config.table} (
        entry_key TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${config.table}_position
      ON ${config.table}(position);
    `);
  }

  return sqlite;
}

function isDatabaseSeeded(database) {
  const row = database.prepare("SELECT value FROM meta_state WHERE key = ?").get("meta");
  return Boolean(row);
}

async function readLegacySnapshot() {
  try {
    const content = await fs.readFile(legacyDbPath, "utf8");
    return JSON.parse(content);
  } catch {
    return createSeedData();
  }
}

function runInTransaction(database, operation) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function writeCollection(database, config, items) {
  database.prepare(`DELETE FROM ${config.table}`).run();
  const insert = database.prepare(`
    INSERT INTO ${config.table} (entry_key, position, data)
    VALUES (?, ?, ?)
  `);

  items.forEach((item, index) => {
    insert.run(config.getKey(item, index), index, JSON.stringify(item));
  });
}

function collectionSignature(items) {
  return JSON.stringify(items);
}

function writeSnapshotSync(database, snapshot, previousSnapshot = null) {
  const normalized = normalizeSnapshot(snapshot);
  const previous = previousSnapshot ? normalizeSnapshot(previousSnapshot) : null;
  const metaChanged = !previous || JSON.stringify(previous.meta) !== JSON.stringify(normalized.meta);

  runInTransaction(database, () => {
    if (metaChanged) {
      database.prepare(`
        INSERT INTO meta_state (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run("meta", JSON.stringify(normalized.meta));
    }

    for (const config of collectionConfigs) {
      const fieldName = getFieldName(config);
      const changed =
        !previous ||
        collectionSignature(previous[fieldName]) !== collectionSignature(normalized[fieldName]);
      if (changed) {
        writeCollection(database, config, normalized[fieldName]);
      }
    }
  });
}

function readCollection(database, config) {
  const rows = database.prepare(`
    SELECT data
    FROM ${config.table}
    ORDER BY position ASC
  `).all();
  return rows.map((row) => JSON.parse(row.data));
}

function readCollectionRows(database, config) {
  const rows = database.prepare(`
    SELECT entry_key, position, data
    FROM ${config.table}
    ORDER BY position ASC
  `).all();
  return rows.map((row) => ({
    entryKey: row.entry_key,
    position: row.position,
    item: JSON.parse(row.data)
  }));
}

function readEntryRow(database, config, entryKey) {
  const row = database.prepare(`
    SELECT position, data
    FROM ${config.table}
    WHERE entry_key = ?
  `).get(entryKey);
  if (!row) {
    return null;
  }
  return {
    position: row.position,
    item: JSON.parse(row.data)
  };
}

function upsertEntry(database, config, entryKey, item, position = null) {
  const nextPosition = position ?? database.prepare(`
    SELECT COALESCE(MAX(position) + 1, 0) AS next_position
    FROM ${config.table}
  `).get().next_position;

  database.prepare(`
    INSERT INTO ${config.table} (entry_key, position, data)
    VALUES (?, ?, ?)
    ON CONFLICT(entry_key) DO UPDATE SET
      position = excluded.position,
      data = excluded.data
  `).run(entryKey, nextPosition, JSON.stringify(item));
}

function readSnapshotSync(database) {
  const metaRow = database.prepare("SELECT value FROM meta_state WHERE key = ?").get("meta");
  return {
    meta: metaRow ? JSON.parse(metaRow.value) : {},
    users: readCollection(database, collectionConfigs[0]),
    sessions: readCollection(database, collectionConfigs[1]),
    players: readCollection(database, collectionConfigs[2]),
    events: readCollection(database, collectionConfigs[3]),
    inhouseSessions: readCollection(database, collectionConfigs[4]),
    auctionRooms: readCollection(database, collectionConfigs[5])
  };
}

async function seedDatabaseIfNeeded() {
  const database = getDatabase();
  if (isDatabaseSeeded(database)) {
    return;
  }
  const snapshot = await readLegacySnapshot();
  writeSnapshotSync(database, snapshot);
}

async function ensureDb() {
  if (!ensureDbPromise) {
    ensureDbPromise = (async () => {
      await ensureDataDir();
      getDatabase();
      await seedDatabaseIfNeeded();
    })().finally(() => {
      ensureDbPromise = null;
    });
  }
  await ensureDbPromise;
}

async function loadDb() {
  await ensureDb();
  return clone(readSnapshotSync(getDatabase()));
}

async function saveDb(db) {
  return queueDbOperation(async () => {
    await ensureDb();
    const database = getDatabase();
    const nextSnapshot = clone(db);
    const previousSnapshot = readSnapshotSync(database);
    writeSnapshotSync(database, nextSnapshot, previousSnapshot);
  });
}

async function mutateDb(mutator) {
  return queueDbOperation(async () => {
    await ensureDb();
    const database = getDatabase();
    const originalSnapshot = readSnapshotSync(database);
    const workingCopy = clone(originalSnapshot);
    const result = await mutator(workingCopy);
    writeSnapshotSync(database, workingCopy, originalSnapshot);
    return result;
  });
}

async function resetDb(db) {
  await saveDb(clone(db));
}

async function transactEventSignup({ token, eventId, action, targetPlayerId }) {
  return queueDbOperation(async () => {
    await ensureDb();
    const database = getDatabase();
    const eventsConfig = getCollectionConfig("events");

    return runInTransaction(database, () => {
      const sessions = readCollection(database, getCollectionConfig("sessions"));
      const players = readCollection(database, getCollectionConfig("players"));
      const inhouseSessions = readCollection(database, getCollectionConfig("inhouseSessions"));
      const eventRow = readEntryRow(database, eventsConfig, eventId);
      if (!eventRow) {
        throw new Error("赛事不存在。");
      }

      const auth = getAuth({ sessions }, token);
      const workingDb = normalizeSnapshot({
        sessions,
        players,
        events: [eventRow.item],
        inhouseSessions
      });
      const event = signupForEvent(workingDb, auth, eventId, action, targetPlayerId);
      upsertEntry(database, eventsConfig, eventId, workingDb.events[0], eventRow.position);

      return {
        auth,
        event,
        inhouseSession: getSessionForEvent(
          normalizeSnapshot({
            players,
            inhouseSessions
          }),
          eventId
        )
      };
    });
  });
}

async function transactInhousePick({ token, sessionId, playerId }) {
  return queueDbOperation(async () => {
    await ensureDb();
    const database = getDatabase();
    const inhouseConfig = getCollectionConfig("inhouseSessions");

    return runInTransaction(database, () => {
      const sessions = readCollection(database, getCollectionConfig("sessions"));
      const players = readCollection(database, getCollectionConfig("players"));
      const sessionRow = readEntryRow(database, inhouseConfig, sessionId);
      if (!sessionRow) {
        throw new Error("内战选人会话不存在。");
      }

      const auth = getAuth({ sessions }, token);
      const workingDb = normalizeSnapshot({
        sessions,
        players,
        inhouseSessions: [sessionRow.item]
      });
      const inhouseSession = makePick(workingDb, auth, sessionId, playerId);
      upsertEntry(database, inhouseConfig, sessionId, workingDb.inhouseSessions[0], sessionRow.position);

      return {
        auth,
        inhouseSession
      };
    });
  });
}

function loadAuctionWriteContext(database, auctionId) {
  const auctionConfig = getCollectionConfig("auctionRooms");
  const eventsConfig = getCollectionConfig("events");
  const sessions = readCollection(database, getCollectionConfig("sessions"));
  const players = readCollection(database, getCollectionConfig("players"));
  const auctionRow = readEntryRow(database, auctionConfig, auctionId);
  if (!auctionRow) {
    throw new Error("拍卖不存在。");
  }
  const eventRow = readEntryRow(database, eventsConfig, auctionRow.item.eventId);
  if (!eventRow) {
    throw new Error("关联赛事不存在。");
  }
  return {
    auctionConfig,
    auctionRow,
    eventRow,
    players,
    sessions
  };
}

function buildAuctionWorkingDb(context) {
  return normalizeSnapshot({
    sessions: context.sessions,
    players: context.players,
    events: [context.eventRow.item],
    auctionRooms: [context.auctionRow.item]
  });
}

async function transactAuctionWrite({ token, auctionId, executor }) {
  return queueDbOperation(async () => {
    await ensureDb();
    const database = getDatabase();

    return runInTransaction(database, () => {
      const context = loadAuctionWriteContext(database, auctionId);
      const auth = getAuth({ sessions: context.sessions }, token);
      const workingDb = buildAuctionWorkingDb(context);

      executor(workingDb, auth, auctionId);
      upsertEntry(
        database,
        context.auctionConfig,
        auctionId,
        workingDb.auctionRooms[0],
        context.auctionRow.position
      );

      return {
        auth,
        auction: serializeAuction(workingDb, workingDb.auctionRooms[0], auth)
      };
    });
  });
}

async function transactAuctionBid({ token, auctionId, input }) {
  return transactAuctionWrite({
    token,
    auctionId,
    executor(workingDb, auth) {
      bid(workingDb, auth, auctionId, input);
    }
  });
}

async function transactAuctionStateChange({ token, auctionId, action }) {
  const actionMap = {
    pause: pauseAuction,
    start: startAuction
  };
  const handler = actionMap[action];
  if (!handler) {
    throw new Error("不支持的拍卖状态变更操作。");
  }
  return transactAuctionWrite({
    token,
    auctionId,
    executor(workingDb, auth) {
      handler(workingDb, auth, auctionId);
    }
  });
}

async function transactSettleExpiredAuctions() {
  return queueDbOperation(async () => {
    await ensureDb();
    const database = getDatabase();
    const auctionConfig = getCollectionConfig("auctionRooms");
    const eventsConfig = getCollectionConfig("events");

    return runInTransaction(database, () => {
      const players = readCollection(database, getCollectionConfig("players"));
      const auctionRows = readCollectionRows(database, auctionConfig);
      if (!auctionRows.length) {
        return { changed: false, changedAuctionIds: [] };
      }

      const eventIds = [...new Set(auctionRows.map((row) => row.item.eventId).filter(Boolean))];
      const eventRows = eventIds
        .map((eventId) => readEntryRow(database, eventsConfig, eventId))
        .filter(Boolean);
      const beforeByAuctionId = new Map(
        auctionRows.map((row) => [row.item.id, JSON.stringify(row.item)])
      );
      const workingDb = normalizeSnapshot({
        players,
        events: eventRows.map((row) => row.item),
        auctionRooms: auctionRows.map((row) => row.item)
      });
      const changed = settleExpiredAuctions(workingDb);
      if (!changed) {
        return { changed: false, changedAuctionIds: [] };
      }

      const changedAuctionIds = [];
      workingDb.auctionRooms.forEach((auction, index) => {
        const previousSerialized = beforeByAuctionId.get(auction.id);
        const nextSerialized = JSON.stringify(auction);
        if (previousSerialized !== nextSerialized) {
          const originalRow = auctionRows[index];
          upsertEntry(database, auctionConfig, originalRow.entryKey, auction, originalRow.position);
          changedAuctionIds.push(auction.id);
        }
      });

      return {
        changed: changedAuctionIds.length > 0,
        changedAuctionIds
      };
    });
  });
}

module.exports = {
  dbPath,
  ensureDb,
  legacyDbPath,
  loadDb,
  mutateDb,
  resetDb,
  saveDb,
  transactAuctionBid,
  transactAuctionStateChange,
  transactEventSignup,
  transactInhousePick,
  transactSettleExpiredAuctions
};
