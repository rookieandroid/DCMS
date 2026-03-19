"use strict";

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

module.exports = {
  createPlayer,
  deletePlayer,
  getPlayer,
  listPlayers,
  sanitizePlayer,
  updatePlayer
};
