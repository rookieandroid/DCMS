"use strict";

const { makeId, nowIso } = require("../lib/utils");
const { sanitizePlayer } = require("./players");

function compareTeams(db, a, b) {
  if (a.totalPower !== b.totalPower) {
    return a.totalPower - b.totalPower;
  }
  const playerMap = Object.fromEntries(db.players.map((player) => [player.id, player]));
  const aCaptain = playerMap[a.captainId];
  const bCaptain = playerMap[b.captainId];
  if (aCaptain.power !== bCaptain.power) {
    return aCaptain.power - bCaptain.power;
  }
  return String(a.captainId).localeCompare(String(b.captainId));
}

function buildRoundQueue(db, session) {
  const incompleteTeams = session.teams.filter((team) => team.memberIds.length < session.teamSize);
  if (session.currentRound === 1) {
    const playerMap = Object.fromEntries(db.players.map((player) => [player.id, player]));
    return [...incompleteTeams]
      .sort((a, b) => {
        if (playerMap[a.captainId].power !== playerMap[b.captainId].power) {
          return playerMap[a.captainId].power - playerMap[b.captainId].power;
        }
        return String(a.captainId).localeCompare(String(b.captainId));
      })
      .map((team) => team.id);
  }
  return [...incompleteTeams].sort((a, b) => compareTeams(db, a, b)).map((team) => team.id);
}

function updateTurn(db, session) {
  const incompleteTeams = session.teams.filter((team) => team.memberIds.length < session.teamSize);
  if (incompleteTeams.length === 0 || session.availablePlayerIds.length === 0) {
    session.status = "completed";
    session.currentTurnTeamId = null;
    session.roundQueue = [];
    return;
  }
  if (!session.roundQueue.length) {
    session.currentRound += 1;
    session.roundQueue = buildRoundQueue(db, session);
  }
  session.currentTurnTeamId = session.roundQueue[0] || null;
}

function serializeSession(db, session, auth) {
  const playerMap = Object.fromEntries(db.players.map((player) => [player.id, player]));
  return {
    id: session.id,
    eventId: session.eventId,
    status: session.status,
    teamSize: session.teamSize,
    currentRound: session.currentRound,
    currentTurnTeamId: session.currentTurnTeamId,
    availablePlayers: session.availablePlayerIds.map((id) => sanitizePlayer(playerMap[id], auth)).filter(Boolean),
    teams: session.teams.map((team) => ({
      id: team.id,
      captainId: team.captainId,
      name: team.name,
      totalPower: team.totalPower,
      members: team.memberIds.map((id) => sanitizePlayer(playerMap[id], auth)).filter(Boolean)
    })),
    pickHistory: session.pickHistory.map((pick) => ({
      ...pick,
      player: sanitizePlayer(playerMap[pick.playerId], auth),
      captain: sanitizePlayer(playerMap[pick.captainId], auth)
    })),
    canPick: null
  };
}

function assignCaptains(db, auth, eventId, captainIds) {
  if (auth?.role !== "admin") {
    throw new Error("只有管理员可以任命队长。");
  }
  const event = db.events.find((item) => item.id === eventId);
  if (!event) {
    throw new Error("赛事不存在。");
  }
  const picked = Array.isArray(captainIds) ? captainIds.map(String) : [];
  if (picked.length < 2) {
    throw new Error("至少需要任命 2 名队长。");
  }
  for (const captainId of picked) {
    if (!event.signupIds.includes(captainId)) {
      throw new Error("只能从已报名玩家中任命队长。");
    }
  }
  event.captainIds = picked;
  event.updatedAt = nowIso();

  const playerMap = Object.fromEntries(db.players.map((player) => [player.id, player]));
  const existing = db.inhouseSessions.find((item) => item.eventId === event.id);
  const createdAt = nowIso();
  const session = existing || {
    id: makeId("inhouse"),
    eventId: event.id,
    createdAt
  };
  session.status = "drafting";
  session.teamSize = event.teamSize;
  session.captainIds = picked;
  session.teams = picked.map((captainId) => ({
    id: captainId,
    captainId,
    name: `${playerMap[captainId].displayName}队`,
    memberIds: [captainId],
    totalPower: playerMap[captainId].power
  }));
  session.availablePlayerIds = event.signupIds.filter((id) => !picked.includes(id));
  session.pickHistory = [];
  session.currentRound = 0;
  session.roundQueue = [];
  session.currentTurnTeamId = null;
  session.updatedAt = createdAt;
  updateTurn(db, session);

  if (!existing) {
    db.inhouseSessions.push(session);
  }
  return serializeSession(db, session, auth);
}

function getSessionById(db, sessionId) {
  const session = db.inhouseSessions.find((item) => item.id === sessionId);
  if (!session) {
    throw new Error("内战选人会话不存在。");
  }
  return session;
}

function getSessionForEvent(db, eventId) {
  const session = db.inhouseSessions.find((item) => item.eventId === eventId);
  return session ? serializeSession(db, session) : null;
}

function listSessions(db, auth) {
  return db.inhouseSessions.map((session) => serializeSession(db, session, auth));
}

function makePick(db, auth, sessionId, playerId) {
  const session = getSessionById(db, sessionId);
  if (session.status !== "drafting") {
    throw new Error("当前不在选人阶段。");
  }
  if (auth?.role !== "player" || !auth.playerId) {
    throw new Error("只有队长可以选人。");
  }
  const currentTeam = session.teams.find((team) => team.id === session.currentTurnTeamId);
  if (!currentTeam) {
    throw new Error("当前队伍不存在。");
  }
  if (currentTeam.captainId !== auth.playerId) {
    throw new Error("还没轮到你选人。");
  }
  if (!session.availablePlayerIds.includes(playerId)) {
    throw new Error("该玩家不可选。");
  }
  const playerMap = Object.fromEntries(db.players.map((player) => [player.id, player]));
  currentTeam.memberIds.push(playerId);
  currentTeam.totalPower += playerMap[playerId].power;
  session.availablePlayerIds = session.availablePlayerIds.filter((id) => id !== playerId);
  session.pickHistory.push({
    round: session.currentRound,
    teamId: currentTeam.id,
    captainId: currentTeam.captainId,
    playerId,
    pickedAt: nowIso()
  });
  session.roundQueue.shift();
  session.updatedAt = nowIso();
  updateTurn(db, session);
  return serializeSession(db, session, auth);
}

module.exports = {
  assignCaptains,
  getSessionForEvent,
  listSessions,
  makePick,
  serializeSession
};
