"use strict";

const XLSX = require("xlsx");
const { nowIso } = require("../lib/utils");

function sanitizePlayer(player, auth) {
  if (!player) {
    return null;
  }

  const base = {
    id: player.id,
    displayName: player.displayName,
    mmr: player.mmr,
    power: player.power,
    positions: player.positions,
    intro: player.intro,
    championships: player.championships,
    avatar: player.avatar,
    isPublic: player.isPublic
  };

  if (auth?.role === "admin" || auth?.playerId === player.id) {
    return {
      ...base,
      wechatName: player.wechatName,
      createdAt: player.createdAt,
      updatedAt: player.updatedAt
    };
  }

  return base;
}

function applyFilters(players, query = {}) {
  const keyword = String(query.keyword || "").trim().toLowerCase();
  const position = String(query.position || "").trim();
  const sort = query.sort === "powerAsc" ? "powerAsc" : "powerDesc";

  let result = [...players];
  if (keyword) {
    result = result.filter((player) => {
      return [player.id, player.displayName, player.wechatName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword));
    });
  }
  if (position) {
    result = result.filter((player) => player.positions.includes(position));
  }

  result.sort((a, b) => {
    if (sort === "powerAsc") {
      if (a.power !== b.power) {
        return a.power - b.power;
      }
      return String(a.id).localeCompare(String(b.id));
    }

    if (b.power !== a.power) {
      return b.power - a.power;
    }
    return String(a.id).localeCompare(String(b.id));
  });

  return result;
}

function listPlayers(db, auth, query) {
  return applyFilters(db.players, query).map((player) => sanitizePlayer(player, auth));
}

function getPlayer(db, playerId, auth) {
  return sanitizePlayer(db.players.find((player) => player.id === playerId) || null, auth);
}

function assertAdmin(auth) {
  if (auth?.role !== "admin") {
    throw new Error("只有管理员可以执行该操作。");
  }
}

function normalizeImportedPositions(value) {
  const map = {
    "一": "1",
    "二": "2",
    "三": "3",
    "四": "4",
    "五": "5",
    "1": "1",
    "2": "2",
    "3": "3",
    "4": "4",
    "5": "5"
  };

  const raw = String(value || "")
    .replace(/，/g, ",")
    .replace(/、/g, ",")
    .replace(/\//g, ",");
  const result = [];
  for (const part of raw.split(",")) {
    const normalized = map[String(part || "").trim()];
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
}

function validatePlayerInput(input, currentPlayer) {
  const id = String(currentPlayer?.id || input.id || "").trim();
  const displayName = String(input.displayName || "").trim();
  if (!id) {
    throw new Error("数字 ID 不能为空。");
  }
  if (!/^\d+$/.test(id)) {
    throw new Error("数字 ID 需为纯数字。");
  }
  if (!displayName) {
    throw new Error("游戏昵称不能为空。");
  }

  const power = Number(input.power);
  if (!Number.isFinite(power) || power < 0 || power > 100) {
    throw new Error("战力值需在 0 到 100 之间。");
  }

  const mmr = Number(input.mmr || 0);
  const championships = Number(input.championships || 0);
  return {
    id,
    displayName,
    wechatName: String(input.wechatName || "").trim(),
    mmr: Number.isFinite(mmr) ? mmr : 0,
    power,
    positions: Array.isArray(input.positions)
      ? input.positions.map(String).filter(Boolean)
      : String(input.positions || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
    intro: String(input.intro || "").trim(),
    championships: Number.isFinite(championships) ? championships : 0,
    avatar: String(input.avatar || "").trim(),
    isPublic: input.isPublic !== false
  };
}

function createPlayer(db, auth, input) {
  assertAdmin(auth);
  const payload = validatePlayerInput(input);
  if (db.players.some((player) => player.id === payload.id)) {
    throw new Error("数字 ID 已存在。");
  }

  const timestamp = nowIso();
  const player = {
    ...payload,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  db.players.push(player);
  return sanitizePlayer(player, auth);
}

function updatePlayer(db, auth, playerId, input) {
  assertAdmin(auth);
  const player = db.players.find((item) => item.id === playerId);
  if (!player) {
    throw new Error("玩家不存在。");
  }
  if (input.id && String(input.id) !== player.id) {
    throw new Error("数字 ID 创建后不可修改。");
  }

  const payload = validatePlayerInput({ ...player, ...input }, player);
  Object.assign(player, payload, { updatedAt: nowIso() });
  return sanitizePlayer(player, auth);
}

function deletePlayer(db, auth, playerId) {
  assertAdmin(auth);
  const index = db.players.findIndex((player) => player.id === playerId);
  if (index === -1) {
    throw new Error("玩家不存在。");
  }
  const inUse = db.events.some((event) => event.signupIds.includes(playerId) || event.captainIds.includes(playerId));
  if (inUse) {
    throw new Error("该玩家已参与赛事流程，暂不可删除。");
  }
  db.players.splice(index, 1);
  return { ok: true };
}

function importPlayersFromWorkbook(db, auth, input) {
  assertAdmin(auth);

  const contentBase64 = String(input.contentBase64 || "").trim();
  if (!contentBase64) {
    throw new Error("请先选择需要导入的 Excel 文件。");
  }

  const sheetName = String(input.sheetName || "S2名单").trim() || "S2名单";
  const workbook = XLSX.read(Buffer.from(contentBase64, "base64"), { type: "buffer" });
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) {
    throw new Error(`未找到工作表：${sheetName}`);
  }

  const rows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: ""
  });
  if (rows.length < 2) {
    throw new Error("工作表中没有可导入的数据。");
  }

  const importedAt = nowIso();
  const deduped = new Map();
  for (const row of rows.slice(1)) {
    const displayName = String(row[1] || "").trim();
    const steamId = String(row[2] || "").trim();
    if (!/^\d+$/.test(steamId)) {
      continue;
    }
    const intro = String(row[7] || "").trim();
    deduped.set(steamId, {
      id: steamId,
      displayName: displayName || steamId,
      wechatName: displayName,
      mmr: Number(row[4] || 0),
      power: Math.max(0, Math.min(100, Number(row[3] || 0))),
      positions: normalizeImportedPositions(row[5]),
      championships: Number(row[6] || 0),
      intro: intro === "0" ? "" : intro,
      avatar: "",
      isPublic: true
    });
  }

  if (!deduped.size) {
    throw new Error("没有解析到有效玩家数据，请检查 sheet 内容。");
  }

  let created = 0;
  let updated = 0;
  const importedPlayers = [];
  for (const payload of deduped.values()) {
    const existing = db.players.find((player) => player.id === payload.id);
    if (existing) {
      const createdAt = existing.createdAt || importedAt;
      Object.assign(existing, payload, {
        createdAt,
        updatedAt: importedAt
      });
      updated += 1;
      importedPlayers.push(sanitizePlayer(existing, auth));
      continue;
    }

    const player = {
      ...payload,
      createdAt: importedAt,
      updatedAt: importedAt
    };
    db.players.push(player);
    created += 1;
    importedPlayers.push(sanitizePlayer(player, auth));
  }

  return {
    sheetName,
    importedCount: deduped.size,
    created,
    updated,
    players: importedPlayers
  };
}

module.exports = {
  createPlayer,
  deletePlayer,
  getPlayer,
  importPlayersFromWorkbook,
  listPlayers,
  sanitizePlayer,
  updatePlayer
};
