"use strict";

const { makeId, nowIso } = require("../lib/utils");

function assertAdmin(auth) {
  if (auth?.role !== "admin") {
    throw new Error("只有管理员可以执行该操作。");
  }
}

function toEventSummary(db, event, auth, options = {}) {
  const playerMap = Object.fromEntries(db.players.map((player) => [player.id, player]));
  const inhouse = db.inhouseSessions.find((item) => item.eventId === event.id) || null;
  const showPrivate = auth?.role === "admin";
  return {
    id: event.id,
    name: event.name,
    startTime: event.startTime,
    status: event.status,
    enableAuction: event.enableAuction,
    enableInhouse: event.enableInhouse,
    teamSize: event.teamSize,
    signupOpen: event.signupOpen,
    signupCount: event.signupIds.length,
    signupIds: showPrivate ? event.signupIds : undefined,
    captainIds: event.captainIds,
    captains: event.captainIds.map((id) => playerMap[id]).filter(Boolean).map((player) => ({
      id: player.id,
      displayName: player.displayName,
      power: player.power
    })),
    signedUp: auth?.playerId ? event.signupIds.includes(auth.playerId) : false,
    inhouseSessionId: inhouse?.id || null,
    inhouseStatus: inhouse?.status || null,
    createdAt: options.includeMeta ? event.createdAt : undefined,
    updatedAt: options.includeMeta ? event.updatedAt : undefined
  };
}

function listEvents(db, auth) {
  return [...db.events]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((event) => toEventSummary(db, event, auth));
}

function createEvent(db, auth, input) {
  assertAdmin(auth);
  const name = String(input.name || "").trim();
  if (!name) {
    throw new Error("赛事名称不能为空。");
  }
  const startTime = String(input.startTime || "").trim() || nowIso();
  const createdAt = nowIso();
  const event = {
    id: makeId("event"),
    name,
    startTime,
    status: "open",
    enableAuction: input.enableAuction !== false,
    enableInhouse: input.enableInhouse !== false,
    teamSize: Math.max(2, Number(input.teamSize || 5)),
    signupOpen: input.signupOpen !== false,
    signupIds: [],
    captainIds: [],
    createdAt,
    updatedAt: createdAt
  };
  db.events.push(event);
  return toEventSummary(db, event, auth, { includeMeta: true });
}

function updateEvent(db, auth, eventId, input) {
  assertAdmin(auth);
  const event = db.events.find((item) => item.id === eventId);
  if (!event) {
    throw new Error("赛事不存在。");
  }
  if (typeof input.signupOpen === "boolean") {
    event.signupOpen = input.signupOpen;
  }
  if (input.status) {
    event.status = String(input.status);
  }
  event.updatedAt = nowIso();
  return toEventSummary(db, event, auth, { includeMeta: true });
}

function deleteEvent(db, auth, eventId) {
  assertAdmin(auth);
  const index = db.events.findIndex((item) => item.id === eventId);
  if (index === -1) {
    throw new Error("赛事不存在。");
  }
  db.events.splice(index, 1);
  db.inhouseSessions = db.inhouseSessions.filter((session) => session.eventId !== eventId);
  db.auctionRooms = db.auctionRooms.filter((auction) => auction.eventId !== eventId);
  return { ok: true };
}

function signupForEvent(db, auth, eventId, action, targetPlayerId) {
  const event = db.events.find((item) => item.id === eventId);
  if (!event) {
    throw new Error("赛事不存在。");
  }
  if (!event.signupOpen) {
    throw new Error("当前赛事未开放报名。");
  }

  const playerId =
    auth?.role === "admin" && targetPlayerId
      ? String(targetPlayerId)
      : auth?.role === "player" && auth.playerId
        ? auth.playerId
        : "";
  if (!playerId) {
    throw new Error("只有玩家本人或管理员可以操作报名。");
  }
  if (!db.players.some((player) => player.id === playerId)) {
    throw new Error("目标玩家不存在。");
  }

  const exists = event.signupIds.includes(playerId);
  if (action === "cancel") {
    if (!exists) {
      throw new Error("目标玩家尚未报名该赛事。");
    }
    event.signupIds = event.signupIds.filter((id) => id !== playerId);
    event.captainIds = event.captainIds.filter((id) => id !== playerId);
    event.updatedAt = nowIso();
    return toEventSummary(db, event, auth, { includeMeta: true });
  }

  if (exists) {
    throw new Error("请勿重复报名。");
  }
  event.signupIds.push(playerId);
  event.updatedAt = nowIso();
  return toEventSummary(db, event, auth, { includeMeta: true });
}

module.exports = {
  assertAdmin,
  createEvent,
  deleteEvent,
  listEvents,
  signupForEvent,
  toEventSummary,
  updateEvent
};
