const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  "https://tictactoeinfinity.netlify.app",
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

const sessions = new Map();
let queue = [];
const pendingMatches = new Map();
const games = new Map();

function getPlayer(socket, profile) {
  if (!profile?.sessionId) return null;

  const sessionId = profile.sessionId;

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      username: profile.username || "Guest",
      rating: Number(profile.rating) || 1000,
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

function makeEmptyGame(match) {
  return {
    gameId: match.gameId,
    xSessionId: match.x.sessionId,
    oSessionId: match.o.sessionId,
    xName: match.x.username,
    oName: match.o.username,
    board: Array(9).fill(""),
    xMoves: [],
    oMoves: [],
    currentTurn: "X",
    gameOver: false,
    winner: null,
    rematchVotes: new Set()
  };
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.on("joinQueue", (profile) => {
    const player = getPlayer(socket, profile);
    if (!player) return;

    queue = queue.filter((p) => p.sessionId !== player.sessionId);

    const opponentIndex = queue.findIndex((p) => p.sessionId !== player.sessionId);

    if (opponentIndex === -1) {
      queue.push(player);
      socket.emit("queueWaiting");
      return;
    }

    const opponent = queue.splice(opponentIndex, 1)[0];
    const gameId = makeGameId();

    const match = {
      gameId,
      x: opponent,
      o: player,
      accepted: new Set()
    };

    pendingMatches.set(gameId, match);

    io.to(opponent.socketId).emit("matchFound", {
      gameId,
      symbol: "X",
      sessionId: opponent.sessionId,
      opponentSessionId: player.sessionId,
      opponent: player.username
    });

    io.to(player.socketId).emit("matchFound", {
      gameId,
      symbol: "O",
      sessionId: player.sessionId,
      opponentSessionId: opponent.sessionId,
      opponent: opponent.username
    });
  });

  socket.on("leaveQueue", (profile) => {
    if (!profile?.sessionId) return;
    queue = queue.filter((p) => p.sessionId !== profile.sessionId);
    socket.emit("leftQueue");
  });

  socket.on("acceptMatch", ({ gameId, sessionId }) => {
    const match = pendingMatches.get(gameId);
    if (!match) return;

    match.accepted.add(sessionId);

    const other =
      match.x.sessionId === sessionId ? match.o : match.x;

    socket.emit("waitingForOpponentAccept");

    if (match.accepted.has(match.x.sessionId) && match.accepted.has(match.o.sessionId)) {
      const game = makeEmptyGame(match);
      games.set(gameId, game);
      pendingMatches.delete(gameId);

      io.to(match.x.socketId).emit("startOnlineGame", {
        gameId,
        symbol: "X",
        opponent: match.o.username,
        xName: match.x.username,
        oName: match.o.username,
        sessionId: match.x.sessionId,
        opponentSessionId: match.o.sessionId
      });

      io.to(match.o.socketId).emit("startOnlineGame", {
        gameId,
        symbol: "O",
        opponent: match.x.username,
        xName: match.x.username,
        oName: match.o.username,
        sessionId: match.o.sessionId,
        opponentSessionId: match.x.sessionId
      });
    }
  });

  socket.on("joinGameRoom", ({ gameId }) => {
    socket.join(gameId);
    const game = games.get(gameId);

    if (game) {
      socket.emit("gameState", game);
    }
  });

  socket.on("playerMove", ({ gameId, sessionId, index }) => {
    const game = games.get(gameId);
    if (!game || game.gameOver) return;

    const symbol = sessionId === game.xSessionId ? "X" : sessionId === game.oSessionId ? "O" : null;
    if (!symbol) return;
    if (symbol !== game.currentTurn) return;
    if (game.board[index] !== "") return;

    const moves = symbol === "X" ? game.xMoves : game.oMoves;

    if (moves.length >= 3) {
      const oldest = moves.shift();
      game.board[oldest] = "";
    }

    game.board[index] = symbol;
    moves.push(index);

    const winLines = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8],
      [0, 3, 6], [1, 4, 7], [2, 5, 8],
      [0, 4, 8], [2, 4, 6]
    ];

    for (const line of winLines) {
      const [a, b, c] = line;

      if (game.board[a] === symbol && game.board[b] === symbol && game.board[c] === symbol) {
        game.gameOver = true;
        game.winner = symbol;
        game.winningLine = line;
      }
    }

    if (!game.gameOver) {
      game.currentTurn = game.currentTurn === "X" ? "O" : "X";
    }

    io.to(gameId).emit("gameState", game);
  });

  socket.on("requestRematch", ({ gameId, sessionId }) => {
    const game = games.get(gameId);
    if (!game) return;

    game.rematchVotes.add(sessionId);

    if (
      game.rematchVotes.has(game.xSessionId) &&
      game.rematchVotes.has(game.oSessionId)
    ) {
      game.board = Array(9).fill("");
      game.xMoves = [];
      game.oMoves = [];
      game.currentTurn = "X";
      game.gameOver = false;
      game.winner = null;
      game.winningLine = null;
      game.rematchVotes.clear();

      io.to(gameId).emit("rematchStarted", game);
      io.to(gameId).emit("gameState", game);
    } else {
      socket.to(gameId).emit("opponentWantsRematch");
      socket.emit("waitingForRematch");
    }
  });

  socket.on("leaveGame", ({ gameId }) => {
    socket.to(gameId).emit("opponentLeft");
  });

  socket.on("disconnect", () => {
    queue = queue.filter((p) => p.socketId !== socket.id);
    console.log("Player disconnected:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});