"use strict";

const { makeId, nowIso } = require("../lib/utils");
const { sanitizePlayer } = require("./players");

function assertAdmin(auth) {
  if (auth?.role !== "admin") {
    throw new Error("只有管理员可以执行该操作。");
  }
}

function getAuction(db, auctionId) {
  const auction = db.auctionRooms.find((item) => item.id === auctionId);
  if (!auction) {
    throw new Error("拍卖不存在。");
  }
  return auction;
}

function getAuctionTeamSize(db, auction) {
  const eventTeamSize = db.events.find((item) => item.id === auction.eventId)?.teamSize;
  return Math.max(1, Number(auction.teamSize || eventTeamSize || 1));
}

function getTeamSlotsRemaining(db, auction, team) {
  return Math.max(0, getAuctionTeamSize(db, auction) - team.playerIds.length);
}

function getReserveBudgetForRemainingSlots(db, auction, team, slotsToFill = getTeamSlotsRemaining(db, auction, team)) {
  return Math.max(0, slotsToFill) * auction.config.startPrice;
}

function getMaxSafeBid(db, auction, team) {
  const slotsRemaining = getTeamSlotsRemaining(db, auction, team);
  if (slotsRemaining <= 0) {
    return 0;
  }
  const reserveAfterThisWin = getReserveBudgetForRemainingSlots(db, auction, team, slotsRemaining - 1);
  return Math.max(0, remainingBudget(team) - reserveAfterThisWin);
}

function canTeamBidOnCurrentLot(db, auction, team, amount) {
  const slotsRemaining = getTeamSlotsRemaining(db, auction, team);
  if (slotsRemaining <= 0) {
    return { allowed: false, reason: "队伍人数已满，不能继续拍下选手。" };
  }

  const maxSafeBid = getMaxSafeBid(db, auction, team);
  if (amount > maxSafeBid) {
    return {
      allowed: false,
      reason: "出价后将无法保留后续最低成型预算。"
    };
  }

  return { allowed: true, maxSafeBid };
}

function createAuction(db, auth, input) {
  assertAdmin(auth);
  const event = db.events.find((item) => item.id === input.eventId);
  if (!event) {
    throw new Error("关联赛事不存在。");
  }
  if (!event.captainIds.length) {
    throw new Error("请先任命队长，再创建拍卖。");
  }
  const playerMap = Object.fromEntries(db.players.map((player) => [player.id, player]));
  const nominationOrder = Array.isArray(input.playerIds) && input.playerIds.length
    ? input.playerIds.map(String)
    : event.signupIds.filter((id) => !event.captainIds.includes(id));
  const budgetMap = input.budgetMap && typeof input.budgetMap === "object" ? input.budgetMap : {};
  const createdAt = nowIso();
  const auction = {
    id: makeId("auction"),
    eventId: event.id,
    title: String(input.title || `${event.name} 选手拍卖`).trim(),
    status: "pending",
    teamSize: Math.max(1, Number(event.teamSize || 0)),
    nominationOrder,
    currentNominationIndex: 0,
    config: {
      startPrice: Math.max(0, Number(input.startPrice || 20)),
      increment: Math.max(1, Number(input.increment || 10)),
      bidTimeoutSec: Math.max(5, Number(input.bidTimeoutSec || 20))
    },
    teams: event.captainIds.map((captainId) => ({
      id: captainId,
      captainId,
      name: `${playerMap[captainId].displayName}队`,
      budget: Math.max(0, Number(budgetMap[captainId] ?? input.budget ?? 600)),
      spent: 0,
      playerIds: [captainId],
      totalPower: playerMap[captainId].power
    })),
    currentLot: null,
    completedLots: [],
    unsoldPlayerIds: [],
    createdAt,
    updatedAt: createdAt
  };
  db.auctionRooms.unshift(auction);
  return serializeAuction(db, auction, auth);
}

function openNextLot(db, auction) {
  const now = Date.now();
  const playerId = auction.nominationOrder[auction.currentNominationIndex] || null;
  if (!playerId) {
    auction.status = "completed";
    auction.currentLot = null;
    return;
  }
  auction.currentLot = {
    playerId,
    currentPrice: auction.config.startPrice,
    leadingTeamId: null,
    bids: [],
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + auction.config.bidTimeoutSec * 1000).toISOString()
  };
}

function startAuction(db, auth, auctionId) {
  assertAdmin(auth);
  const auction = getAuction(db, auctionId);
  if (!["pending", "paused"].includes(auction.status)) {
    throw new Error("拍卖已开始或已结束。");
  }
  auction.status = "running";
  if (!auction.currentLot) {
    openNextLot(db, auction);
  } else {
    const remainMs = Math.max(1000, Number(auction.currentLot.remainingMs || auction.config.bidTimeoutSec * 1000));
    auction.currentLot.expiresAt = new Date(Date.now() + remainMs).toISOString();
    delete auction.currentLot.remainingMs;
  }
  auction.updatedAt = nowIso();
  return serializeAuction(db, auction, auth);
}

function pauseAuction(db, auth, auctionId) {
  assertAdmin(auth);
  const auction = getAuction(db, auctionId);
  if (auction.status !== "running" || !auction.currentLot) {
    throw new Error("当前拍卖不在进行中。");
  }
  auction.status = "paused";
  auction.currentLot.remainingMs = Math.max(
    1000,
    new Date(auction.currentLot.expiresAt).getTime() - Date.now()
  );
  auction.updatedAt = nowIso();
  return serializeAuction(db, auction, auth);
}

function findCaptainTeam(auction, playerId) {
  return auction.teams.find((team) => team.captainId === playerId) || null;
}

function remainingBudget(team) {
  return team.budget - team.spent;
}

function bid(db, auth, auctionId, input) {
  const auction = getAuction(db, auctionId);
  if (auction.status !== "running" || !auction.currentLot) {
    throw new Error("当前没有可竞价的拍品。");
  }
  if (auth?.role !== "player" || !auth.playerId) {
    throw new Error("只有队长可以出价。");
  }
  const team = findCaptainTeam(auction, auth.playerId);
  if (!team) {
    throw new Error("你不是当前拍卖的竞价队长。");
  }
  const minAmount = auction.currentLot.leadingTeamId
    ? auction.currentLot.currentPrice + auction.config.increment
    : Math.max(auction.config.startPrice, auction.currentLot.currentPrice);
  const amount = Number(input.amount || minAmount);
  if (!Number.isFinite(amount) || amount < minAmount) {
    throw new Error(`出价必须不低于 ${minAmount}。`);
  }
  if (remainingBudget(team) < amount) {
    throw new Error("预算不足，无法出价。");
  }
  const bidCheck = canTeamBidOnCurrentLot(db, auction, team, amount);
  if (!bidCheck.allowed) {
    throw new Error(bidCheck.reason);
  }

  auction.currentLot.currentPrice = amount;
  auction.currentLot.leadingTeamId = team.id;
  auction.currentLot.expiresAt = new Date(Date.now() + auction.config.bidTimeoutSec * 1000).toISOString();
  auction.currentLot.bids.push({
    teamId: team.id,
    captainId: auth.playerId,
    amount,
    createdAt: nowIso()
  });
  auction.updatedAt = nowIso();
  return serializeAuction(db, auction, auth);
}

function settleCurrentLot(db, auction) {
  if (!auction.currentLot) {
    return;
  }
  const playerMap = Object.fromEntries(db.players.map((player) => [player.id, player]));
  const lot = auction.currentLot;
  if (!lot.leadingTeamId) {
    auction.unsoldPlayerIds.push(lot.playerId);
    auction.completedLots.push({
      playerId: lot.playerId,
      finalPrice: null,
      teamId: null,
      status: "unsold",
      settledAt: nowIso()
    });
  } else {
    const team = auction.teams.find((item) => item.id === lot.leadingTeamId);
    const settleCheck = team ? canTeamBidOnCurrentLot(db, auction, team, lot.currentPrice) : { allowed: false };
    if (!team || !settleCheck.allowed) {
      auction.unsoldPlayerIds.push(lot.playerId);
      auction.completedLots.push({
        playerId: lot.playerId,
        finalPrice: null,
        teamId: null,
        status: "unsold",
        settledAt: nowIso()
      });
    } else {
      team.spent += lot.currentPrice;
      team.playerIds.push(lot.playerId);
      team.totalPower += playerMap[lot.playerId].power;
      auction.completedLots.push({
        playerId: lot.playerId,
        finalPrice: lot.currentPrice,
        teamId: team.id,
        status: "sold",
        settledAt: nowIso()
      });
    }
  }
  auction.currentNominationIndex += 1;
  auction.currentLot = null;
  if (auction.currentNominationIndex >= auction.nominationOrder.length) {
    auction.status = "completed";
  } else if (auction.status === "running") {
    openNextLot(db, auction);
  }
  auction.updatedAt = nowIso();
}

function settleExpiredAuctions(db) {
  let changed = false;
  for (const auction of db.auctionRooms) {
    if (auction.status === "running" && auction.currentLot) {
      if (Date.now() >= new Date(auction.currentLot.expiresAt).getTime()) {
        settleCurrentLot(db, auction);
        changed = true;
      }
    }
  }
  return changed;
}

function serializeAuction(db, auction, auth) {
  const playerMap = Object.fromEntries(db.players.map((player) => [player.id, player]));
  const currentPlayer = auction.currentLot ? playerMap[auction.currentLot.playerId] : null;
  const leadingTeam = auction.currentLot
    ? auction.teams.find((team) => team.id === auction.currentLot.leadingTeamId) || null
    : null;
  const myTeam = auth?.playerId ? findCaptainTeam(auction, auth.playerId) : null;
  const myBidMeta = myTeam && auction.currentLot
    ? canTeamBidOnCurrentLot(
        db,
        auction,
        myTeam,
        auction.currentLot.leadingTeamId
          ? auction.currentLot.currentPrice + auction.config.increment
          : Math.max(auction.config.startPrice, auction.currentLot.currentPrice)
      )
    : null;
  return {
    id: auction.id,
    eventId: auction.eventId,
    title: auction.title,
    status: auction.status,
    teamSize: getAuctionTeamSize(db, auction),
    config: auction.config,
    teams: auction.teams.map((team) => ({
      id: team.id,
      captainId: team.captainId,
      name: team.name,
      budget: team.budget,
      spent: team.spent,
      remainingBudget: remainingBudget(team),
      slotsRemaining: getTeamSlotsRemaining(db, auction, team),
      reserveBudget: getReserveBudgetForRemainingSlots(db, auction, team),
      maxSafeBid: getMaxSafeBid(db, auction, team),
      totalPower: team.totalPower,
      captain: sanitizePlayer(playerMap[team.captainId], auth),
      players: team.playerIds.map((id) => sanitizePlayer(playerMap[id], auth)).filter(Boolean)
    })),
    currentLot: auction.currentLot
      ? {
          ...auction.currentLot,
          player: sanitizePlayer(currentPlayer, auth),
          leadingTeamName: leadingTeam?.name || null,
          remainingMs: auction.currentLot.remainingMs || null,
          minBidAmount: auction.currentLot.leadingTeamId
            ? auction.currentLot.currentPrice + auction.config.increment
            : Math.max(auction.currentLot.currentPrice, auction.config.startPrice)
        }
      : null,
    upcomingPlayers: auction.nominationOrder
      .slice(auction.currentNominationIndex + (auction.currentLot ? 1 : 0))
      .map((id) => sanitizePlayer(playerMap[id], auth))
      .filter(Boolean),
    currentPlayer: sanitizePlayer(currentPlayer, auth),
    completedLots: auction.completedLots.map((lot) => ({
      ...lot,
      player: sanitizePlayer(playerMap[lot.playerId], auth),
      teamName: lot.teamId ? auction.teams.find((team) => team.id === lot.teamId)?.name || null : null
    })),
    unsoldPlayers: auction.unsoldPlayerIds.map((id) => sanitizePlayer(playerMap[id], auth)).filter(Boolean),
    myTeamId: myTeam?.id || null,
    canBid: Boolean(myTeam && auction.status === "running" && auction.currentLot && myBidMeta?.allowed),
    maxBidAmount: myTeam ? getMaxSafeBid(db, auction, myTeam) : null
  };
}

function listAuctions(db, auth) {
  return db.auctionRooms.map((auction) => serializeAuction(db, auction, auth));
}

module.exports = {
  bid,
  createAuction,
  getAuction,
  listAuctions,
  pauseAuction,
  settleCurrentLot,
  settleExpiredAuctions,
  serializeAuction,
  startAuction
};
