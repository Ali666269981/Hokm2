const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    fs.readFile('index.html', (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end('Error loading index.html');
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocket.Server({ server });
let players = [];
let gameState = {};

function resetGameState() {
  gameState = {
    cards: [],
    player1Cards: [],
    player2Cards: [],
    trumpSuit: null,
    currentTrick: [],
    player1Tricks: 0,
    player2Tricks: 0,
    turn: 0,
    leadSuit: null
  };
}

resetGameState();

wss.on('connection', (ws) => {
  if (players.length < 2) {
    players.push(ws);
    ws.playerId = players.length;
    ws.send(JSON.stringify({ type: 'connected', playerId: ws.playerId, message: `خوش اومدی، بازیکن ${ws.playerId}!` }));
    console.log(`بازیکن ${ws.playerId} وصل شد`);

    if (players.length === 2) startGame();
  } else {
    ws.send(JSON.stringify({ type: 'error', message: 'بازی پر شده!' }));
    ws.close();
    return;
  }

  ws.on('message', (message) => {
    const data = JSON.parse(message);
    if (data.type === 'setTrump') {
      gameState.trumpSuit = data.suit;
      console.log(`خال حکم انتخاب شد: ${gameState.trumpSuit}`);
      broadcast({ type: 'trumpSet', suit: gameState.trumpSuit });
    } else if (data.type === 'playCard') {
      playCard(ws.playerId, data.card);
    } else if (data.type === 'restartGame') {
      if (gameState.player1Tricks < 7 && gameState.player2Tricks < 7) {
        ws.send(JSON.stringify({ type: 'error', message: 'بازی هنوز تمام نشده است!' }));
      } else {
        resetGameState();
        startGame();
      }
    } else if (data.type === 'chatMessage') {
      broadcast({ type: 'chatMessage', sender: ws.playerId, message: data.message });
    }
  });

  ws.on('close', () => {
    players = players.filter(p => p !== ws);
    console.log(`بازیکن ${ws.playerId} قطع شد`);
  });
});

function startGame() {
  const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let deck = [];
  for (let suit of suits) {
    for (let rank of ranks) {
      deck.push({ suit, rank });
    }
  }
  deck.sort(() => Math.random() - 0.5);
  deck = deck.slice(0, 26);

  gameState.cards = deck;
  gameState.player1Cards = deck.slice(0, 13);
  gameState.player2Cards = deck.slice(13, 26);
  gameState.turn = 1;

  console.log('بازی شروع شد!');
  console.log('دست بازیکن 1:', gameState.player1Cards.map(c => `${c.rank} ${c.suit}`));
  console.log('دست بازیکن 2:', gameState.player2Cards.map(c => `${c.rank} ${c.suit}`));

  players[0].send(JSON.stringify({ type: 'gameStart', cards: gameState.player1Cards, isRuler: true }));
  players[1].send(JSON.stringify({ type: 'gameStart', cards: gameState.player2Cards, isRuler: false }));
}

function playCard(playerId, card) {
  if (gameState.turn !== playerId) {
    players[playerId - 1].send(JSON.stringify({ type: 'error', message: 'نوبت شما نیست!' }));
    console.log(`بازیکن ${playerId} تلاش کرد در نوبتش بازی نکند`);
    return;
  }

  const playerCards = playerId === 1 ? gameState.player1Cards : gameState.player2Cards;

  if (!playerCards.some(c => c.rank === card.rank && c.suit === card.suit)) {
    players[playerId - 1].send(JSON.stringify({ type: 'error', message: 'این کارت توی دستت نیست!' }));
    console.log(`بازیکن ${playerId} سعی کرد کارت ناموجود (${card.rank} ${card.suit}) بازی کنه`);
    return;
  }

  if (gameState.currentTrick.length === 1) {
    const hasLeadSuit = playerCards.some(c => c.suit === gameState.leadSuit);
    if (hasLeadSuit && card.suit !== gameState.leadSuit && card.suit !== gameState.trumpSuit) {
      players[playerId - 1].send(JSON.stringify({ type: 'error', message: 'باید از خال شروع‌کننده بازی کنی!' }));
      console.log(`بازیکن ${playerId} نمی‌تونه ${card.rank} ${card.suit} بازی کنه چون از خال ${gameState.leadSuit} داره`);
      return;
    }
  }

  console.log(`بازیکن ${playerId} کارت ${card.rank} ${card.suit} رو بازی کرد`);

  if (gameState.currentTrick.length === 0) {
    gameState.leadSuit = card.suit;
    gameState.currentTrick.push({ playerId, card });
    updatePlayerCards(playerId, card);
    broadcast({ type: 'cardPlayed', playerId, card });
    gameState.turn = playerId === 1 ? 2 : 1;
  } else {
    gameState.currentTrick.push({ playerId, card });
    updatePlayerCards(playerId, card);
    broadcast({ type: 'cardPlayed', playerId, card });
    resolveTrick();
  }
}

function updatePlayerCards(playerId, card) {
  if (playerId === 1) {
    gameState.player1Cards = gameState.player1Cards.filter(c => c.rank !== card.rank || c.suit !== card.suit);
  } else {
    gameState.player2Cards = gameState.player2Cards.filter(c => c.rank !== card.rank || c.suit !== card.suit);
  }
  players[0].send(JSON.stringify({ type: 'updateCards', cards: gameState.player1Cards }));
  players[1].send(JSON.stringify({ type: 'updateCards', cards: gameState.player2Cards }));
}

function resolveTrick() {
  const [trick1, trick2] = gameState.currentTrick;
  const winner = determineWinner(trick1.card, trick2.card, trick1.playerId);
  
  console.log(`برنده ترفند: بازیکن ${winner} (کارت‌ها: ${trick1.card.rank} ${trick1.card.suit} vs ${trick2.card.rank} ${trick2.card.suit})`);
  
  if (winner === 1) gameState.player1Tricks++;
  else gameState.player2Tricks++;

  broadcast({
    type: 'trickResolved',
    winner,
    player1Tricks: gameState.player1Tricks,
    player2Tricks: gameState.player2Tricks
  });

  console.log(`امتیازها: بازیکن 1: ${gameState.player1Tricks}, بازیکن 2: ${gameState.player2Tricks}`);

  if (gameState.player1Tricks >= 7) {
    broadcast({ type: 'gameOver', winner: 1 });
    console.log('بازی تموم شد! برنده: بازیکن 1');
  } else if (gameState.player2Tricks >= 7) {
    broadcast({ type: 'gameOver', winner: 2 });
    console.log('بازی تموم شد! برنده: بازیکن 2');
  } else {
    gameState.currentTrick = [];
    gameState.leadSuit = null;
    gameState.turn = winner;
  }
}

function determineWinner(card1, card2, leadPlayer) {
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

  if (card1.suit === gameState.trumpSuit && card2.suit !== gameState.trumpSuit) {
    console.log(`بازیکن ${leadPlayer} برنده شد چون کارت ${card1.rank} ${card1.suit} (حکم) بازی کرد`);
    return leadPlayer;
  }
  if (card2.suit === gameState.trumpSuit && card1.suit !== gameState.trumpSuit) {
    const other = leadPlayer === 1 ? 2 : 1;
    console.log(`بازیکن ${other} برنده شد چون کارت ${card2.rank} ${card2.suit} (حکم) بازی کرد`);
    return other;
  }

  if (card1.suit === card2.suit) {
    const rank1Index = ranks.indexOf(card1.rank);
    const rank2Index = ranks.indexOf(card2.rank);
    console.log(`مقایسه: ${card1.rank} (${rank1Index}) vs ${card2.rank} (${rank2Index})`);
    return rank1Index > rank2Index ? leadPlayer : (leadPlayer === 1 ? 2 : 1);
  }

  console.log(`بازیکن ${leadPlayer} برنده شد چون بازیکن مقابل خال ${gameState.leadSuit} رو دنبال نکرد`);
  return leadPlayer;
}

function broadcast(message) {
  players.forEach(p => p.send(JSON.stringify(message)));
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`سرور در پورت ${PORT} فعال است`);
});