require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const redis = require('redis');
const cors = require('cors');
const url = require('url');

// Import Schemas
const Agent = require('./models/Agent');
const CallLog = require('./models/CallLog');

const PORT = process.env.PORT || 5000;
const app = express();

app.use(cors());
app.use(express.json());

// ----------------------------------------------------
// 1. Database Connection & Failover Layer
// ----------------------------------------------------
const mongoURI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/call_center_db';

// Quick fail timeout of 5s to trigger local sandbox memory fallbacks immediately if Mongo is inactive
mongoose.connect(mongoURI, { serverSelectionTimeoutMS: 5000 })
  .then(async () => {
    console.log(`[MongoDB] Connected successfully to ${mongoURI}`);
    await seedMockData();
  })
  .catch(err => {
    console.error('[MongoDB] Connection timeout / error:', err.message);
    console.warn('[MongoDB] Initializing In-Memory Fallback Database for sandbox mode.');
    seedMockDataInMemory();
  });

// Check if mongoose is actively connected
const useMongo = () => mongoose.connection.readyState === 1;

// In-Memory collections for database failover
const mockAgents = new Map();
const mockCallLogs = [];

// Helper functions for Agent actions
const findAgentByUserId = async (userId) => {
  if (useMongo()) {
    try {
      return await Agent.findOne({ userId });
    } catch (e) {
      console.error('[DB Failover] Mongoose Agent.findOne error:', e.message);
    }
  }
  return mockAgents.get(userId) || null;
};

const updateAgentStatus = async (userId, updateFields) => {
  if (useMongo()) {
    try {
      return await Agent.findOneAndUpdate({ userId }, updateFields, { new: true, upsert: true });
    } catch (e) {
      console.error('[DB Failover] Mongoose Agent.findOneAndUpdate error:', e.message);
    }
  }
  let agent = mockAgents.get(userId);
  if (!agent) {
    agent = { 
      _id: `MOCK_AGENT_ID_${userId.toUpperCase()}`,
      userId, 
      name: `User ${userId}`, 
      role: 'agent', 
      status: 'Offline', 
      lastStatusChange: new Date() 
    };
  }
  agent = { ...agent, ...updateFields };
  mockAgents.set(userId, agent);
  return agent;
};

// Helper functions for CallLog actions
const countCallLogs = async (query) => {
  if (useMongo()) {
    try {
      return await CallLog.countDocuments(query);
    } catch (e) {
      console.error('[DB Failover] Mongoose CallLog.countDocuments error:', e.message);
    }
  }
  return mockCallLogs.filter(log => {
    if (query.agentId && String(log.agentId) !== String(query.agentId)) return false;
    if (query.direction && log.direction !== query.direction) return false;
    if (query.status && log.status !== query.status) return false;
    return true;
  }).length;
};

const findCallLogs = async (query, skip, limit) => {
  if (useMongo()) {
    try {
      return await CallLog.find(query)
        .populate('agentId', 'userId name role')
        .sort({ startTime: -1 })
        .skip(skip)
        .limit(limit);
    } catch (e) {
      console.error('[DB Failover] Mongoose CallLog.find error:', e.message);
    }
  }
  
  // Filter mock logs
  let filtered = mockCallLogs.filter(log => {
    if (query.agentId && String(log.agentId) !== String(query.agentId)) return false;
    if (query.direction && log.direction !== query.direction) return false;
    if (query.status && log.status !== query.status) return false;
    return true;
  });
  
  // Sort descending
  filtered.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  
  // Slice
  const sliced = filtered.slice(skip, skip + limit);
  
  // Populate agentId field
  return sliced.map(log => {
    let matchedAgent = null;
    if (log.agentId) {
      for (const agent of mockAgents.values()) {
        if (String(agent._id) === String(log.agentId)) {
          matchedAgent = agent;
          break;
        }
      }
    }
    return {
      ...log,
      agentId: matchedAgent ? { userId: matchedAgent.userId, name: matchedAgent.name, role: matchedAgent.role } : null
    };
  });
};

const aggregatePerformance = async () => {
  if (useMongo()) {
    try {
      return await CallLog.aggregate([
        {
          $group: {
            _id: "$agentId",
            totalCalls: { $sum: 1 },
            answeredCalls: {
              $sum: { $cond: [{ $eq: ["$status", "Answered"] }, 1, 0] }
            },
            missedCalls: {
              $sum: { $cond: [{ $eq: ["$status", "Missed"] }, 1, 0] }
            },
            totalDuration: { $sum: "$durationInSeconds" },
            avgDuration: { $avg: "$durationInSeconds" }
          }
        },
        {
          $lookup: {
            from: "agents",
            localField: "_id",
            foreignField: "_id",
            as: "agentInfo"
          }
        },
        {
          $unwind: {
            path: "$agentInfo",
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $project: {
            agentId: "$_id",
            name: { $ifNull: ["$agentInfo.name", "Unassigned Queue"] },
            userId: { $ifNull: ["$agentInfo.userId", "unassigned"] },
            role: { $ifNull: ["$agentInfo.role", "agent"] },
            totalCalls: 1,
            answeredCalls: 1,
            missedCalls: 1,
            totalDuration: 1,
            avgDuration: { $round: ["$avgDuration", 2] }
          }
        },
        {
          $sort: { totalCalls: -1 }
        }
      ]);
    } catch (e) {
      console.error('[DB Failover] Mongoose CallLog.aggregate error:', e.message);
    }
  }

  // Aggregate memory logs
  const groups = {};
  mockCallLogs.forEach(log => {
    const key = log.agentId ? String(log.agentId) : 'unassigned';
    if (!groups[key]) {
      groups[key] = {
        agentDbId: log.agentId,
        totalCalls: 0,
        answeredCalls: 0,
        missedCalls: 0,
        totalDuration: 0,
        durations: []
      };
    }
    const group = groups[key];
    group.totalCalls++;
    if (log.status === 'Answered') group.answeredCalls++;
    if (log.status === 'Missed') group.missedCalls++;
    group.totalDuration += log.durationInSeconds;
    group.durations.push(log.durationInSeconds);
  });

  return Object.values(groups).map((group) => {
    let matchedAgent = null;
    if (group.agentDbId) {
      for (const agent of mockAgents.values()) {
        if (String(agent._id) === String(group.agentDbId)) {
          matchedAgent = agent;
          break;
        }
      }
    }
    const avgDuration = group.durations.length > 0 
      ? group.durations.reduce((a, b) => a + b, 0) / group.durations.length 
      : 0;
    
    return {
      agentId: group.agentDbId || null,
      name: matchedAgent ? matchedAgent.name : 'Unassigned Queue',
      userId: matchedAgent ? matchedAgent.userId : 'unassigned',
      role: matchedAgent ? matchedAgent.role : 'agent',
      totalCalls: group.totalCalls,
      answeredCalls: group.answeredCalls,
      missedCalls: group.missedCalls,
      totalDuration: group.totalDuration,
      avgDuration: Math.round(avgDuration * 100) / 100
    };
  }).sort((a, b) => b.totalCalls - a.totalCalls);
};

const saveCallLog = async (logData) => {
  if (useMongo()) {
    try {
      const newCall = new CallLog(logData);
      return await newCall.save();
    } catch (e) {
      console.error('[DB Failover] Mongoose CallLog.save error:', e.message);
    }
  }
  const mockLog = {
    _id: `MOCK-CDR-${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
    ...logData,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  mockCallLogs.push(mockLog);
  return mockLog;
};

// ----------------------------------------------------
// 2. Redis Caching with In-Memory Hot Standby
// ----------------------------------------------------
let redisClient = null;
let useInMemoryCache = false;
const inMemoryCache = new Map();

const redisURL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
redisClient = redis.createClient({ url: redisURL });

redisClient.on('error', (err) => {
  if (!useInMemoryCache) {
    console.warn(`[Redis] Connection failed (${err.message}). Falling back to local In-Memory State Cache.`);
    useInMemoryCache = true;
  }
});

redisClient.connect()
  .then(() => {
    console.log(`[Redis] Connected successfully to ${redisURL}`);
    useInMemoryCache = false;
  })
  .catch((err) => {
    console.warn(`[Redis] Setup warning: ${err.message}. Initializing in-memory state fallback.`);
    useInMemoryCache = true;
  });

// Unified Presence Cache Interface
const presenceCache = {
  async setAgentState(userId, stateObject) {
    const dataString = JSON.stringify(stateObject);
    // Always update inMemoryCache as a hot fallback!
    inMemoryCache.set(userId, dataString);
    if (useInMemoryCache) {
      return true;
    }
    try {
      await redisClient.hSet('agent_presence', userId, dataString);
      return true;
    } catch (err) {
      console.error('[Redis] Error setting agent state:', err.message);
      return false;
    }
  },

  async getAgentState(userId) {
    if (useInMemoryCache) {
      const state = inMemoryCache.get(userId);
      return state ? JSON.parse(state) : null;
    }
    try {
      const state = await redisClient.hGet('agent_presence', userId);
      return state ? JSON.parse(state) : null;
    } catch (err) {
      console.error('[Redis] Error getting agent state:', err.message);
      const state = inMemoryCache.get(userId);
      return state ? JSON.parse(state) : null;
    }
  },

  async getAllAgents() {
    if (useInMemoryCache) {
      const agents = [];
      for (const value of inMemoryCache.values()) {
        agents.push(JSON.parse(value));
      }
      return agents;
    }
    try {
      const allStates = await redisClient.hGetAll('agent_presence');
      return Object.values(allStates).map(val => JSON.parse(val));
    } catch (err) {
      console.error('[Redis] Error getting all agent states:', err.message);
      const agents = [];
      for (const value of inMemoryCache.values()) {
        agents.push(JSON.parse(value));
      }
      return agents;
    }
  },

  async removeAgent(userId) {
    // Always remove from local in-memory store
    inMemoryCache.delete(userId);
    if (useInMemoryCache) {
      return true;
    }
    try {
      await redisClient.hDel('agent_presence', userId);
      return true;
    } catch (err) {
      console.error('[Redis] Error deleting agent state:', err.message);
      return false;
    }
  }
};

// ----------------------------------------------------
// 3. REST API Endpoints
// ----------------------------------------------------

/**
 * GET /api/calls/history
 * Fetch paginated historical call logs from MongoDB or Mock database.
 */
app.get('/api/calls/history', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    const query = {};
    if (req.query.agentId) {
      query.agentId = req.query.agentId;
    }
    if (req.query.direction) {
      query.direction = req.query.direction;
    }
    if (req.query.status) {
      query.status = req.query.status;
    }

    const total = await countCallLogs(query);
    const logs = await findCallLogs(query, skip, limit);

    return res.json({
      success: true,
      data: logs,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('[API] Error in GET /api/calls/history:', error);
    return res.status(500).json({ error: "Failed to fetch historical call logs." });
  }
});

/**
 * GET /api/agents/performance
 * Aggregates call metrics
 */
app.get('/api/agents/performance', async (req, res) => {
  try {
    const performanceData = await aggregatePerformance();
    return res.json({
      success: true,
      data: performanceData
    });
  } catch (error) {
    console.error('[API] Error in GET /api/agents/performance:', error);
    return res.status(500).json({ error: "Failed to compile performance metrics." });
  }
});

/**
 * POST /api/calls/simulate
 * Utility endpoint to submit a simulated call to the system
 */
app.post('/api/calls/simulate', async (req, res) => {
  try {
    const { callerId, agentUserId, direction, status, durationInSeconds, recordingUrl } = req.body;

    if (!callerId || !direction || !status) {
      return res.status(400).json({ error: "callerId, direction, and status are required." });
    }

    let agentDbId = null;
    if (agentUserId) {
      const agent = await findAgentByUserId(agentUserId);
      if (agent) {
        agentDbId = agent._id;
      }
    }

    const startTime = new Date(Date.now() - (durationInSeconds || 30) * 1000);
    const endTime = new Date();

    const loggedCall = await saveCallLog({
      callId: `SIP-UUID-${Math.random().toString(36).substr(2, 9).toUpperCase()}-${Date.now()}`,
      callerId,
      agentId: agentDbId,
      direction,
      status,
      startTime,
      endTime,
      durationInSeconds: durationInSeconds || 0,
      recordingUrl: recordingUrl || null
    });

    return res.status(201).json({ success: true, data: loggedCall });
  } catch (error) {
    console.error('[API] Error in POST /api/calls/simulate:', error);
    return res.status(500).json({ error: "Failed to simulate call log." });
  }
});

// ----------------------------------------------------
// 4. WebSocket Server & Presence Logic
// ----------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;

  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (ws, req) => {
  const parameters = url.parse(req.url, true).query;
  const userId = parameters.userId || `guest_${Math.random().toString(36).substring(7)}`;
  const role = parameters.role || 'agent';
  const name = parameters.name || `User ${userId}`;

  ws.userId = userId;
  ws.role = role;
  ws.name = name;
  ws.isAlive = true;

  console.log(`[WS] Client Connected: ${name} (ID: ${userId}, Role: ${role})`);

  // Instantly fetch current status of this agent or create user in DB if they don't exist
  let currentStatus = 'Offline';
  try {
    let agent = await findAgentByUserId(userId);
    if (!agent) {
      agent = await updateAgentStatus(userId, {
        userId,
        name,
        role,
        status: role === 'manager' ? 'Offline' : 'Available',
        lastStatusChange: new Date()
      });
    }
    
    // Managers do not participate in phone status queues
    if (role === 'agent') {
      currentStatus = 'Available';
      agent = await updateAgentStatus(userId, {
        status: 'Available',
        lastStatusChange: new Date()
      });

      // Write to Redis/InMemoryCache
      await presenceCache.setAgentState(userId, {
        userId,
        name,
        role,
        status: currentStatus,
        lastStatusChange: agent.lastStatusChange
      });

      // Broadcast this change to all managers
      broadcastToManagers({
        type: 'agent_status_updated',
        agent: {
          userId,
          name,
          role,
          status: currentStatus,
          lastStatusChange: agent.lastStatusChange
        }
      });
    }
  } catch (err) {
    console.error('[WS] Initialization database query error:', err.message);
  }

  // Send initial data to newly connected client
  if (role === 'manager') {
    // Managers need the immediate states of all active agents
    try {
      const allStates = await presenceCache.getAllAgents();
      ws.send(JSON.stringify({
        type: 'current_agents_state',
        agents: allStates
      }));
    } catch (err) {
      console.error('[WS] Manager setup cache read error:', err.message);
    }
  }

  // Ping/Pong confirmation
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Handle incoming socket message frames
  ws.on('message', async (messageBuffer) => {
    try {
      const message = JSON.parse(messageBuffer.toString());
      console.log(`[WS] Received message from ${ws.name}:`, message);

      switch (message.type) {
        case 'status_change':
          if (ws.role === 'agent') {
            const { status } = message;
            const lastStatusChange = new Date();

            // Update database helper
            const updatedAgent = await updateAgentStatus(ws.userId, {
              status,
              lastStatusChange
            });

            // Update cache
            const agentPayload = {
              userId: ws.userId,
              name: ws.name,
              role: ws.role,
              status,
              lastStatusChange
            };
            await presenceCache.setAgentState(ws.userId, agentPayload);

            console.log(`[WS] State changed: Agent ${ws.name} -> ${status}`);

            // Broadcast to managers
            broadcastToManagers({
              type: 'agent_status_updated',
              agent: agentPayload
            });
          }
          break;

        case 'call_event':
          // Relays active call state (Ringing, Connected, Held, Completed)
          if (ws.role === 'agent') {
            const { callState, callId, callerId, direction } = message;
            
            // If the agent is on a call, set status to On-Call, otherwise revert to Wrap-Up or Available
            let nextStatus = 'Available';
            if (callState === 'Ringing' || callState === 'Connected') {
              nextStatus = 'On-Call';
            } else if (callState === 'Completed') {
              nextStatus = 'Wrap-Up';
            }

            const lastStatusChange = new Date();
            const updatedAgent = await updateAgentStatus(ws.userId, {
              status: nextStatus,
              lastStatusChange
            });

            const agentPayload = {
              userId: ws.userId,
              name: ws.name,
              role: ws.role,
              status: nextStatus,
              lastStatusChange
            };
            await presenceCache.setAgentState(ws.userId, agentPayload);

            // Broadcast status change + call telemetry details
            broadcastToManagers({
              type: 'agent_status_updated',
              agent: agentPayload
            });

            broadcastToManagers({
              type: 'call_telemetry_event',
              telemetry: {
                agentUserId: ws.userId,
                agentName: ws.name,
                callId,
                callerId,
                direction,
                callState,
                timestamp: lastStatusChange
              }
            });
          }
          break;

        case 'webrtc_signal':
          {
            const { targetUserId, signal } = message;
            let targetClient = null;
            for (const client of wss.clients) {
              if (client.userId === targetUserId && client.readyState === WebSocket.OPEN) {
                targetClient = client;
                break;
              }
            }
            if (targetClient) {
              targetClient.send(JSON.stringify({
                type: 'webrtc_signal',
                senderUserId: ws.userId,
                senderName: ws.name,
                signal
              }));
            }
          }
          break;

        default:
          console.warn(`[WS] Unknown command event: ${message.type}`);
      }
    } catch (error) {
      console.error('[WS] Error processing message packet:', error.message);
      ws.send(JSON.stringify({ error: "Invalid socket frame format." }));
    }
  });

  // Client connection teardown handling
  ws.on('close', async () => {
    console.log(`[WS] Connection closed: ${ws.name} (ID: ${ws.userId})`);
    
    if (ws.role === 'agent') {
      const status = 'Offline';
      const lastStatusChange = new Date();

      try {
        // Update database helper
        await updateAgentStatus(ws.userId, {
          status,
          lastStatusChange
        });

        // Remove or update presence cache to Offline
        const offlinePayload = {
          userId: ws.userId,
          name: ws.name,
          role: ws.role,
          status,
          lastStatusChange
        };
        await presenceCache.setAgentState(ws.userId, offlinePayload);

        // Broadcast to all active managers
        broadcastToManagers({
          type: 'agent_status_updated',
          agent: offlinePayload
        });
      } catch (err) {
        console.error('[WS] Error on close state updates:', err.message);
      }
    }
  });
});

// Broadcast Helper utility to send messages to managers
function broadcastToManagers(payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.role === 'manager') {
      client.send(data);
    }
  });
}

// Active connection verification ping loop
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`[WS] Heartbeat timeout. Terminating connection: ${ws.name}`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// ----------------------------------------------------
// 5. Mock DB Seeder Functions
// ----------------------------------------------------
async function seedMockData() {
  try {
    // Check if agents exist, seed if empty
    const agentCount = await Agent.countDocuments();
    let alice = null;
    let bob = null;
    
    if (agentCount === 0) {
      console.log('[Seeder] No agents found. Seeding mock agent and manager records...');
      
      alice = new Agent({
        userId: 'agent_alice',
        name: 'Alice Smith',
        role: 'agent',
        status: 'Offline',
        lastStatusChange: new Date()
      });
      await alice.save();

      bob = new Agent({
        userId: 'agent_bob',
        name: 'Bob Johnson',
        role: 'agent',
        status: 'Offline',
        lastStatusChange: new Date()
      });
      await bob.save();

      const manager = new Agent({
        userId: 'manager_carol',
        name: 'Carol Danvers',
        role: 'manager',
        status: 'Offline',
        lastStatusChange: new Date()
      });
      await manager.save();
      
      console.log('[Seeder] Agents seeded successfully.');
    } else {
      alice = await Agent.findOne({ userId: 'agent_alice' });
      bob = await Agent.findOne({ userId: 'agent_bob' });
    }

    // Update local memory hot backup maps for consistency
    const allDbAgents = await Agent.find();
    allDbAgents.forEach(a => {
      mockAgents.set(a.userId, {
        _id: a._id,
        userId: a.userId,
        name: a.name,
        role: a.role,
        status: a.status,
        lastStatusChange: a.lastStatusChange
      });
    });

    // Check if call logs exist, seed if empty
    const logCount = await CallLog.countDocuments();
    if (logCount === 0) {
      console.log('[Seeder] No call logs found. Seeding call history...');
      const records = [
        {
          callId: 'SIP-UUID-XYZ12345-1',
          callerId: '+1 (555) 019-2834',
          agentId: alice ? alice._id : null,
          direction: 'Inbound',
          status: 'Answered',
          startTime: new Date(Date.now() - 4 * 3600 * 1000), // 4 hours ago
          endTime: new Date(Date.now() - 4 * 3600 * 1000 + 145 * 1000), // 145s duration
          durationInSeconds: 145,
          recordingUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'
        },
        {
          callId: 'SIP-UUID-XYZ12345-2',
          callerId: '+1 (555) 021-3940',
          agentId: bob ? bob._id : null,
          direction: 'Outbound',
          status: 'Answered',
          startTime: new Date(Date.now() - 2.5 * 3600 * 1000), // 2.5 hours ago
          endTime: new Date(Date.now() - 2.5 * 3600 * 1000 + 320 * 1000), // 320s duration
          durationInSeconds: 320,
          recordingUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3'
        },
        {
          callId: 'SIP-UUID-XYZ12345-3',
          callerId: '+1 (555) 043-4859',
          agentId: null, // Missed / Abandoned in queue
          direction: 'Inbound',
          status: 'Abandoned',
          startTime: new Date(Date.now() - 1.5 * 3600 * 1000),
          endTime: new Date(Date.now() - 1.5 * 3600 * 1000 + 45 * 1000),
          durationInSeconds: 45,
          recordingUrl: null
        },
        {
          callId: 'SIP-UUID-XYZ12345-4',
          callerId: '+1 (555) 098-1122',
          agentId: alice ? alice._id : null,
          direction: 'Inbound',
          status: 'Answered',
          startTime: new Date(Date.now() - 30 * 60 * 1000), // 30 mins ago
          endTime: new Date(Date.now() - 30 * 60 * 1000 + 72 * 1000),
          durationInSeconds: 72,
          recordingUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3'
        },
        {
          callId: 'SIP-UUID-XYZ12345-5',
          callerId: '+1 (555) 077-4499',
          agentId: bob ? bob._id : null,
          direction: 'Outbound',
          status: 'Busy',
          startTime: new Date(Date.now() - 15 * 60 * 1000),
          endTime: new Date(Date.now() - 15 * 60 * 1000 + 10 * 1000),
          durationInSeconds: 10,
          recordingUrl: null
        }
      ];

      await CallLog.insertMany(records);
      console.log('[Seeder] Call logs seeded successfully.');
    }

    // Populate mockCallLogs for hot memory cache
    const allDbCallLogs = await CallLog.find();
    allDbCallLogs.forEach(c => {
      mockCallLogs.push({
        _id: c._id,
        callId: c.callId,
        callerId: c.callerId,
        agentId: c.agentId,
        direction: c.direction,
        status: c.status,
        startTime: c.startTime,
        endTime: c.endTime,
        durationInSeconds: c.durationInSeconds,
        recordingUrl: c.recordingUrl
      });
    });

  } catch (error) {
    console.error('[Seeder] Error during database seeding:', error.message);
  }
}

// Memory-only seeder fallback when MongoDB server is completely offline
function seedMockDataInMemory() {
  console.log('[Seeder Fallback] Seeding sandbox memory database...');
  const alice = {
    _id: 'mock_alice_db_id',
    userId: 'agent_alice',
    name: 'Alice Smith',
    role: 'agent',
    status: 'Offline',
    lastStatusChange: new Date()
  };
  const bob = {
    _id: 'mock_bob_db_id',
    userId: 'agent_bob',
    name: 'Bob Johnson',
    role: 'agent',
    status: 'Offline',
    lastStatusChange: new Date()
  };
  const manager = {
    _id: 'mock_manager_db_id',
    userId: 'manager_carol',
    name: 'Carol Danvers',
    role: 'manager',
    status: 'Offline',
    lastStatusChange: new Date()
  };

  mockAgents.set(alice.userId, alice);
  mockAgents.set(bob.userId, bob);
  mockAgents.set(manager.userId, manager);

  const records = [
    {
      _id: 'mock_cdr_1',
      callId: 'SIP-UUID-XYZ12345-1',
      callerId: '+1 (555) 019-2834',
      agentId: 'mock_alice_db_id',
      direction: 'Inbound',
      status: 'Answered',
      startTime: new Date(Date.now() - 4 * 3600 * 1000),
      endTime: new Date(Date.now() - 4 * 3600 * 1000 + 145 * 1000),
      durationInSeconds: 145,
      recordingUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'
    },
    {
      _id: 'mock_cdr_2',
      callId: 'SIP-UUID-XYZ12345-2',
      callerId: '+1 (555) 021-3940',
      agentId: 'mock_bob_db_id',
      direction: 'Outbound',
      status: 'Answered',
      startTime: new Date(Date.now() - 2.5 * 3600 * 1000),
      endTime: new Date(Date.now() - 2.5 * 3600 * 1000 + 320 * 1000),
      durationInSeconds: 320,
      recordingUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3'
    },
    {
      _id: 'mock_cdr_3',
      callId: 'SIP-UUID-XYZ12345-3',
      callerId: '+1 (555) 043-4859',
      agentId: null,
      direction: 'Inbound',
      status: 'Abandoned',
      startTime: new Date(Date.now() - 1.5 * 3600 * 1000),
      endTime: new Date(Date.now() - 1.5 * 3600 * 1000 + 45 * 1000),
      durationInSeconds: 45,
      recordingUrl: null
    },
    {
      _id: 'mock_cdr_4',
      callId: 'SIP-UUID-XYZ12345-4',
      callerId: '+1 (555) 098-1122',
      agentId: 'mock_alice_db_id',
      direction: 'Inbound',
      status: 'Answered',
      startTime: new Date(Date.now() - 30 * 60 * 1000),
      endTime: new Date(Date.now() - 30 * 60 * 1000 + 72 * 1000),
      durationInSeconds: 72,
      recordingUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3'
    },
    {
      _id: 'mock_cdr_5',
      callId: 'SIP-UUID-XYZ12345-5',
      callerId: '+1 (555) 077-4499',
      agentId: 'mock_bob_db_id',
      direction: 'Outbound',
      status: 'Busy',
      startTime: new Date(Date.now() - 15 * 60 * 1000),
      endTime: new Date(Date.now() - 15 * 60 * 1000 + 10 * 1000),
      durationInSeconds: 10,
      recordingUrl: null
    }
  ];

  records.forEach(r => mockCallLogs.push(r));
  console.log('[Seeder Fallback] In-memory datastore successfully seeded.');
}

// Start Server Listen
server.listen(PORT, () => {
  console.log(`[Express + WS Server] Running on http://127.0.0.1:${PORT}`);
});
