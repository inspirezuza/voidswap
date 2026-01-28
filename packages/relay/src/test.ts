/**
 * Smoke test script for WebSocket relay
 * Usage: pnpm test (or: npx tsx src/test.ts)
 */

import WebSocket from 'ws';

const URL = 'ws://localhost:8787';
const ROOM = 'test-room-123';

interface Message {
  type: string;
  room?: string;
  clientId?: string;
  from?: string;
  payload?: unknown;
  code?: string;
  message?: string;
}

function createClient(name: string): Promise<{ ws: WebSocket; clientId: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    
    ws.on('error', (err) => {
      console.error(`❌ ${name} connection error:`, err.message);
      reject(err);
    });

    ws.on('open', () => {
      console.log(`✅ ${name} connected`);
      
      // Join room
      ws.send(JSON.stringify({ type: 'join', room: ROOM }));
    });

    ws.on('message', (data) => {
      const msg: Message = JSON.parse(data.toString());
      
      if (msg.type === 'joined') {
        console.log(`✅ ${name} joined room "${msg.room}" as ${msg.clientId}`);
        resolve({ ws, clientId: msg.clientId! });
      } else if (msg.type === 'msg') {
        console.log(`📨 ${name} received message from ${msg.from}:`, msg.payload);
      } else if (msg.type === 'error') {
        console.log(`⚠️ ${name} error: [${msg.code}] ${msg.message}`);
      }
    });
  });
}

async function runTests() {
  console.log('\n🧪 WebSocket Relay Smoke Test\n');
  console.log(`Connecting to ${URL}...\n`);

  try {
    // Create two clients
    const clientA = await createClient('Client A');
    const clientB = await createClient('Client B');

    // Wait a bit for both to be ready
    await new Promise((r) => setTimeout(r, 200));

    // Test 1: Client A sends message to room
    console.log('\n📤 Client A sending message...');
    clientA.ws.send(JSON.stringify({
      type: 'msg',
      room: ROOM,
      payload: { greeting: 'Hello from A!' }
    }));

    // Wait for message to be received
    await new Promise((r) => setTimeout(r, 300));

    // Test 2: Client B sends message to room
    console.log('\n📤 Client B sending message...');
    clientB.ws.send(JSON.stringify({
      type: 'msg',
      room: ROOM,
      payload: { response: 'Hello back from B!' }
    }));

    // Wait for message to be received
    await new Promise((r) => setTimeout(r, 300));

    // Test 3: Error case - send msg to wrong room
    console.log('\n📤 Client A sending to wrong room (should error)...');
    clientA.ws.send(JSON.stringify({
      type: 'msg',
      room: 'other-room',
      payload: { test: 'wrong room' }
    }));

    await new Promise((r) => setTimeout(r, 300));

    // Cleanup
    console.log('\n🔌 Closing connections...');
    clientA.ws.close();
    clientB.ws.close();

    console.log('\n✅ All tests completed!\n');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exit(1);
  }
}

runTests();
