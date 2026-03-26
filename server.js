const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const url = require('url');
const mongoose = require('mongoose');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_CONTACT = process.env.ADMIN_CONTACT || '6301238322';

const mongoURI =
  process.env.MONGO_URI ||
  'mongodb+srv://Shravan:12345@cluster0.bmzwl.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

mongoose
  .connect(mongoURI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch((err) => console.error('❌ MongoDB connection error:', err));

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = {};
const bannedEntries = {};
const mutedWordsByRoom = {};
const onlineUsersByRoom = {};
const allVisitorsCache = new Map();
const messageRateLimit = new Map();

const defaultBannedWords = [
  'badword1',
  'badword2',
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'motherfucker',
  'fuckoff',
  'fucker',
  'dick',
  'pussy',
  'slut',
  'whore',
];

app.use(express.json());

const visitorSchema = new mongoose.Schema({
  ip: String,
  username: String,
  contact: { type: String, required: true, unique: true },
  time: { type: Date, default: Date.now },
});

const Visitor = mongoose.models.Visitor || mongoose.model('Visitor', visitorSchema);

function sanitizeText(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .trim();
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function getRoom(room) {
  if (!rooms[room]) rooms[room] = [];
  return rooms[room];
}

function getRoomOnlineUsers(room) {
  if (!onlineUsersByRoom[room]) onlineUsersByRoom[room] = [];
  return onlineUsersByRoom[room];
}

function getRoomMutedWords(room) {
  if (!mutedWordsByRoom[room]) mutedWordsByRoom[room] = [...defaultBannedWords];
  return mutedWordsByRoom[room];
}

function getRoomBans(room) {
  if (!bannedEntries[room]) bannedEntries[room] = [];
  return bannedEntries[room];
}

function isAdminUser(user) {
  return !!user && !!user.isAdmin;
}

function isBlockedUser(room, contact, ip) {
  const entries = getRoomBans(room);
  return entries.some((entry) => entry.contact === contact || entry.ip === ip);
}

function containsBannedWords(message, room) {
  const clean = String(message || '').toLowerCase();
  const words = getRoomMutedWords(room);
  return words.some((word) => clean.includes(String(word).toLowerCase()));
}

function isRateLimited(userKey) {
  const now = Date.now();
  const windowMs = 10 * 1000;
  const maxMessages = 6;

  if (!messageRateLimit.has(userKey)) {
    messageRateLimit.set(userKey, []);
  }

  const recent = messageRateLimit.get(userKey).filter((ts) => now - ts < windowMs);

  if (recent.length >= maxMessages) {
    messageRateLimit.set(userKey, recent);
    return true;
  }

  recent.push(now);
  messageRateLimit.set(userKey, recent);
  return false;
}

function getAdminSockets(room) {
  return getRoom(room).filter((u) => u.isAdmin);
}

function safeSend(socket, data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

function broadcast(room, data) {
  getRoom(room).forEach(({ socket }) => {
    safeSend(socket, data);
  });
}

function sendUserList(room) {
  const userList = getRoom(room).map((user) => ({
    username: user.username,
    isAdmin: !!user.isAdmin,
  }));

  broadcast(room, {
    type: 'userlist',
    users: userList,
  });
}

function sendOnlineUsersPanel(room) {
  const onlineUsers = getRoomOnlineUsers(room);

  const publicUsers = onlineUsers.map((u) => ({
    username: u.username,
    isAdmin: !!u.isAdmin,
  }));

  const adminUsers = onlineUsers.map((u) => ({
    username: u.username,
    contact: u.contact,
    isAdmin: !!u.isAdmin,
    joinedAt: u.joinedAt,
  }));

  getRoom(room).forEach((u) => {
    safeSend(u.socket, {
      type: 'onlineUsersPanel',
      users: u.isAdmin ? adminUsers : publicUsers,
    });
  });
}

function sendMutedWords(room, targetSocket = null) {
  const data = {
    type: 'mutedWordsList',
    words: getRoomMutedWords(room),
  };

  if (targetSocket) {
    safeSend(targetSocket, data);
    return;
  }

  getAdminSockets(room).forEach(({ socket }) => safeSend(socket, data));
}

function sendBannedList(room, targetSocket = null) {
  const data = {
    type: 'bannedList',
    users: getRoomBans(room),
  };

  if (targetSocket) {
    safeSend(targetSocket, data);
    return;
  }

  getAdminSockets(room).forEach(({ socket }) => safeSend(socket, data));
}

function sendAdminPanels(room) {
  sendOnlineUsersPanel(room);
  sendMutedWords(room);
  sendBannedList(room);
}

function syncOnlineUser(user) {
  const onlineUsers = getRoomOnlineUsers(user.room);
  const existing = onlineUsers.find((u) => u.contact === user.contact);

  if (existing) {
    existing.username = user.username;
    existing.contact = user.contact;
    existing.isAdmin = user.isAdmin;
    existing.joinedAt = existing.joinedAt || new Date().toISOString();
  } else {
    onlineUsers.push({
      username: user.username,
      contact: user.contact,
      isAdmin: user.isAdmin,
      joinedAt: new Date().toISOString(),
    });
  }
}

function removeOnlineUser(user) {
  onlineUsersByRoom[user.room] = getRoomOnlineUsers(user.room).filter(
    (u) => u.contact !== user.contact
  );
}

async function upsertVisitor({ ip, username, contact }) {
  const doc = await Visitor.findOneAndUpdate(
    { contact },
    { ip, username, contact, time: new Date() },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  allVisitorsCache.set(contact, {
    username: doc.username,
    contact: doc.contact,
    time: new Date(doc.time).toISOString(),
  });

  return doc;
}

app.post('/log-visitor', async (req, res) => {
  try {
    const username = sanitizeText(req.body.username || '');
    const contact = String(req.body.contact || '').trim();
    const ip = getClientIp(req);

    if (!contact || !/^\d{10}$/.test(contact)) {
      return res.status(400).send('Valid 10-digit contact number is required');
    }

    await upsertVisitor({ ip, username, contact });
    res.send('Visitor logged successfully');
  } catch (err) {
    console.error('❌ Error saving visitor:', err);
    res.status(500).send('Error saving visitor');
  }
});

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

wss.on('connection', function connection(ws, req) {
  const parameters = url.parse(req.url, true);
  const room = String(parameters.query.room || 'default').trim();
  const usernameParam = sanitizeText(parameters.query.username || 'Anonymous');
  const contact = String(parameters.query.contact || '').trim();
  const ip = getClientIp(req);

  if (!contact || !/^\d{10}$/.test(contact)) {
    safeSend(ws, {
      type: 'system',
      message: 'Valid 10-digit contact number is required to join the chat.',
    });
    ws.close();
    return;
  }

  if (isBlockedUser(room, contact, ip)) {
    safeSend(ws, {
      type: 'system',
      message: 'You are banned from this room.',
    });
    ws.close();
    return;
  }

  const user = {
    socket: ws,
    room,
    username: usernameParam,
    contact,
    ip,
    isAdmin: usernameParam === ADMIN_USERNAME && contact === ADMIN_CONTACT,
  };

  const roomUsers = getRoom(room);

  const duplicateUsers = roomUsers.filter(
    (u) => u.username === user.username || u.contact === user.contact
  );

  duplicateUsers.forEach((dup) => {
    try {
      dup.socket.close();
    } catch (_) {}
  });

  rooms[room] = roomUsers.filter(
    (u) => u.username !== user.username && u.contact !== user.contact
  );

  getRoom(room).push(user);
  syncOnlineUser(user);

  upsertVisitor({ ip, username: user.username, contact: user.contact })
    .then(() => {
      console.log(`📥 Visitor saved/updated: ${user.username} (${ip})`);
    })
    .catch((err) => console.error('❌ Error saving visitor:', err));

  broadcast(room, {
    type: 'system',
    message: `${user.username} has joined the chat!`,
  });

  sendUserList(room);
  sendAdminPanels(room);

  ws.on('message', async function incoming(message) {
    try {
      const data = JSON.parse(message);

      if (data.type === 'join') {
        const newUsername = sanitizeText(data.username || user.username || 'Anonymous');
        user.username = newUsername;
        user.isAdmin = user.username === ADMIN_USERNAME && user.contact === ADMIN_CONTACT;

        syncOnlineUser(user);
        await upsertVisitor({ ip: user.ip, username: user.username, contact: user.contact });

        sendUserList(room);
        sendAdminPanels(room);
        return;
      }

      if (data.type === 'typing') {
        broadcast(room, {
          type: 'typing',
          username: user.username,
          typing: !!data.typing,
        });
        return;
      }

      if (data.type === 'message') {
        const sanitizedMessage = sanitizeText(data.message);
        if (!sanitizedMessage) return;

        const userKey = `${room}:${user.username}:${ip}`;
        if (isRateLimited(userKey)) {
          safeSend(ws, {
            type: 'system',
            message: 'Too many messages. Please wait a few seconds.',
          });
          return;
        }

        if (containsBannedWords(sanitizedMessage, room)) {
          safeSend(ws, {
            type: 'system',
            message: 'Your message contains inappropriate language and was not sent.',
          });
          return;
        }

        let safeReplyTo = null;
        if (data.replyTo && typeof data.replyTo === 'object') {
          const replyUsername = sanitizeText(data.replyTo.username || '');
          const replyMessage = sanitizeText(data.replyTo.message || '');
          if (replyUsername && replyMessage) {
            safeReplyTo = {
              username: replyUsername,
              message: replyMessage,
            };
          }
        }

        broadcast(room, {
          type: 'message',
          username: user.username,
          usernameColor: data.usernameColor,
          message: sanitizedMessage,
          replyTo: safeReplyTo,
        });
        return;
      }

      if (data.type === 'privateMessage') {
        const sanitizedPrivateMessage = sanitizeText(data.message);
        if (!sanitizedPrivateMessage) return;

        if (containsBannedWords(sanitizedPrivateMessage, room)) {
          safeSend(ws, {
            type: 'system',
            message: 'Your private message contains inappropriate language and was not sent.',
          });
          return;
        }

        const targetUser = getRoom(room).find((u) => u.username === data.recipient);
        if (targetUser) {
          safeSend(targetUser.socket, {
            type: 'privateMessage',
            username: user.username,
            message: sanitizedPrivateMessage,
          });
        } else {
          safeSend(ws, {
            type: 'system',
            message: `${sanitizeText(data.recipient || 'User')} is offline.`,
          });
        }
        return;
      }

      if (data.type === 'adminAnnouncementPrivate') {
        if (!isAdminUser(user)) return;

        const targetUsername = sanitizeText(data.targetUsername || '');
        const safeMessage = sanitizeText(data.message || '');
        if (!targetUsername || !safeMessage) return;

        const targetUser = getRoom(room).find((u) => u.username === targetUsername);

        if (targetUser) {
          safeSend(targetUser.socket, {
            type: 'privateAnnouncement',
            from: user.username,
            message: safeMessage,
          });

          safeSend(ws, {
            type: 'adminActionResult',
            message: `Private announcement sent to ${targetUsername}.`,
          });
        } else {
          safeSend(ws, {
            type: 'adminActionResult',
            message: `${targetUsername} is offline.`,
          });
        }
        return;
      }

      if (data.type === 'adminAddMutedWord') {
        if (!isAdminUser(user)) return;

        const word = sanitizeText(data.word || '').toLowerCase();
        if (!word) return;

        const words = getRoomMutedWords(room);
        if (!words.includes(word)) {
          words.push(word);
        }

        sendMutedWords(room);
        safeSend(ws, {
          type: 'adminActionResult',
          message: `"${word}" added to muted words.`,
        });
        return;
      }

      if (data.type === 'adminRemoveMutedWord') {
        if (!isAdminUser(user)) return;

        const word = sanitizeText(data.word || '').toLowerCase();
        if (!word) return;

        mutedWordsByRoom[room] = getRoomMutedWords(room).filter((w) => w !== word);

        sendMutedWords(room);
        safeSend(ws, {
          type: 'adminActionResult',
          message: `"${word}" removed from muted words.`,
        });
        return;
      }

      if (data.type === 'adminBanUser') {
        if (!isAdminUser(user)) return;

        const targetUsername = sanitizeText(data.targetUsername || '');
        if (!targetUsername || targetUsername === user.username) return;

        const targetUser = getRoom(room).find((u) => u.username === targetUsername);
        if (!targetUser) {
          sendBannedList(room);
          safeSend(ws, {
            type: 'adminActionResult',
            message: `${targetUsername} not found online.`,
          });
          return;
        }

        const roomBans = getRoomBans(room);
        const alreadyBlocked = roomBans.some(
          (entry) => entry.contact === targetUser.contact || entry.ip === targetUser.ip
        );

        if (!alreadyBlocked) {
          roomBans.push({
            username: targetUser.username,
            contact: targetUser.contact,
            ip: targetUser.ip,
            bannedAt: new Date().toISOString(),
          });
        }

        safeSend(targetUser.socket, {
          type: 'system',
          message: 'You have been banned by admin.',
        });

        try {
          targetUser.socket.close();
        } catch (_) {}

        sendBannedList(room);
        sendAdminPanels(room);
        safeSend(ws, {
          type: 'adminActionResult',
          message: `${targetUsername} banned by IP + contact.`,
        });
        return;
      }

      if (data.type === 'adminUnbanUser') {
        if (!isAdminUser(user)) return;

        const targetUsername = sanitizeText(data.targetUsername || '');
        const beforeCount = getRoomBans(room).length;

        bannedEntries[room] = getRoomBans(room).filter(
          (entry) => entry.username !== targetUsername
        );

        const afterCount = bannedEntries[room].length;

        sendBannedList(room);
        sendAdminPanels(room);
        safeSend(ws, {
          type: 'adminActionResult',
          message:
            beforeCount !== afterCount
              ? `${targetUsername} unbanned successfully.`
              : `${targetUsername} not found in ban list.`,
        });
        return;
      }

      if (data.type === 'adminExportVisitors') {
        if (!isAdminUser(user)) return;

        let visitors = Array.from(allVisitorsCache.values());

        if (visitors.length === 0) {
          const docs = await Visitor.find().sort({ time: -1 }).limit(500).lean();
          visitors = docs.map((v) => ({
            username: v.username,
            contact: v.contact,
            time: new Date(v.time).toISOString(),
          }));
        }

        safeSend(ws, {
          type: 'adminVisitorsExport',
          visitors,
        });
        return;
      }

      if (data.type === 'kick') {
        if (!isAdminUser(user)) return;

        const targetUsername = sanitizeText(data.targetUsername || '');
        if (!targetUsername || targetUsername === user.username) return;

        const targetUser = getRoom(room).find((u) => u.username === targetUsername);
        if (!targetUser) {
          safeSend(ws, {
            type: 'adminActionResult',
            message: `${targetUsername} not found online.`,
          });
          return;
        }

        safeSend(targetUser.socket, {
          type: 'system',
          message: 'You have been kicked out of the room.',
        });

        try {
          targetUser.socket.close();
        } catch (_) {}

        safeSend(ws, {
          type: 'adminActionResult',
          message: `${targetUsername} was kicked by admin.`,
        });
        return;
      }
    } catch (err) {
      console.error('Invalid message format', err);
    }
  });

  ws.on('close', function () {
    rooms[room] = getRoom(room).filter((u) => u.socket !== ws);
    removeOnlineUser(user);

    broadcast(room, {
      type: 'system',
      message: `${user.username} left the chat`,
    });

    sendUserList(room);
    sendAdminPanels(room);

    if (rooms[room] && rooms[room].length === 0) {
      delete rooms[room];
      delete onlineUsersByRoom[room];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});