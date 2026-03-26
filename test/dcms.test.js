"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx");
const { createSeedData } = require("../src/seed");
const { createPlayer, importPlayersFromWorkbook, listPlayers, updatePlayer } = require("../src/services/players");
const { login, getAuth } = require("../src/services/auth");
const { deleteEvent, signupForEvent, updateEvent } = require("../src/services/events");
const { assignCaptains, makePick } = require("../src/services/inhouse");
const {
  bid,
  createAuction,
  listAuctions,
  pauseAuction,
  settleExpiredAuctions,
  startAuction
} = require("../src/services/auctions");

function freshDb() {
  return createSeedData();
}

test("玩家库拦截重复数字 ID", () => {
  const db = freshDb();
  assert.throws(
    () =>
      createPlayer(db, { role: "admin" }, {
        id: "1001",
        displayName: "重复玩家",
        power: 60
      }),
    /已存在/
  );
});

test("编辑玩家时禁止修改数字 ID", () => {
  const db = freshDb();
  assert.throws(
    () =>
      updatePlayer(db, { role: "admin" }, "1001", {
        id: "9999",
        displayName: "兆焱"
      }),
    /不可修改/
  );
});

test("管理员可以通过 Excel 导入玩家并更新同 steamid 数据", () => {
  const db = freshDb();
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["序号", "微信昵称", "steamid", "战力", "分数", "擅长位置", "内战冠军次数", "自我介绍"],
    ["1", "导入玩家A", "20001", "81", "7200", "一,三,五", "2", "测试导入"],
    ["2", "兆焱S2", "1001", "82", "8100", "二,四", "1", "已更新"]
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "S2名单");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  const result = importPlayersFromWorkbook(db, { role: "admin" }, {
    sheetName: "S2名单",
    contentBase64: buffer.toString("base64")
  });

  assert.equal(result.importedCount, 2);
  assert.equal(result.created, 1);
  assert.equal(result.updated, 1);

  const imported = db.players.find((player) => player.id === "20001");
  assert.equal(imported.displayName, "导入玩家A");
  assert.deepEqual(imported.positions, ["1", "3", "5"]);

  const updated = db.players.find((player) => player.id === "1001");
  assert.equal(updated.displayName, "兆焱S2");
  assert.equal(updated.mmr, 8100);
  assert.deepEqual(updated.positions, ["2", "4"]);
  assert.equal(updated.intro, "已更新");
});

test("非管理员不能通过 Excel 导入玩家", () => {
  const db = freshDb();
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["序号", "微信昵称", "steamid", "战力", "分数", "擅长位置", "内战冠军次数", "自我介绍"],
    ["1", "导入玩家A", "20001", "81", "7200", "一", "2", "测试导入"]
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "S2名单");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  assert.throws(
    () =>
      importPlayersFromWorkbook(db, { role: "player", playerId: "1001" }, {
        sheetName: "S2名单",
        contentBase64: buffer.toString("base64")
      }),
    /管理员/
  );
});

test("玩家查询支持按战力升序筛选", () => {
  const db = freshDb();
  const players = listPlayers(db, { role: "guest" }, { sort: "powerAsc", position: "5" });
  assert.equal(players[0].power <= players[1].power, true);
  assert.ok(players.every((player) => player.positions.includes("5")));
});

test("数字 ID 登录后只能获得自己的身份", () => {
  const db = freshDb();
  const session = login(db, { type: "player", playerId: "1001" });
  const auth = getAuth(db, session.token);
  assert.equal(auth.role, "player");
  assert.equal(auth.playerId, "1001");
});

test("报名去重且取消后可再次报名", () => {
  const db = freshDb();
  const eventId = db.events[0].id;
  const auth = { role: "player", playerId: "1011" };
  signupForEvent(db, auth, eventId, "signup");
  assert.throws(() => signupForEvent(db, auth, eventId, "signup"), /重复报名/);
  signupForEvent(db, auth, eventId, "cancel");
  const result = signupForEvent(db, auth, eventId, "signup");
  assert.equal(result.signedUp, true);
});

test("管理员可以直接帮玩家报名赛事", () => {
  const db = freshDb();
  const eventId = db.events[0].id;
  const result = signupForEvent(db, { role: "admin" }, eventId, "signup", "1011");
  assert.equal(result.signupCount, 11);
  assert.equal(db.events[0].signupIds.includes("1011"), true);
});

test("管理员可以关闭赛事报名", () => {
  const db = freshDb();
  const eventId = db.events[0].id;
  const updated = updateEvent(db, { role: "admin" }, eventId, { signupOpen: false });
  assert.equal(updated.signupOpen, false);
  assert.throws(
    () => signupForEvent(db, { role: "player", playerId: "1011" }, eventId, "signup"),
    /未开放报名/
  );
});

test("只能从已报名玩家中任命队长", () => {
  const db = freshDb();
  const eventId = db.events[0].id;
  assert.throws(
    () => assignCaptains(db, { role: "admin" }, eventId, ["1001", "1012"]),
    /已报名玩家/
  );
});

test("内战选人后实时更新队伍战力和当前轮次", () => {
  const db = freshDb();
  const eventId = db.events[0].id;
  const session = assignCaptains(db, { role: "admin" }, eventId, ["1001", "1002"]);
  const beforeTeam = session.teams.find((team) => team.id === session.currentTurnTeamId);
  const nextPlayer = session.availablePlayers[0];
  const updated = makePick(db, { role: "player", playerId: beforeTeam.captainId }, session.id, nextPlayer.id);
  const team = updated.teams.find((item) => item.id === beforeTeam.id);
  assert.equal(team.members.some((member) => member.id === nextPlayer.id), true);
  assert.ok(team.totalPower > beforeTeam.totalPower);
  assert.ok(updated.currentRound >= 1);
});

test("非当前队长不能选人", () => {
  const db = freshDb();
  const eventId = db.events[0].id;
  const session = assignCaptains(db, { role: "admin" }, eventId, ["1001", "1002"]);
  const wrongCaptain = session.teams.find((team) => team.id !== session.currentTurnTeamId);
  assert.throws(
    () => makePick(db, { role: "player", playerId: wrongCaptain.captainId }, session.id, session.availablePlayers[0].id),
    /没轮到/
  );
});

test("拍卖出价必须满足加价幅度且不能超预算", () => {
  const db = freshDb();
  const auctionId = db.auctionRooms[0].id;
  startAuction(db, { role: "admin" }, auctionId);
  assert.throws(
    () => bid(db, { role: "player", playerId: "1001" }, auctionId, { amount: 10 }),
    /不低于/
  );
  assert.throws(
    () => bid(db, { role: "player", playerId: "1001" }, auctionId, { amount: 9999 }),
    /预算不足/
  );
});

test("创建拍卖时支持给不同队长分配不同预算", () => {
  const db = freshDb();
  const eventId = db.events[0].id;
  const auction = createAuction(db, { role: "admin" }, {
    eventId,
    title: "预算测试拍卖",
    budgetMap: {
      "1001": 700,
      "1002": 450
    }
  });
  const teamA = auction.teams.find((team) => team.captainId === "1001");
  const teamB = auction.teams.find((team) => team.captainId === "1002");
  assert.equal(teamA.budget, 700);
  assert.equal(teamB.budget, 450);
});

test("拍卖倒计时结束后自动成交", () => {
  const db = freshDb();
  const auction = startAuction(db, { role: "admin" }, db.auctionRooms[0].id);
  bid(db, { role: "player", playerId: "1001" }, auction.id, { amount: 20 });
  db.auctionRooms[0].currentLot.expiresAt = new Date(Date.now() - 1000).toISOString();
  const changed = settleExpiredAuctions(db);
  assert.equal(changed, true);
  assert.equal(db.auctionRooms[0].completedLots.length, 1);
  assert.equal(db.auctionRooms[0].teams[0].playerIds.length, 2);
});

test("管理员可以暂停并继续拍卖", () => {
  const db = freshDb();
  const started = startAuction(db, { role: "admin" }, db.auctionRooms[0].id);
  const paused = pauseAuction(db, { role: "admin" }, started.id);
  assert.equal(paused.status, "paused");
  assert.ok(paused.currentLot.remainingMs > 0);
  const resumed = startAuction(db, { role: "admin" }, started.id);
  assert.equal(resumed.status, "running");
  assert.equal(Boolean(resumed.currentLot.expiresAt), true);
});

test("无有效出价时拍品流拍", () => {
  const db = freshDb();
  const auction = startAuction(db, { role: "admin" }, db.auctionRooms[0].id);
  db.auctionRooms[0].currentLot.expiresAt = new Date(Date.now() - 1000).toISOString();
  settleExpiredAuctions(db);
  assert.equal(db.auctionRooms[0].completedLots[0].status, "unsold");
  assert.equal(db.auctionRooms[0].unsoldPlayerIds.length, 1);
});

test("管理员删除赛事时会一并清理关联内战和拍卖", () => {
  const db = freshDb();
  const eventId = db.events[0].id;
  const result = deleteEvent(db, { role: "admin" }, eventId);
  assert.equal(result.ok, true);
  assert.equal(db.events.length, 0);
  assert.equal(db.inhouseSessions.length, 0);
  assert.equal(db.auctionRooms.length, 0);
});

test("普通玩家在拍卖视图中看不到其他人的私有字段", () => {
  const db = freshDb();
  const auctions = listAuctions(db, { role: "player", playerId: "1001" });
  const otherCaptain = auctions[0].teams.find((team) => team.captainId === "1002").captain;
  assert.equal("wechatName" in otherCaptain, false);
});
