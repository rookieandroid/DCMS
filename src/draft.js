"use strict";

const TEAM_SIZE = 5;

function parseSignupText(signupText) {
  const lines = String(signupText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < TEAM_SIZE) {
    throw new Error("报名人数不足 5 人，无法创建内战房间。");
  }

  return lines.map((line, index) => {
    const match = line.match(/^(.+?)\s+(-?\d+(?:\.\d+)?)$/);
    if (!match) {
      throw new Error(`第 ${index + 1} 行格式错误，请使用“玩家ID 战力值”。`);
    }

    const id = match[1].trim();
    const power = Number(match[2]);
    if (!id) {
      throw new Error(`第 ${index + 1} 行缺少玩家ID。`);
    }
    if (!Number.isFinite(power)) {
      throw new Error(`第 ${index + 1} 行战力值非法。`);
    }

    return {
      id,
      power,
      signupOrder: index
    };
  });
}

function compareByPowerDesc(a, b) {
  if (b.power !== a.power) {
    return b.power - a.power;
  }
  return a.signupOrder - b.signupOrder;
}

function compareByPowerAsc(a, b) {
  if (a.power !== b.power) {
    return a.power - b.power;
  }
  return a.signupOrder - b.signupOrder;
}

function compareTeamsForRound(teams) {
  return [...teams].sort((a, b) => {
    if (a.totalPower !== b.totalPower) {
      return a.totalPower - b.totalPower;
    }
    if (a.captain.power !== b.captain.power) {
      return a.captain.power - b.captain.power;
    }
    return a.captain.signupOrder - b.captain.signupOrder;
  });
}

function randomCode(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function makePlayerMap(players) {
  return Object.fromEntries(players.map((player) => [player.id, player]));
}

function buildRoundQueue(room, round) {
  const incompleteTeams = room.teams.filter((team) => team.members.length < TEAM_SIZE);
  if (round === 1) {
    return [...incompleteTeams]
      .sort((a, b) => compareByPowerAsc(a.captain, b.captain))
      .map((team) => team.id);
  }

  return compareTeamsForRound(incompleteTeams).map((team) => team.id);
}

function finalizeBench(room) {
  room.benchPlayers = room.availablePlayers.map((playerId) => room.playerMap[playerId]);
}

function updateDraftTurn(room) {
  const incompleteTeams = room.teams.filter((team) => team.members.length < TEAM_SIZE);
  if (incompleteTeams.length === 0) {
    room.status = "completed";
    room.currentRound = null;
    room.roundQueue = [];
    room.currentTurn = null;
    finalizeBench(room);
    return;
  }

  if (!room.roundQueue || room.roundQueue.length === 0) {
    room.currentRound = room.currentRound ? room.currentRound + 1 : 1;
    room.roundQueue = buildRoundQueue(room, room.currentRound);
  }

  const teamId = room.roundQueue[0];
  const team = room.teams.find((item) => item.id === teamId);
  room.currentTurn = {
    round: room.currentRound,
    teamId: team.id,
    captainId: team.captain.id
  };
}

function summarizeTeam(team) {
  return {
    id: team.id,
    name: team.name,
    totalPower: team.totalPower,
    captain: team.captain,
    members: team.members
  };
}

function createRoom({ startTime, captainRule, signupText }) {
  const players = parseSignupText(signupText);
  const roomId = `room_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const roomCode = randomCode(6);
  const teamCount = Math.floor(players.length / TEAM_SIZE);
  if (teamCount < 1) {
    throw new Error("报名人数不足以组成任何队伍。");
  }

  return {
    id: roomId,
    roomCode,
    startTime,
    captainRule: captainRule === "lowest" ? "lowest" : "highest",
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    adminToken: randomCode(10),
    players,
    playerMap: makePlayerMap(players),
    teamSize: TEAM_SIZE,
    teamCount,
    teams: [],
    captains: [],
    captainAccess: [],
    availablePlayers: [],
    benchPlayers: [],
    pickHistory: [],
    currentRound: null,
    roundQueue: [],
    currentTurn: null
  };
}

function startDraft(room) {
  if (room.status !== "pending") {
    throw new Error("当前房间已经开始选人或已完成。");
  }

  const sortedPlayers = [...room.players].sort(
    room.captainRule === "lowest" ? compareByPowerAsc : compareByPowerDesc
  );
  const captainPool = sortedPlayers.slice(0, room.teamCount);
  const captainIds = new Set(captainPool.map((player) => player.id));
  const availablePlayers = room.players.filter((player) => !captainIds.has(player.id));

  room.captains = [...captainPool].sort(compareByPowerAsc);
  room.captainAccess = room.captains.map((captain) => ({
    captainId: captain.id,
    token: randomCode(8),
    teamId: captain.id
  }));
  room.teams = room.captains.map((captain) => ({
    id: captain.id,
    name: captain.id,
    captain,
    members: [captain],
    totalPower: captain.power
  }));
  room.availablePlayers = availablePlayers.map((player) => player.id);
  room.benchPlayers = [];
  room.pickHistory = [];
  room.status = "drafting";
  room.currentRound = 0;
  room.roundQueue = [];
  room.currentTurn = null;
  updateDraftTurn(room);
  room.updatedAt = new Date().toISOString();
  return room;
}

function getCaptainAccess(room, token) {
  return room.captainAccess.find((item) => item.token === token) || null;
}

function canPick(room, auth, teamId) {
  if (!room.currentTurn || room.currentTurn.teamId !== teamId) {
    return false;
  }
  if (!auth) {
    return false;
  }
  if (auth.role === "admin") {
    return true;
  }
  return auth.role === "captain" && auth.teamId === teamId;
}

function makePick(room, auth, playerId) {
  if (room.status !== "drafting") {
    throw new Error("当前房间不在选人阶段。");
  }

  const currentTeam = room.teams.find((team) => team.id === room.currentTurn.teamId);
  if (!currentTeam) {
    throw new Error("当前队伍不存在。");
  }
  if (!canPick(room, auth, currentTeam.id)) {
    throw new Error("当前身份无权为该队伍选人。");
  }

  const availableIndex = room.availablePlayers.indexOf(playerId);
  if (availableIndex === -1) {
    throw new Error("该玩家已被选走或不在可选池中。");
  }

  const player = room.playerMap[playerId];
  currentTeam.members.push(player);
  currentTeam.totalPower += player.power;
  room.availablePlayers.splice(availableIndex, 1);
  room.pickHistory.push({
    round: room.currentTurn.round,
    teamId: currentTeam.id,
    captainId: currentTeam.captain.id,
    playerId: player.id,
    playerPower: player.power,
    pickedAt: new Date().toISOString()
  });
  room.roundQueue.shift();
  room.updatedAt = new Date().toISOString();
  updateDraftTurn(room);
  return room;
}

function getAuth(room, token) {
  if (!token) {
    return null;
  }
  if (token === room.adminToken) {
    return { role: "admin" };
  }
  const captainAccess = getCaptainAccess(room, token);
  if (captainAccess) {
    return {
      role: "captain",
      teamId: captainAccess.teamId,
      captainId: captainAccess.captainId
    };
  }
  return null;
}

function serializeRoom(room, auth) {
  const base = {
    id: room.id,
    roomCode: room.roomCode,
    startTime: room.startTime,
    captainRule: room.captainRule,
    status: room.status,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    teamSize: room.teamSize,
    teamCount: room.teamCount,
    totalPlayers: room.players.length,
    players: room.players,
    captains: room.captains,
    teams: room.teams.map(summarizeTeam),
    availablePlayers: room.availablePlayers.map((playerId) => room.playerMap[playerId]),
    benchPlayers: room.benchPlayers,
    pickHistory: room.pickHistory,
    currentRound: room.currentRound,
    currentTurn: room.currentTurn
  };

  if (auth?.role === "admin") {
    return {
      ...base,
      adminToken: room.adminToken,
      captainAccess: room.captainAccess
    };
  }

  return {
    ...base,
    viewer: auth || { role: "guest" }
  };
}

function summarizeRoom(room) {
  return {
    id: room.id,
    roomCode: room.roomCode,
    startTime: room.startTime,
    status: room.status,
    captainRule: room.captainRule,
    teamCount: room.teamCount,
    totalPlayers: room.players.length,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt
  };
}

module.exports = {
  TEAM_SIZE,
  buildRoundQueue,
  createRoom,
  getAuth,
  makePick,
  parseSignupText,
  serializeRoom,
  startDraft,
  summarizeRoom
};
