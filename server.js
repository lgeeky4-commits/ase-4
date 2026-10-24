"use strict";
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1200000 });
const PORT = process.env.PORT || 3000;
const MAX_USERS = 3;
const users = new Map(); // socket id -> {name}
const roomState = new Map(); // room id -> {messages, annotations}
const liveSessions = new Map(); // broadcaster socket id -> Set of authorized viewers
const lastPhotoAt = new Map();
app.use(express.static(path.join(__dirname, "public")));

function trim(v, max) { return typeof v === "string" ? v.trim().slice(0, max) : ""; }
function roster() { return [...users].map(([id, u]) => ({id, name:u.name, live:liveSessions.has(id)})); }
function stopLive(id) {
  const watchers = liveSessions.get(id);
  if (!watchers) return;
  liveSessions.delete(id);
  io.emit("live:ended", {hostId:id});
  sendUsers();
}
function privateId(a, b) { return `dm:${[a,b].sort().join(":")}`; }
function roomFor(socket, requested) {
  if (!users.has(socket.id)) return null;
  if (requested === "public") return "public";
  const peer = [...users.keys()].find(id => id === requested);
  return peer && peer !== socket.id ? privateId(socket.id, peer) : null;
}
function state(room) {
  if (!roomState.has(room)) roomState.set(room, { messages: [], annotations: [] });
  return roomState.get(room);
}
function pushLimited(arr, item, max) { arr.push(item); if (arr.length > max) arr.shift(); }
function sendUsers() { io.emit("users", roster()); }
function ack(reply, result) { if (typeof reply === "function") reply(result); }
function validRefPoint(p) {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) &&
    p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
}
function normalizePoints(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 30 || !input.every(validRefPoint)) return null;
  return input.map(p => ({x:p.x, y:p.y}));
}

io.on("connection", socket => {
  socket.emit("hello", { maxUsers: MAX_USERS });
  socket.on("join", (nameValue, reply) => {
    if (users.has(socket.id)) { ack(reply, {ok:true, id:socket.id}); return; }
    if (users.size >= MAX_USERS) { ack(reply, {ok:false, error:"This chat already has three connected people."}); return; }
    const name = trim(nameValue, 20).replace(/\s+/g, " ");
    if (!name || name.length < 2) { ack(reply, {ok:false, error:"Enter a name (at least 2 characters)."}); return; }
    if ([...users.values()].some(u => u.name.toLowerCase() === name.toLowerCase())) {
      ack(reply, {ok:false, error:"That name is already taken."}); return;
    }
    users.set(socket.id, {name});
    socket.join("public");
    // Pair rooms are joined on the server for both peers, so private events go only to that pair.
    for (const id of users.keys()) {
      if (id === socket.id) continue;
      const room = privateId(socket.id, id);
      socket.join(room);
      io.sockets.sockets.get(id)?.join(room);
    }
    ack(reply, {ok:true, id:socket.id, name});
    sendUsers();
  });

  socket.on("room:load", (key, reply) => {
    const room = roomFor(socket, key);
    if (!room) return ack(reply, {ok:false, error:"Conversation unavailable."});
    const s = state(room);
    ack(reply, {ok:true, messages:s.messages, annotations:s.annotations});
  });

  socket.on("message:send", (data, reply) => {
    const room = roomFor(socket, data?.to);
    const text = trim(data?.text, 1500);
    if (!room || !text) return ack(reply, {ok:false, error:"Message was not sent."});
    const item = {id:crypto.randomUUID(), userId:socket.id, name:users.get(socket.id).name, text, time:Date.now()};
    pushLimited(state(room).messages, item, 200);
    io.to(room).emit("message:new", {room, item});
    ack(reply, {ok:true});
  });

  // Photos are resized to JPEG in the browser. Accept only bounded JPEG data URLs:
  // no SVG/HTML uploads or arbitrary files, and no cross-room forwarding.
  socket.on("message:photo", (data, reply) => {
    const room = roomFor(socket, data?.to);
    if (!room) return ack(reply, {ok:false, error:"Conversation unavailable."});
    const photo = data?.photo;
    if (typeof photo !== "string" || photo.length > 900000 ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(photo)) {
      return ack(reply, {ok:false, error:"Only compressed JPEG images up to 650 KB can be sent."});
    }
    const now = Date.now();
    if (now - (lastPhotoAt.get(socket.id) || 0) < 2000) {
      return ack(reply, {ok:false, error:"Wait two seconds before sending another photo."});
    }
    lastPhotoAt.set(socket.id, now);
    const item = {id:crypto.randomUUID(), userId:socket.id, name:users.get(socket.id).name,
      type:"photo", photo, caption:trim(data?.caption, 200), time:now};
    const history = state(room).messages;
    pushLimited(history, item, 100);
    // Bound memory use even when users send many compressed photos.
    while (history.filter(m => m.type === "photo").length > 10) {
      const ix = history.findIndex(m => m.type === "photo");
      history.splice(ix, 1);
    }
    io.to(room).emit("message:new", {room, item});
    ack(reply, {ok:true});
  });

  // Browser WebRTC video: Socket.IO carries signaling ONLY, not the video itself.
  // A viewer must explicitly request a broadcast and the host must be live.
  socket.on("live:start", (_data, reply) => {
    if (!users.has(socket.id)) return ack(reply, {ok:false, error:"Join the chat first."});
    if (!liveSessions.has(socket.id)) liveSessions.set(socket.id, new Set());
    sendUsers();
    ack(reply, {ok:true});
  });
  socket.on("live:stop", (_data, reply) => {
    if (!users.has(socket.id)) return ack(reply, {ok:false});
    stopLive(socket.id);
    ack(reply, {ok:true});
  });
  socket.on("live:watch", (data, reply) => {
    const hostId = data?.hostId;
    if (!users.has(socket.id) || typeof hostId !== "string" || hostId === socket.id ||
        !liveSessions.has(hostId) || !users.has(hostId)) {
      return ack(reply, {ok:false, error:"This broadcast is no longer available."});
    }
    liveSessions.get(hostId).add(socket.id);
    io.to(hostId).emit("live:viewer:joined", {viewerId:socket.id});
    ack(reply, {ok:true});
  });
  socket.on("live:leave", (data) => {
    const hostId = data?.hostId;
    if (!liveSessions.has(hostId)) return;
    liveSessions.get(hostId).delete(socket.id);
    io.to(hostId).emit("live:viewer:left", {viewerId:socket.id});
  });
  socket.on("live:signal", (data) => {
    const to = data?.to;
    const signal = data?.signal;
    if (!users.has(socket.id) || typeof to !== "string" || !users.has(to) ||
        !signal || typeof signal !== "object" || Array.isArray(signal)) return;
    const fromHost = liveSessions.get(socket.id)?.has(to);
    const toHost = liveSessions.get(to)?.has(socket.id);
    if (!fromHost && !toHost) return;
    if (signal.type !== "offer" && signal.type !== "answer" && signal.type !== "ice") return;
    // Reject unbounded or malformed signaling payloads.
    if (JSON.stringify(signal).length > 20000) return;
    io.to(to).emit("live:signal", {from:socket.id, signal});
  });

  socket.on("map:add", (data, reply) => {
    const room = roomFor(socket, data?.to);
    const base = "reference";
    const kind = data?.kind === "path" ? "path" : "pin";
    const points = normalizePoints(data?.points);
    const note = trim(data?.note, 240);
    if (!room || !points || (kind === "path" && points.length < 2) || (kind === "pin" && points.length !== 1)) {
      return ack(reply, {ok:false, error:"Invalid map annotation."});
    }
    const item = {id:crypto.randomUUID(), userId:socket.id, name:users.get(socket.id).name,
      kind, base, points, note, time:Date.now()};
    pushLimited(state(room).annotations, item, 120);
    io.to(room).emit("map:new", {room, item});
    ack(reply, {ok:true});
  });

  socket.on("map:delete", (data, reply) => {
    const room = roomFor(socket, data?.to);
    if (!room) return ack(reply, {ok:false});
    const s = state(room);
    const idx = s.annotations.findIndex(item => item.id === data?.id && item.userId === socket.id);
    if (idx < 0) return ack(reply, {ok:false, error:"You can remove only your own markers and paths."});
    const [removed] = s.annotations.splice(idx, 1);
    io.to(room).emit("map:removed", {room, id:removed.id});
    ack(reply, {ok:true});
  });

  socket.on("disconnect", () => {
    if (!users.has(socket.id)) return;
    users.delete(socket.id);
    lastPhotoAt.delete(socket.id);
    stopLive(socket.id);
    for (const [hostId, watchers] of liveSessions) {
      if (watchers.delete(socket.id)) io.to(hostId).emit("live:viewer:left", {viewerId:socket.id});
    }
    // Socket IDs are temporary: discard private conversation state when a member leaves.
    for (const key of [...roomState.keys()]) if (key.startsWith("dm:") && key.split(":").includes(socket.id)) roomState.delete(key);
    sendUsers();
  });
});
server.listen(PORT, "0.0.0.0", () => console.log(`Crimson Chat running on port ${PORT}`));
