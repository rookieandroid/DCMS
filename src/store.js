"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { summarizeRoom } = require("./draft");

const dataDir = path.join(__dirname, "..", "data", "rooms");

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

function roomPath(roomId) {
  return path.join(dataDir, `${roomId}.json`);
}

async function saveRoom(room) {
  await ensureDataDir();
  await fs.writeFile(roomPath(room.id), JSON.stringify(room, null, 2), "utf8");
}

async function loadRoom(roomId) {
  const content = await fs.readFile(roomPath(roomId), "utf8");
  return JSON.parse(content);
}

async function listRooms() {
  await ensureDataDir();
  const files = await fs.readdir(dataDir);
  const rooms = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        const content = await fs.readFile(path.join(dataDir, file), "utf8");
        return summarizeRoom(JSON.parse(content));
      })
  );
  return rooms.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

module.exports = {
  ensureDataDir,
  listRooms,
  loadRoom,
  saveRoom
};
