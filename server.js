const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

const sessions = new Map();
let queue = [];

function getPlayer(socket, profile) {
  if (!profile?.sessionId) return null;

  const sessionId = profile.sessionId;

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      username: profile.username || "Guest",
      rating: Number(profile.rating) || 1000,
      wins: 0,
      losses: 0,
      draws: 0,
      socketId: socket.id
    });
  }

  const player = sessions.get(sessionId);

  player.socketId = socket.id;
  player.username = profile.username || player.username;

  if (!Number.isNaN(Number(profile.rating))) {
    player.rating = Number(profile.rating);
  }

  return player;
}

function makeGameId() {
  return "game_" + Math.random().toString(36).slice(2, 10);
}

function ratingChange(winnerRating, loserRating) {
  const k = 24;
  const expected = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
  return Math.max(1, Math.round(k * (1 - expected)));
}

io.on("connection", (socket) => {
  socket.on("joinQueue", (profile) => {
    const player = getPlayer(socket, profile);
    if (!player) return;

    queue = queue.filter((p) => p.sessionId !== player.sessionId);

    const opponentIndex = queue.findIndex(
      (p) => p.sessionId !== player.sessionId
    );

    if (opponentIndex === -1) {
      queue.push(player);
      socket.emit("queueWaiting");
      return;
    }

    const opponent = queue.splice(opponentIndex, 1)[0];
    const gameId = makeGameId();

    io.to(player.socketId).emit("matchFound", {
      gameId,
      symbol: "O",
      sessionId: player.sessionId,
      opponentSessionId: opponent.sessionId,
      opponent: opponent.username,
      playerRating: player.rating,
      opponentRating: opponent.rating
    });

    io.to(opponent.socketId).emit("matchFound", {
      gameId,
      symbol: "X",
      sessionId: opponent.sessionId,
      opponentSessionId: player.sessionId,
      opponent: player.username,
      playerRating: opponent.rating,
      opponentRating: player.rating
    });
  });

  socket.on("leaveQueue", (profile) => {
    if (!profile?.sessionId) return;

    queue = queue.filter((p) => p.sessionId !== profile.sessionId);

    socket.emit("leftQueue");
  });

  socket.on("reportResult", ({ winnerSessionId, loserSessionId, draw }) => {
    const winner = sessions.get(winnerSessionId);
    const loser = sessions.get(loserSessionId);

    if (!winner || !loser) return;

    if (draw) {
      winner.draws += 1;
      loser.draws += 1;

      io.to(winner.socketId).emit("ratingUpdated", {
        rating: winner.rating,
        wins: winner.wins,
        losses: winner.losses,
        draws: winner.draws
      });

      io.to(loser.socketId).emit("ratingUpdated", {
        rating: loser.rating,
        wins: loser.wins,
        losses: loser.losses,
        draws: loser.draws
      });

      return;
    }

    const change = ratingChange(winner.rating, loser.rating);

    winner.rating += change;
    loser.rating = Math.max(0, loser.rating - change);

    winner.wins += 1;
    loser.losses += 1;

    io.to(winner.socketId).emit("ratingUpdated", {
      rating: winner.rating,
      wins: winner.wins,
      losses: winner.losses,
      draws: winner.draws,
      change: `+${change}`
    });

    io.to(loser.socketId).emit("ratingUpdated", {
      rating: loser.rating,
      wins: loser.wins,
      losses: loser.losses,
      draws: loser.draws,
      change: `-${change}`
    });
  });

  socket.on("disconnect", () => {
    queue = queue.filter((p) => p.socketId !== socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});