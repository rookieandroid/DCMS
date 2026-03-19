"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { ensureDb, loadDb, mutateDb, saveDb } = require("./src/lib/db");
const { getAuth, login } = require("./src/services/auth");
const {
  createPlayer,
  deletePlayer,
  listPlayers,
  updatePlayer
} = require("./src/services/players");
const {
  createEvent,
  deleteEvent,
  listEvents,
  signupForEvent,
  toEventSummary,
  updateEvent
} = require("./src/services/events");
const { assignCaptains, getSessionForEvent, listSessions, makePick } = require("./src/services/inhouse");
const {
  bid,
  createAuction,
  listAuctions,
  pauseAuction,
  settleExpiredAuctions,
  startAuction
} = require("./src/services/auctions");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const publicDir = path.join(__dirname, "public");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const auctionClients = new Map();
const inhouseClients = new Map();

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function getToken(req, reqUrl) {
  return reqUrl.searchParams.get("token") || req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
}

async function serveStatic(urlPath, res) {
  const cleanPath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.join(publicDir, cleanPath);
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "资源不存在。" });
  }
}

async function withDbAuth(req, reqUrl, handler, res) {
  try {
    const db = await loadDb();
    const auth = getAuth(db, getToken(req, reqUrl));
    await handler(db, auth);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "请求失败。" });
  }
}

function registerClient(map, key, auth, res) {
  const clients = map.get(key) || new Set();
  const client = { res, auth };
  clients.add(client);
  map.set(key, clients);
  return () => {
    clients.delete(client);
    if (!clients.size) {
      map.delete(key);
    }
  };
}

function writeSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function buildBootstrap(db, auth) {
  const events = listEvents(db, auth);
  return {
    auth,
    players: listPlayers(db, auth, {}),
    events,
    auctions: listAuctions(db, auth),
    inhouseSessions: listSessions(db, auth),
    profile: auth.playerId ? db.players.find((player) => player.id === auth.playerId) || null : null
  };
}

async function broadcastAuction(auctionId) {
  const clients = auctionClients.get(auctionId);
  if (!clients?.size) {
    return;
  }
  const db = await loadDb();
  const auction = db.auctionRooms.find((item) => item.id === auctionId);
  if (!auction) {
    return;
  }
  for (const client of clients) {
    const payload = listAuctions(db, client.auth).find((item) => item.id === auctionId);
    writeSse(client.res, "auction.updated", payload);
  }
}

async function broadcastInhouse(sessionId) {
  const clients = inhouseClients.get(sessionId);
  if (!clients?.size) {
    return;
  }
  const db = await loadDb();
  const session = db.inhouseSessions.find((item) => item.id === sessionId);
  if (!session) {
    return;
  }
  for (const client of clients) {
    writeSse(
      client.res,
      "inhouse.updated",
      listSessions(db, client.auth).find((item) => item.id === sessionId)
    );
  }
}

async function broadcastEventSnapshots() {
  const db = await loadDb();
  const sessions = listSessions(db, { role: "guest" });
  for (const [sessionId, clients] of inhouseClients.entries()) {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) {
      continue;
    }
    for (const client of clients) {
      const event = db.events.find((item) => item.id === session.eventId);
      writeSse(client.res, "event.updated", toEventSummary(db, event, client.auth));
    }
  }
  for (const [auctionId, clients] of auctionClients.entries()) {
    const auction = db.auctionRooms.find((item) => item.id === auctionId);
    if (!auction) {
      continue;
    }
    const event = db.events.find((item) => item.id === auction.eventId);
    for (const client of clients) {
      writeSse(client.res, "event.updated", toEventSummary(db, event, client.auth));
    }
  }
}

async function settleAuctionsAndBroadcast() {
  let changedAuctions = [];
  try {
    await mutateDb(async (db) => {
      const before = db.auctionRooms.map((auction) => ({
        id: auction.id,
        status: auction.status,
        expiresAt: auction.currentLot?.expiresAt || null
      }));
      const changed = settleExpiredAuctions(db);
      if (changed) {
        changedAuctions = db.auctionRooms
          .filter((auction, index) => {
            const prev = before[index];
            return (
              !prev ||
              prev.status !== auction.status ||
              prev.expiresAt !== (auction.currentLot?.expiresAt || null)
            );
          })
          .map((auction) => auction.id);
      }
    });
    for (const auctionId of changedAuctions) {
      await broadcastAuction(auctionId);
    }
    if (changedAuctions.length) {
      await broadcastEventSnapshots();
    }
  } catch (error) {
    console.error("settle auctions failed", error);
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && reqUrl.pathname === "/api/auth/login") {
    try {
      const body = await readJson(req);
      const payload = await mutateDb((db) => login(db, body));
      const db = await loadDb();
      const auth = getAuth(db, payload.token);
      sendJson(res, 200, {
        ...payload,
        bootstrap: buildBootstrap(db, auth)
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "登录失败。" });
    }
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/bootstrap") {
    await withDbAuth(
      req,
      reqUrl,
      async (db, auth) => sendJson(res, 200, buildBootstrap(db, auth)),
      res
    );
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/players") {
    await withDbAuth(
      req,
      reqUrl,
      async (db, auth) => {
        sendJson(res, 200, {
          players: listPlayers(db, auth, Object.fromEntries(reqUrl.searchParams.entries()))
        });
      },
      res
    );
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/players") {
    try {
      const body = await readJson(req);
      const payload = await mutateDb((db) => {
        const auth = getAuth(db, getToken(req, reqUrl));
        return { player: createPlayer(db, auth, body) };
      });
      sendJson(res, 201, payload);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "创建玩家失败。" });
    }
    return;
  }

  const playerMatch = reqUrl.pathname.match(/^\/api\/players\/([^/]+)$/);
  if (playerMatch) {
    const [, playerId] = playerMatch;
    if (req.method === "PATCH") {
      try {
        const body = await readJson(req);
        const payload = await mutateDb((db) => {
          const auth = getAuth(db, getToken(req, reqUrl));
          return { player: updatePlayer(db, auth, playerId, body) };
        });
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 400, { error: error.message || "更新玩家失败。" });
      }
      return;
    }
    if (req.method === "DELETE") {
      try {
        const payload = await mutateDb((db) => {
          const auth = getAuth(db, getToken(req, reqUrl));
          return deletePlayer(db, auth, playerId);
        });
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 400, { error: error.message || "删除玩家失败。" });
      }
      return;
    }
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/events") {
    await withDbAuth(
      req,
      reqUrl,
      async (db, auth) => sendJson(res, 200, { events: listEvents(db, auth) }),
      res
    );
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/events") {
    try {
      const body = await readJson(req);
      const payload = await mutateDb((db) => {
        const auth = getAuth(db, getToken(req, reqUrl));
        return { event: createEvent(db, auth, body) };
      });
      sendJson(res, 201, payload);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "创建赛事失败。" });
    }
    return;
  }

  const eventBaseMatch = reqUrl.pathname.match(/^\/api\/events\/([^/]+)$/);
  if (eventBaseMatch) {
    const [, eventId] = eventBaseMatch;
    if (req.method === "PATCH") {
      try {
        const body = await readJson(req);
        const payload = await mutateDb((db) => {
          const auth = getAuth(db, getToken(req, reqUrl));
          return { event: updateEvent(db, auth, eventId, body) };
        });
        await broadcastEventSnapshots();
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 400, { error: error.message || "更新赛事失败。" });
      }
      return;
    }
    if (req.method === "DELETE") {
      try {
        const payload = await mutateDb((db) => {
          const auth = getAuth(db, getToken(req, reqUrl));
          return deleteEvent(db, auth, eventId);
        });
        await broadcastEventSnapshots();
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 400, { error: error.message || "删除赛事失败。" });
      }
      return;
    }
  }

  const eventMatch = reqUrl.pathname.match(/^\/api\/events\/([^/]+)\/(signup|captains)$/);
  if (eventMatch) {
    const [, eventId, action] = eventMatch;
    if (req.method === "POST" && action === "signup") {
      try {
        const body = await readJson(req);
        const payload = await mutateDb((db) => {
          const auth = getAuth(db, getToken(req, reqUrl));
          const event = signupForEvent(db, auth, eventId, body.action, body.playerId);
          return {
            event,
            inhouseSession: getSessionForEvent(db, eventId)
          };
        });
        await broadcastEventSnapshots();
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 400, { error: error.message || "报名失败。" });
      }
      return;
    }
    if (req.method === "POST" && action === "captains") {
      try {
        const body = await readJson(req);
        let sessionId = "";
        const payload = await mutateDb((db) => {
          const auth = getAuth(db, getToken(req, reqUrl));
          const inhouseSession = assignCaptains(db, auth, eventId, body.playerIds);
          sessionId = inhouseSession.id;
          return {
            inhouseSession,
            event: listEvents(db, auth).find((item) => item.id === eventId)
          };
        });
        await broadcastInhouse(sessionId);
        await broadcastEventSnapshots();
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 400, { error: error.message || "任命队长失败。" });
      }
      return;
    }
  }

  const inhouseMatch = reqUrl.pathname.match(/^\/api\/inhouse\/([^/]+)(?:\/(picks|events))?$/);
  if (inhouseMatch) {
    const [, sessionId, action] = inhouseMatch;
    if (req.method === "GET" && !action) {
      await withDbAuth(
        req,
        reqUrl,
        async (db) => {
          const session = listSessions(db, auth).find((item) => item.id === sessionId);
          if (!session) {
            sendJson(res, 404, { error: "内战会话不存在。" });
            return;
          }
          sendJson(res, 200, { inhouseSession: session });
        },
        res
      );
      return;
    }
    if (req.method === "POST" && action === "picks") {
      try {
        const body = await readJson(req);
        const payload = await mutateDb((db) => {
          const auth = getAuth(db, getToken(req, reqUrl));
          return { inhouseSession: makePick(db, auth, sessionId, body.playerId) };
        });
        await broadcastInhouse(sessionId);
        await broadcastEventSnapshots();
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 400, { error: error.message || "选人失败。" });
      }
      return;
    }
    if (req.method === "GET" && action === "events") {
      await withDbAuth(
        req,
        reqUrl,
        async (db, auth) => {
          const session = listSessions(db, auth).find((item) => item.id === sessionId);
          if (!session) {
            sendJson(res, 404, { error: "内战会话不存在。" });
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          });
          const unregister = registerClient(inhouseClients, sessionId, auth, res);
          writeSse(res, "inhouse.updated", session);
          const event = db.events.find((item) => item.id === session.eventId);
          writeSse(res, "event.updated", toEventSummary(db, event, auth));
          req.on("close", unregister);
        },
        res
      );
      return;
    }
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/auctions") {
    await withDbAuth(
      req,
      reqUrl,
      async (db, auth) => sendJson(res, 200, { auctions: listAuctions(db, auth) }),
      res
    );
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/auctions") {
    try {
      const body = await readJson(req);
      const payload = await mutateDb((db) => {
        const auth = getAuth(db, getToken(req, reqUrl));
        return { auction: createAuction(db, auth, body) };
      });
      sendJson(res, 201, payload);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "创建拍卖失败。" });
    }
    return;
  }

  const auctionMatch = reqUrl.pathname.match(/^\/api\/auctions\/([^/]+)(?:\/(start|pause|bids|events))?$/);
  if (auctionMatch) {
    const [, auctionId, action] = auctionMatch;
    if (req.method === "GET" && !action) {
      await withDbAuth(
        req,
        reqUrl,
        async (db, auth) => {
          const auction = listAuctions(db, auth).find((item) => item.id === auctionId);
          if (!auction) {
            sendJson(res, 404, { error: "拍卖不存在。" });
            return;
          }
          sendJson(res, 200, { auction });
        },
        res
      );
      return;
    }
    if (req.method === "POST" && action === "start") {
      try {
        const payload = await mutateDb((db) => {
          const auth = getAuth(db, getToken(req, reqUrl));
          return { auction: startAuction(db, auth, auctionId) };
        });
        await broadcastAuction(auctionId);
        await broadcastEventSnapshots();
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 400, { error: error.message || "启动拍卖失败。" });
      }
      return;
    }
    if (req.method === "POST" && action === "pause") {
      try {
        const payload = await mutateDb((db) => {
          const auth = getAuth(db, getToken(req, reqUrl));
          return { auction: pauseAuction(db, auth, auctionId) };
        });
        await broadcastAuction(auctionId);
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 400, { error: error.message || "暂停拍卖失败。" });
      }
      return;
    }
    if (req.method === "POST" && action === "bids") {
      try {
        const body = await readJson(req);
        const payload = await mutateDb((db) => {
          const auth = getAuth(db, getToken(req, reqUrl));
          return { auction: bid(db, auth, auctionId, body) };
        });
        await broadcastAuction(auctionId);
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 400, { error: error.message || "出价失败。" });
      }
      return;
    }
    if (req.method === "GET" && action === "events") {
      await withDbAuth(
        req,
        reqUrl,
        async (db, auth) => {
          const auction = listAuctions(db, auth).find((item) => item.id === auctionId);
          if (!auction) {
            sendJson(res, 404, { error: "拍卖不存在。" });
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          });
          const unregister = registerClient(auctionClients, auctionId, auth, res);
          writeSse(res, "auction.updated", auction);
          const event = db.events.find((item) => item.id === auction.eventId);
          writeSse(res, "event.updated", toEventSummary(db, event, auth));
          req.on("close", unregister);
        },
        res
      );
      return;
    }
  }

  if (req.method === "GET") {
    await serveStatic(reqUrl.pathname, res);
    return;
  }

  sendJson(res, 404, { error: "接口不存在。" });
});

ensureDb()
  .then(async () => {
    const db = await loadDb();
    const changed = settleExpiredAuctions(db);
    if (changed) {
      await saveDb(db);
    }
    server.listen(PORT, HOST, () => {
      console.log(`DCMS app listening on http://${HOST}:${PORT}`);
    });
    setInterval(settleAuctionsAndBroadcast, 1000);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
