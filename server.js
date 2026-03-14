const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const url = require('url');
const mongoose = require('mongoose');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'shravan';
const ADMIN_CONTACT = process.env.ADMIN_CONTACT || '6301238322';

const mongoURI =
  process.env.MONGO_URI ||
  'mongodb+srv://Shravan:12345@cluster0.bmzwl.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

mongoose
  .connect(mongoURI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
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

const Visitor = mongoose.model('Visitor', visitorSchema);

function sanitizeMessage(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .trim();
}
function isBlockedUser(room, contact, ip) {
  const entries = bannedEntries[room] || [];
  return entries.some(entry => entry.contact === contact || entry.ip === ip);
}
function containsBannedWords(message, room) {
  const clean = String(message || '').toLowerCase();
  const words = mutedWordsByRoom[room] || defaultBannedWords;
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
  if (!rooms[room]) return [];
  return rooms[room].filter((u) => u.isAdmin);
}

function notifyAdmins(room, data) {
  const payload = JSON.stringify(data);
  getAdminSockets(room).forEach(({ socket }) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  });
}

function broadcast(room, data) {
  if (!rooms[room]) return;
  const message = JSON.stringify(data);
  rooms[room].forEach(({ socket }) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(message);
    }
  });
}

function sendUserList(room) {
  if (!rooms[room]) return;

  const userList = rooms[room].map((user) => ({
    username: user.username,
    isAdmin: !!user.isAdmin,
  }));

  broadcast(room, {
    type: 'userlist',
    users: userList,
  });
}

function sendOnlineUsersPanel(room) {
  if (!rooms[room]) return;

  const publicUsers = (onlineUsersByRoom[room] || []).map((u) => ({
    username: u.username,
    isAdmin: !!u.isAdmin,
  }));

  const adminUsers = (onlineUsersByRoom[room] || []).map((u) => ({
    username: u.username,
    contact: u.contact,
    isAdmin: !!u.isAdmin,
    joinedAt: u.joinedAt,
  }));

  rooms[room].forEach((u) => {
    if (u.socket.readyState !== WebSocket.OPEN) return;

    u.socket.send(
      JSON.stringify({
        type: 'onlineUsersPanel',
        users: u.isAdmin ? adminUsers : publicUsers,
      })
    );
  });
}

function sendMutedWords(room, targetSocket = null) {
  const payload = JSON.stringify({
    type: 'mutedWordsList',
    words: mutedWordsByRoom[room] || [],
  });

  if (targetSocket) {
    if (targetSocket.readyState === WebSocket.OPEN) {
      targetSocket.send(payload);
    }
    return;
  }

  getAdminSockets(room).forEach(({ socket }) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  });
}
function sendBannedList(room, targetSocket = null) {
  const payload = JSON.stringify({
    type: 'bannedList',
    users: bannedEntries[room] || [],
  });

  if (targetSocket) {
    if (targetSocket.readyState === WebSocket.OPEN) {
      targetSocket.send(payload);
    }
    return;
  }

  getAdminSockets(room).forEach(({ socket }) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  });
}
app.post('/log-visitor', async (req, res) => {
  try {
    const { username, contact } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

    if (!contact || !/^\d{10}$/.test(contact)) {
      return res.status(400).send('Valid 10-digit contact number is required');
    }

    const existingVisitor = await Visitor.findOne({ contact });

    if (existingVisitor) {
      existingVisitor.username = username || existingVisitor.username;
      existingVisitor.ip = ip;
      existingVisitor.time = new Date();
      await existingVisitor.save();

      allVisitorsCache.set(contact, {
        username: existingVisitor.username,
        contact,
        time: new Date().toISOString(),
      });

      return res.send('Visitor already exists, updated successfully');
    }

    const visitor = new Visitor({ ip, username, contact });
    await visitor.save();

    allVisitorsCache.set(contact, {
      username,
      contact,
      time: new Date().toISOString(),
    });

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
  const room = parameters.query.room || 'default';
  const usernameParam = sanitizeMessage(parameters.query.username || 'Anonymous');
  const contact = String(parameters.query.contact || '').trim();


  if (!contact || !/^\d{10}$/.test(contact)) {
    ws.send(
      JSON.stringify({
        type: 'system',
        message: 'Valid 10-digit contact number is required to join the chat.',
      })
    );
    ws.close();
    return;
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  if (!rooms[room]) rooms[room] = [];
  if (!onlineUsersByRoom[room]) onlineUsersByRoom[room] = [];
  if (!mutedWordsByRoom[room]) mutedWordsByRoom[room] = [...defaultBannedWords];
  if (!bannedEntries[room]) bannedEntries[room] = [];

  if (isBlockedUser(room, contact, ip)) {
  ws.send(
    JSON.stringify({
      type: 'system',
      message: 'You are banned from this room.',
    })
  );
  ws.close();
  return;
}

  const user = {
    socket: ws,
    username: usernameParam,
    contact,
    ip,
    isAdmin: usernameParam === ADMIN_USERNAME && contact === ADMIN_CONTACT,
  };

  Visitor.findOneAndUpdate(
    { contact },
    { ip, username: usernameParam, contact, time: new Date() },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  )
    .then(() => {
      allVisitorsCache.set(contact, {
        username: usernameParam,
        contact,
        time: new Date().toISOString(),
      });
      console.log(`📥 Visitor saved/updated: ${usernameParam} (${ip})`);
    })
    .catch((err) => console.error('❌ Error saving visitor:', err));

  rooms[room].push(user);

  onlineUsersByRoom[room].push({
    username: user.username,
    contact: user.contact,
    isAdmin: user.isAdmin,
    joinedAt: new Date().toISOString(),
  });

  

  sendUserList(room);
  sendOnlineUsersPanel(room);
  sendMutedWords(room);
  sendBannedList(room);

  ws.on('message', function incoming(message) {
    try {
      const data = JSON.parse(message);

      if (data.type === 'join') {
        user.username = sanitizeMessage(data.username || user.username || 'Anonymous');

        const onlineUser = (onlineUsersByRoom[room] || []).find(
          (u) => u.contact === user.contact
        );
        if (onlineUser) {
          onlineUser.username = user.username;
          onlineUser.isAdmin = user.isAdmin;
        }

        broadcast(room, {
          type: 'system',
          message: `${user.username} joined the chat`,
        });

        sendUserList(room);
        sendOnlineUsersPanel(room);
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
        const sanitizedMessage = sanitizeMessage(data.message);
        if (!sanitizedMessage) return;

        const userKey = `${room}:${user.username}:${ip}`;
        if (isRateLimited(userKey)) {
          ws.send(
            JSON.stringify({
              type: 'system',
              message: 'Too many messages. Please wait a few seconds.',
            })
          );
          return;
        }

        if (containsBannedWords(sanitizedMessage, room)) {
          ws.send(
            JSON.stringify({
              type: 'system',
              message: 'Your message contains inappropriate language and was not sent.',
            })
          );
          return;
        }

        let safeReplyTo = null;
        if (data.replyTo && typeof data.replyTo === 'object') {
          const replyUsername = sanitizeMessage(data.replyTo.username || '');
          const replyMessage = sanitizeMessage(data.replyTo.message || '');
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
        const sanitizedPrivateMessage = sanitizeMessage(data.message);
        if (!sanitizedPrivateMessage) return;

        if (containsBannedWords(sanitizedPrivateMessage, room)) {
          ws.send(
            JSON.stringify({
              type: 'system',
              message:
                'Your private message contains inappropriate language and was not sent.',
            })
          );
          return;
        }

        const targetUser = rooms[room].find((u) => u.username === data.recipient);
        if (targetUser) {
          targetUser.socket.send(
            JSON.stringify({
              type: 'privateMessage',
              username: user.username,
              message: sanitizedPrivateMessage,
            })
          );
        }
        return;
      }

      if (data.type === 'adminAnnouncementPrivate') {
        if (!user.isAdmin) return;

        const targetUser = rooms[room].find((u) => u.username === data.targetUsername);
        const safeMessage = sanitizeMessage(data.message);

        if (targetUser && safeMessage) {
          targetUser.socket.send(
            JSON.stringify({
              type: 'privateAnnouncement',
              from: user.username,
              message: safeMessage,
            })
          );
        }
        return;
      }

      if (data.type === 'adminAddMutedWord') {
        if (!user.isAdmin) return;

        const word = sanitizeMessage(data.word || '').toLowerCase();
        if (!word) return;

        if (!mutedWordsByRoom[room].includes(word)) {
          mutedWordsByRoom[room].push(word);
        }

        sendMutedWords(room);
        return;
      }

      if (data.type === 'adminRemoveMutedWord') {
        if (!user.isAdmin) return;

        const word = sanitizeMessage(data.word || '').toLowerCase();
        mutedWordsByRoom[room] = (mutedWordsByRoom[room] || []).filter(
          (w) => w !== word
        );

        sendMutedWords(room);
        return;
      }

      if (data.type === 'adminBanUser') {
      if (!user.isAdmin) return;

      const targetUsername = sanitizeMessage(data.targetUsername || '');
      if (!targetUsername || targetUsername === user.username) return;

      const targetUser = rooms[room].find((u) => u.username === targetUsername);
      if (!targetUser) {
        sendBannedList(room);
        notifyAdmins(room, {
          type: 'adminActionResult',
          message: `${targetUsername} not found online`,
        });
        return;
      }

  const alreadyBlocked = (bannedEntries[room] || []).some(
    (entry) => entry.contact === targetUser.contact || entry.ip === targetUser.ip
  );

        if (!alreadyBlocked) {
          bannedEntries[room].push({
            username: targetUser.username,
            contact: targetUser.contact,
            ip: targetUser.ip,
            bannedAt: new Date().toISOString(),
          });
        }

        targetUser.socket.send(
          JSON.stringify({
            type: 'system',
            message: 'You have been banned by admin.',
          })
        );
        targetUser.socket.close();

        notifyAdmins(room, {
          type: 'adminActionResult',
          message: `${targetUsername} banned by IP + contact`,
        });

        return;
      }

      if (data.type === 'adminUnbanUser') {
  if (!user.isAdmin) return;

  const targetUsername = sanitizeMessage(data.targetUsername || '');
  const beforeCount = (bannedEntries[room] || []).length;

  bannedEntries[room] = (bannedEntries[room] || []).filter(
    (entry) => entry.username !== targetUsername
  );

  const afterCount = bannedEntries[room].length;
  sendBannedList(room);
  notifyAdmins(room, {
    
    type: 'adminActionResult',
    message:
      beforeCount !== afterCount
        ? `${targetUsername} unbanned successfully`
        : `${targetUsername} not found in ban list`,
  });

  return;
}

      if (data.type === 'adminExportVisitors') {
        if (!user.isAdmin) return;

        const visitors = Array.from(allVisitorsCache.values());

        ws.send(
          JSON.stringify({
            type: 'adminVisitorsExport',
            visitors,
          })
        );
        return;
      }

      if (data.type === 'kick') {
        const isAdmin = user.isAdmin;
        if (isAdmin && data.targetUsername && data.targetUsername !== user.username) {
          const targetUser = rooms[room].find((u) => u.username === data.targetUsername);
          if (targetUser) {
            targetUser.socket.send(
              JSON.stringify({
                type: 'system',
                message: 'You have been kicked out of the room.',
              })
            );
            targetUser.socket.close();
            rooms[room] = rooms[room].filter((u) => u !== targetUser);

            onlineUsersByRoom[room] = (onlineUsersByRoom[room] || []).filter(
              (u) => u.contact !== targetUser.contact
            );

            broadcast(room, {
              type: 'system',
              message: `${data.targetUsername} was kicked by admin.`,
            });

            sendUserList(room);
            sendOnlineUsersPanel(room);
          }
        }
        return;
      }
    } catch (err) {
      console.error('Invalid message format', err);
    }
  });

  ws.on('close', function () {
    if (rooms[room]) {
      rooms[room] = rooms[room].filter((u) => u.socket !== ws);
    }

    if (onlineUsersByRoom[room]) {
      onlineUsersByRoom[room] = onlineUsersByRoom[room].filter(
        (u) => u.contact !== user.contact
      );
    }

    broadcast(room, {
      type: 'system',
      message: `${user.username} left the chat`,
    });

    sendUserList(room);
    sendOnlineUsersPanel(room);

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
