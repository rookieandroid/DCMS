"use strict";

const { makeId, nowIso } = require("./lib/utils");

function createPlayer(id, displayName, options = {}) {
  const createdAt = nowIso();
  return {
    id,
    displayName,
    wechatName: options.wechatName || "",
    mmr: options.mmr ?? 0,
    power: options.power ?? 50,
    positions: options.positions || [],
    intro: options.intro || "",
    championships: options.championships ?? 0,
    avatar: options.avatar || "",
    isPublic: options.isPublic !== false,
    createdAt,
    updatedAt: createdAt
  };
}

function createSeedData() {
  const createdAt = nowIso();
  const players = [
    createPlayer("1001", "兆焱", {
      wechatName: "兆焱",
      mmr: 510,
      power: 95,
      positions: ["2", "5"],
      intro: "喜欢带节奏的中单队长，擅长大核与法核切换。",
      championships: 2
    }),
    createPlayer("1002", "小小Zuilekha", {
      wechatName: "Zuilekha",
      mmr: 498,
      power: 92,
      positions: ["4", "5"],
      intro: "手脚干净不偷大哥的钱，偏团队型辅助。",
      championships: 1
    }),
    createPlayer("1003", "米波三号", {
      mmr: 470,
      power: 88,
      positions: ["1", "2"],
      intro: "高爆发收割位，擅长在残局里接管比赛。"
    }),
    createPlayer("1004", "山丘胖头鱼", {
      mmr: 452,
      power: 84,
      positions: ["3", "4"],
      intro: "对线强度稳定，喜欢主动开团。"
    }),
    createPlayer("1005", "奶绿四号位", {
      mmr: 440,
      power: 80,
      positions: ["4"],
      intro: "游走型四号位，开雾抓人效率高。"
    }),
    createPlayer("1006", "云顶守卫", {
      mmr: 436,
      power: 78,
      positions: ["5"],
      intro: "纪律性很强的保人辅助。"
    }),
    createPlayer("1007", "白牛晚点到", {
      mmr: 430,
      power: 75,
      positions: ["3"],
      intro: "先手果断，适合体系型阵容。"
    }),
    createPlayer("1008", "双头龙", {
      mmr: 426,
      power: 73,
      positions: ["4", "5"],
      intro: "线优工具人，擅长推进节奏。"
    }),
    createPlayer("1009", "影魔收藏家", {
      mmr: 420,
      power: 71,
      positions: ["1", "2"],
      intro: "打钱速度快，适合后期核心。"
    }),
    createPlayer("1010", "老陈", {
      mmr: 418,
      power: 69,
      positions: ["5"],
      intro: "能稳定执行战术，团战站位好。"
    }),
    createPlayer("1011", "哈斯卡发烧友", {
      mmr: 412,
      power: 66,
      positions: ["1", "3"],
      intro: "英雄池偏绝活，冲脸压制能力强。"
    }),
    createPlayer("1012", "快乐冰女", {
      mmr: 405,
      power: 64,
      positions: ["4", "5"],
      intro: "视野积极，适合大局观型阵容。"
    })
  ];

  const eventId = makeId("event");
  const signupIds = ["1001", "1002", "1003", "1004", "1005", "1006", "1007", "1008", "1009", "1010"];
  const captainIds = ["1001", "1002"];
  const inhouseId = makeId("inhouse");
  const teams = captainIds.map((captainId) => {
    const player = players.find((item) => item.id === captainId);
    return {
      id: captainId,
      captainId,
      name: `${player.displayName}队`,
      memberIds: [captainId],
      totalPower: player.power
    };
  });

  const auctionId = makeId("auction");
  return {
    meta: {
      seededAt: createdAt
    },
    users: [],
    sessions: [],
    players,
    events: [
      {
        id: eventId,
        name: "微雨杯 S1 社区赛",
        startTime: createdAt,
        status: "open",
        enableAuction: true,
        enableInhouse: true,
        teamSize: 5,
        signupOpen: true,
        signupIds,
        captainIds,
        createdAt,
        updatedAt: createdAt
      }
    ],
    inhouseSessions: [
      {
        id: inhouseId,
        eventId,
        status: "drafting",
        teamSize: 5,
        captainIds,
        teams,
        availablePlayerIds: signupIds.filter((id) => !captainIds.includes(id)),
        pickHistory: [],
        currentRound: 1,
        roundQueue: captainIds,
        currentTurnTeamId: captainIds[0],
        createdAt,
        updatedAt: createdAt
      }
    ],
    auctionRooms: [
      {
        id: auctionId,
        eventId,
        title: "微雨杯 S1 社区赛选手拍卖",
        status: "pending",
        nominationOrder: ["1003", "1004", "1005", "1006", "1007", "1008"],
        currentNominationIndex: 0,
        config: {
          startPrice: 20,
          increment: 10,
          bidTimeoutSec: 20
        },
        teams: captainIds.map((captainId) => {
          const captain = players.find((item) => item.id === captainId);
          return {
            id: captainId,
            captainId,
            name: `${captain.displayName}队`,
            budget: 600,
            spent: 0,
            playerIds: [captainId],
            totalPower: captain.power
          };
        }),
        currentLot: null,
        completedLots: [],
        unsoldPlayerIds: [],
        createdAt,
        updatedAt: createdAt
      }
    ]
  };
}

module.exports = {
  createSeedData
};
