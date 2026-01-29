/**
 * Party Games Multiplayer Server
 * WebSocket-based game server for iOS/macOS Party Games
 *
 * Features:
 * - Matchmaking queue (4 players per game)
 * - Game state synchronization
 * - Player input relay
 * - Automatic cleanup of disconnected players
 */

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const PLAYERS_PER_GAME = 4;
const TICK_RATE = 20;
const GAME_TIMEOUT = 120000;

// Message types
const MSG = {
    JOIN_QUEUE: 'join_queue',
    LEAVE_QUEUE: 'leave_queue',
    PLAYER_INPUT: 'player_input',
    READY: 'ready',
    QUEUE_STATUS: 'queue_status',
    MATCH_FOUND: 'match_found',
    GAME_START: 'game_start',
    GAME_STATE: 'game_state',
    PLAYER_LEFT: 'player_left',
    GAME_END: 'game_end',
    ERROR: 'error'
};

const MINIGAMES = [
    'bumper_balls', 'hot_rope_jump', 'mushroom_mixup', 'snowball_summit',
    'shy_guy_says', 'bombs_away', 'pushy_penguins', 'hexagon_heat',
    'bounce_trounce', 'coin_block_blitz', 'burnstile'
];

// Server state
const matchmakingQueue = [];
const activeGames = new Map();
const playerSessions = new Map();
let gameIdCounter = 1;

class Player {
    constructor(ws, username) {
        this.id = Math.random().toString(36).substr(2, 9);
        this.ws = ws;
        this.username = username || `Player_${this.id.substr(0, 4)}`;
        this.gameId = null;
        this.playerIndex = -1;
        this.ready = false;
        this.lastInput = { x: 0, z: 0, jump: false, action: false };
        this.position = { x: 0, y: 0, z: 0 };
        this.velocity = { x: 0, y: 0, z: 0 };
        this.alive = true;
        this.score = 0;
    }

    send(type, data = {}) {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type, ...data }));
        }
    }
}

class Game {
    constructor(players, minigameType) {
        this.id = gameIdCounter++;
        this.players = players;
        this.minigameType = minigameType;
        this.minigameName = MINIGAMES[minigameType];
        this.state = 'waiting';
        this.tick = 0;
        this.timer = 60;
        this.countdown = 3;
        this.randomSeed = Math.floor(Math.random() * 1000000);

        players.forEach((player, index) => {
            player.gameId = this.id;
            player.playerIndex = index;
            player.alive = true;
            player.score = 0;
            const angle = (index / players.length) * Math.PI * 2;
            player.position = { x: Math.cos(angle) * 3, y: 0.5, z: Math.sin(angle) * 3 };
            player.velocity = { x: 0, y: 0, z: 0 };
        });
    }

    broadcast(type, data = {}) {
        this.players.forEach(player => player.send(type, data));
    }

    getState() {
        return {
            tick: this.tick,
            timer: this.timer,
            state: this.state,
            players: this.players.map(p => ({
                id: p.id, index: p.playerIndex, username: p.username,
                alive: p.alive, score: p.score, position: p.position, velocity: p.velocity
            }))
        };
    }

    start() {
        this.state = 'countdown';
        this.countdown = 3;

        this.broadcast(MSG.GAME_START, {
            gameId: this.id,
            minigame: this.minigameName,
            minigameType: this.minigameType,
            seed: this.randomSeed,
            players: this.players.map(p => ({ id: p.id, index: p.playerIndex, username: p.username }))
        });

        this.interval = setInterval(() => this.update(), 1000 / TICK_RATE);
        this.timeout = setTimeout(() => this.end('timeout'), GAME_TIMEOUT);
    }

    update() {
        this.tick++;

        if (this.state === 'countdown') {
            this.countdown -= 1 / TICK_RATE;
            if (this.countdown <= 0) {
                this.state = 'playing';
                this.timer = 60;
            }
        } else if (this.state === 'playing') {
            this.timer -= 1 / TICK_RATE;

            this.players.forEach(player => {
                if (!player.alive) return;
                const input = player.lastInput;
                player.velocity.x += input.x * 0.5;
                player.velocity.z += input.z * 0.5;
                player.velocity.x *= 0.95;
                player.velocity.z *= 0.95;
                player.position.x += player.velocity.x * (1 / TICK_RATE);
                player.position.z += player.velocity.z * (1 / TICK_RATE);
            });

            const alivePlayers = this.players.filter(p => p.alive);
            if (alivePlayers.length <= 1 || this.timer <= 0) {
                this.end('normal');
                return;
            }
        }

        this.broadcast(MSG.GAME_STATE, this.getState());
    }

    handleInput(player, input) {
        if (this.state !== 'playing' || !player.alive) return;
        player.lastInput = {
            x: Math.max(-1, Math.min(1, input.x || 0)),
            z: Math.max(-1, Math.min(1, input.z || 0)),
            jump: !!input.jump,
            action: !!input.action
        };
    }

    removePlayer(player) {
        player.alive = false;
        player.gameId = null;
        this.broadcast(MSG.PLAYER_LEFT, { playerId: player.id, playerIndex: player.playerIndex });

        const remaining = this.players.filter(p => p.alive && p.ws.readyState === WebSocket.OPEN);
        if (remaining.length < 2) this.end('disconnect');
    }

    end(reason) {
        if (this.state === 'ended') return;
        this.state = 'ended';

        clearInterval(this.interval);
        clearTimeout(this.timeout);

        const placements = this.players
            .filter(p => p.ws.readyState === WebSocket.OPEN)
            .sort((a, b) => (b.alive - a.alive) || (b.score - a.score))
            .map((p, i) => ({ playerId: p.id, placement: i + 1, score: p.score }));

        this.broadcast(MSG.GAME_END, { reason, placements });

        this.players.forEach(p => { p.gameId = null; p.playerIndex = -1; });
        activeGames.delete(this.id);
        console.log(`[Game ${this.id}] Ended: ${reason}`);
    }
}

// HTTP server for health checks
const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            playersInQueue: matchmakingQueue.length,
            activeGames: activeGames.size,
            connectedPlayers: playerSessions.size
        }));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <html>
            <head><title>Party Games Server</title></head>
            <body style="font-family: system-ui; padding: 40px; background: #1a1a2e; color: white;">
                <h1>Party Games Server</h1>
                <p>WebSocket endpoint: <code>ws://${req.headers.host}</code></p>
                <h3>Status</h3>
                <ul>
                    <li>Players in queue: ${matchmakingQueue.length}</li>
                    <li>Active games: ${activeGames.size}</li>
                    <li>Connected players: ${playerSessions.size}</li>
                </ul>
            </body>
            </html>
        `);
    }
});

// WebSocket server (share HTTP server)
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws) => {
    const player = new Player(ws);
    playerSessions.set(ws, player);
    console.log(`[${player.id}] Connected`);

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            handleMessage(player, msg);
        } catch (e) {
            console.error('Invalid message:', e);
        }
    });

    ws.on('close', () => {
        console.log(`[${player.id}] Disconnected`);
        handleDisconnect(player);
        playerSessions.delete(ws);
    });

    ws.on('error', (err) => console.error(`[${player.id}] Error:`, err.message));
});

function handleMessage(player, msg) {
    switch (msg.type) {
        case MSG.JOIN_QUEUE: joinQueue(player, msg.username); break;
        case MSG.LEAVE_QUEUE: leaveQueue(player); break;
        case MSG.PLAYER_INPUT:
            if (player.gameId) {
                const game = activeGames.get(player.gameId);
                if (game) game.handleInput(player, msg);
            }
            break;
        case MSG.READY:
            player.ready = true;
            checkAllReady(player);
            break;
    }
}

function joinQueue(player, username) {
    if (matchmakingQueue.includes(player) || player.gameId) return;

    player.username = username || player.username;
    matchmakingQueue.push(player);
    console.log(`[${player.id}] Joined queue as "${player.username}" (${matchmakingQueue.length}/${PLAYERS_PER_GAME})`);

    broadcastQueueStatus();
    tryStartMatch();
}

function leaveQueue(player) {
    const index = matchmakingQueue.indexOf(player);
    if (index !== -1) {
        matchmakingQueue.splice(index, 1);
        console.log(`[${player.id}] Left queue`);
        broadcastQueueStatus();
    }
}

function broadcastQueueStatus() {
    matchmakingQueue.forEach(player => {
        player.send(MSG.QUEUE_STATUS, {
            position: matchmakingQueue.indexOf(player) + 1,
            playersInQueue: matchmakingQueue.length,
            playersNeeded: PLAYERS_PER_GAME
        });
    });
}

function tryStartMatch() {
    if (matchmakingQueue.length >= PLAYERS_PER_GAME) {
        const players = matchmakingQueue.splice(0, PLAYERS_PER_GAME);
        const minigameType = Math.floor(Math.random() * MINIGAMES.length);

        const game = new Game(players, minigameType);
        activeGames.set(game.id, game);

        console.log(`[Game ${game.id}] Created - ${MINIGAMES[minigameType]} with ${players.map(p => p.username).join(', ')}`);

        players.forEach(player => {
            player.send(MSG.MATCH_FOUND, {
                gameId: game.id,
                minigame: game.minigameName,
                players: players.map(p => ({ id: p.id, index: p.playerIndex, username: p.username }))
            });
        });

        setTimeout(() => { if (game.state === 'waiting') game.start(); }, 2000);
    }
}

function checkAllReady(player) {
    if (!player.gameId) return;
    const game = activeGames.get(player.gameId);
    if (!game || game.state !== 'waiting') return;
    if (game.players.every(p => p.ready)) game.start();
}

function handleDisconnect(player) {
    leaveQueue(player);
    if (player.gameId) {
        const game = activeGames.get(player.gameId);
        if (game) game.removePlayer(player);
    }
}

// Start server
httpServer.listen(PORT, () => {
    console.log(`Party Games Server running on port ${PORT}`);
    console.log(`HTTP: http://localhost:${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});
