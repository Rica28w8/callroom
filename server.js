// server.js — servidor de sinalizacao WebRTC (mesh) + estatico do frontend
// Nao trafega audio/video/tela: isso vai direto entre os participantes (P2P).
// Este servidor so troca as mensagens de "apresentacao" (SDP/ICE) entre eles.

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }, // libera acesso mesmo se front e back ficarem em dominios diferentes
});

// room -> Map(socketId -> { name })
const rooms = new Map();

function getRoomPeers(room) {
  if (!rooms.has(room)) rooms.set(room, new Map());
  return rooms.get(room);
}

io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("join", ({ room, name }) => {
    room = String(room || "").trim().toLowerCase().slice(0, 40) || "geral";
    name = String(name || "Anonimo").trim().slice(0, 24) || "Anonimo";

    currentRoom = room;
    socket.join(room);

    const peers = getRoomPeers(room);

    // manda para o novo participante a lista de quem ja esta na sala
    const existing = Array.from(peers.entries()).map(([id, info]) => ({
      id,
      name: info.name,
    }));
    socket.emit("existing-peers", existing);

    peers.set(socket.id, { name });

    // avisa aos que ja estavam la que alguem novo chegou
    socket.to(room).emit("peer-joined", { id: socket.id, name });
  });

  // repassa sinalizacao WebRTC (offer/answer/ice) para o destinatario certo
  socket.on("signal", ({ to, data }) => {
    if (!to) return;
    io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("leave", () => leaveRoom());

  socket.on("disconnect", () => leaveRoom());

  function leaveRoom() {
    if (!currentRoom) return;
    const peers = rooms.get(currentRoom);
    if (peers) {
      peers.delete(socket.id);
      if (peers.size === 0) rooms.delete(currentRoom);
    }
    socket.to(currentRoom).emit("peer-left", { id: socket.id });
    socket.leave(currentRoom);
    currentRoom = null;
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CallRoom rodando em http://localhost:${PORT}`);
});
