"use strict";

function nowIso() {
  return new Date().toISOString();
}

function randomToken(length = 24) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnopqrstuvwxyz";
  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return result;
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function indexBy(items, key) {
  return Object.fromEntries(items.map((item) => [item[key], item]));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

module.exports = {
  asArray,
  clone,
  indexBy,
  makeId,
  nowIso,
  randomToken
};
