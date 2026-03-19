"use strict";

const { nowIso, randomToken } = require("../lib/utils");

const ADMIN_PASSWORD = process.env.DCMS_ADMIN_PASSWORD || "dcms-admin";

function createSession(db, session) {
  const token = randomToken(32);
  const record = {
    token,
    ...session,
    createdAt: nowIso()
  };
  db.sessions = (db.sessions || []).filter((item) => item.token !== token);
  db.sessions.push(record);
  return record;
}

function login(db, input) {
  const type = String(input.type || "").trim();
  if (type === "admin") {
    if (String(input.password || "") !== ADMIN_PASSWORD) {
      throw new Error("管理员口令错误。");
    }
    const session = createSession(db, { role: "admin" });
    return {
      token: session.token,
      auth: { role: "admin" }
    };
  }

  if (type === "player") {
    const playerId = String(input.playerId || "").trim();
    const player = db.players.find((item) => item.id === playerId);
    if (!player) {
      throw new Error("数字 ID 不存在。");
    }
    const session = createSession(db, { role: "player", playerId });
    return {
      token: session.token,
      auth: {
        role: "player",
        playerId
      }
    };
  }

  throw new Error("不支持的登录类型。");
}

function getAuth(db, token) {
  if (!token) {
    return { role: "guest" };
  }
  const session = (db.sessions || []).find((item) => item.token === token);
  if (!session) {
    return { role: "guest" };
  }
  if (session.role === "admin") {
    return { role: "admin" };
  }
  return {
    role: "player",
    playerId: session.playerId
  };
}

module.exports = {
  getAuth,
  login
};
