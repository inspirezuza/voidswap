import { WebSocketServer, WebSocket, RawData } from 'ws';
import { randomUUID } from 'crypto';
import type {
    ExtendedWebSocket, JoinedResponse, PeerJoined,
    MsgBroadcast,
    ErrorResponse,
    ErrorCode
} from './types.js';
import { parseMessage, isMessageTooLarge, isValidRoom } from './validate.js';

const PORT = 8787;

// Room -> Set of connected clients
const rooms = new Map<string, Set<ExtendedWebSocket>>();

// Simple logging
function log(event: string, details: Record<string, unknown> = {}) {
  const time = new Date().toISOString();
  console.log(`[${time}] ${event}`, Object.keys(details).length ? details : '');
}

// Send JSON message to client
function send(ws: WebSocket, message: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// Send error to client
function sendError(ws: WebSocket, code: ErrorCode, message: string) {
  const error: ErrorResponse = { type: 'error', code, message };
  send(ws, error);
  log('error', { code, message });
}

// Handle join message
function handleJoin(ws: ExtendedWebSocket, room: string) {
  // Leave previous room if any
  if (ws.state.joinedRoom) {
    const oldRoom = rooms.get(ws.state.joinedRoom);
    if (oldRoom) {
      oldRoom.delete(ws);
      if (oldRoom.size === 0) {
        rooms.delete(ws.state.joinedRoom);
      }
    }
  }

  // Join new room
  if (!rooms.has(room)) {
    rooms.set(room, new Set());
  }
  rooms.get(room)!.add(ws);
  ws.state.joinedRoom = room;

  // Compute memberCount
  const roomClients = rooms.get(room)!;
  const memberCount = roomClients.size;

  // Send ack to joining client with memberCount
  const response: JoinedResponse = {
    type: 'joined',
    room,
    clientId: ws.state.clientId,
    memberCount,
  };
  send(ws, response);

  // Broadcast peer_joined to all OTHER clients in the room
  const peerJoinedMsg: PeerJoined = {
    type: 'peer_joined',
    room,
    clientId: ws.state.clientId,
    memberCount,
  };
  for (const client of roomClients) {
    if (client !== ws) {
      send(client, peerJoinedMsg);
    }
  }

  log('join', { clientId: ws.state.clientId, room, memberCount });
}

// Handle msg (forward to peers)
function handleMsg(ws: ExtendedWebSocket, room: string, payload: unknown) {
  // Verify client is in the specified room
  if (ws.state.joinedRoom !== room) {
    sendError(ws, 'NOT_JOINED', 'You must join this room before sending messages');
    return;
  }

  const roomClients = rooms.get(room);
  if (!roomClients) {
    sendError(ws, 'NOT_JOINED', 'Room does not exist');
    return;
  }

  // Build broadcast message
  const broadcast: MsgBroadcast = {
    type: 'msg',
    room,
    from: ws.state.clientId,
    payload,
  };

  // Forward to all except sender
  let forwardCount = 0;
  for (const client of roomClients) {
    if (client !== ws) {
      send(client, broadcast);
      forwardCount++;
    }
  }

  log('forward', { from: ws.state.clientId, room, peers: forwardCount });
}

// Handle incoming message
function handleMessage(ws: ExtendedWebSocket, data: RawData) {
  const raw = data.toString();

  // Check size
  if (isMessageTooLarge(raw)) {
    sendError(ws, 'TOO_LARGE', 'Message exceeds 64KB limit');
    return;
  }

  // Parse message
  const msg = parseMessage(raw);
  if (!msg) {
    sendError(ws, 'BAD_MSG', 'Invalid message format');
    return;
  }

  // Validate room format again (defensive)
  if (!isValidRoom(msg.room)) {
    sendError(ws, 'BAD_ROOM', 'Invalid room name format');
    return;
  }

  // Route by type
  if (msg.type === 'join') {
    handleJoin(ws, msg.room);
  } else if (msg.type === 'msg') {
    if (!ws.state.joinedRoom) {
      sendError(ws, 'NOT_JOINED', 'You must join a room first');
      return;
    }
    handleMsg(ws, msg.room, msg.payload);
  }
}

// Handle client disconnect
function handleClose(ws: ExtendedWebSocket) {
  log('disconnect', { clientId: ws.state.clientId, room: ws.state.joinedRoom });

  // Remove from room
  if (ws.state.joinedRoom) {
    const room = rooms.get(ws.state.joinedRoom);
    if (room) {
      room.delete(ws);
      if (room.size === 0) {
        rooms.delete(ws.state.joinedRoom);
      }
    }
  }
}

// Create and start server
const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (socket: WebSocket) => {
  const ws = socket as ExtendedWebSocket;
  
  // Initialize client state
  ws.state = {
    clientId: randomUUID(),
    joinedRoom: null,
  };

  log('connect', { clientId: ws.state.clientId });

  ws.on('message', (data) => handleMessage(ws, data));
  ws.on('close', () => handleClose(ws));
  ws.on('error', (err) => log('error', { clientId: ws.state.clientId, error: err.message }));
});

log('server_start', { port: PORT, url: `ws://localhost:${PORT}` });
console.log(`\n🚀 WebSocket relay running at ws://localhost:${PORT}\n`);
