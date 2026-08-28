const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;

const app = express();

// Serve os arquivos da pasta public
app.use(express.static("public"));

// Página inicial
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const rooms = new Map();

function getRoomPeers(room) {
  if (!rooms.has(room)) rooms.set(room, new Map());
  return rooms.get(room);
}

io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("join", ({ room, name }) => {
    room = String((room || "").trim() || "geral").toLowerCase().slice(0, 40);
    name = String((name || "Anônimo").trim() || "Anônimo").slice(0, 24);

    currentRoom = room;
    socket.join(room);
    const peers = getRoomPeers(room);

    const existing = Array.from(peers.entries()).map(([id, info]) => ({
      id, name: info.name
    }));
    socket.emit("existing-peers", existing);

    peers.set(socket.id, { name });
    socket.to(room).emit("peer-joined", { id: socket.id, name });
  });

  socket.on("signal", ({ to, data }) => {
    if (!to) return;
    io.to(to).emit("signal", { from: socket.id, data });
  });

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

  socket.on("leave", leaveRoom);
  socket.on("disconnect", leaveRoom);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  console.log(`✅ Pronto pra receber conexões!`);
});
