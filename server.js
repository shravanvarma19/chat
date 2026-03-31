require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const url = require("url");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const OpenAI = require("openai");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "shravan";
const ADMIN_CONTACT = process.env.ADMIN_CONTACT || "6301238322";
const PORT = Number(process.env.PORT || 3000);

const mongoURI =
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017/shravan_chat";

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const rooms = {};
const mutedWordsByRoom = {};
const onlineUsersByRoom = {};
const allVisitorsCache = new Map();
const messageRateLimit = new Map();
const recentMessagesByUser = new Map();

const defaultMutedWords = [
  "hmm",
  "mm",
  "enti",
  "ohh",
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "bastard",
  "motherfucker",
  "fuckoff",
  "fucker",
  "dick",
  "pussy",
  "slut",
  "whore"
];

/* -------------------- DB -------------------- */
mongoose
  .connect(mongoURI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

const visitorSchema = new mongoose.Schema({
  ip: String,
  username: String,
  contact: { type: String, required: true },
  userAgent: String,
  deviceInfo: {
    browser: String,
    os: String,
    deviceType: String,
    modelGuess: String
  },
  blocked: { type: Boolean, default: false },
  blockedAt: Date,
  time: { type: Date, default: Date.now }
});

visitorSchema.index({ contact: 1 }, { unique: true });
visitorSchema.index({ ip: 1 });
visitorSchema.index({ blocked: 1 });

const messageSchema = new mongoose.Schema({
  room: { type: String, required: true },
  username: { type: String, required: true },
  contact: { type: String, required: true },
  message: { type: String, required: true },
  replyTo: {
    username: String,
    message: String
  },
  isPrivate: { type: Boolean, default: false },
  recipient: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now }
});

messageSchema.index({ room: 1, createdAt: -1 });
messageSchema.index({ contact: 1, createdAt: -1 });

const Visitor =
  mongoose.models.Visitor || mongoose.model("Visitor", visitorSchema);

const ChatMessage =
  mongoose.models.ChatMessage || mongoose.model("ChatMessage", messageSchema);

/* -------------------- APP -------------------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* -------------------- HELPERS -------------------- */
function sanitizeText(input) {
  if (typeof input !== "string") return "";
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .trim();
}

function decodeHtml(text = "") {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}

function parseDeviceInfo(userAgent = "") {
  const ua = String(userAgent);

  let browser = "Unknown";
  let os = "Unknown";
  let deviceType = "Desktop";
  let modelGuess = "Unknown";

  if (/Android/i.test(ua)) {
    os = "Android";
    deviceType = "Mobile";
  } else if (/iPhone/i.test(ua)) {
    os = "iOS";
    deviceType = "Mobile";
    modelGuess = "iPhone";
  } else if (/iPad/i.test(ua)) {
    os = "iOS";
    deviceType = "Tablet";
    modelGuess = "iPad";
  } else if (/Windows/i.test(ua)) {
    os = "Windows";
  } else if (/Mac OS X/i.test(ua)) {
    os = "macOS";
  } else if (/Linux/i.test(ua)) {
    os = "Linux";
  }

  if (/Edg/i.test(ua)) browser = "Edge";
  else if (/Chrome/i.test(ua) && !/Edg/i.test(ua)) browser = "Chrome";
  else if (/Firefox/i.test(ua)) browser = "Firefox";
  else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = "Safari";

  if (/Mobile/i.test(ua)) deviceType = "Mobile";
  if (/Tablet|iPad/i.test(ua)) deviceType = "Tablet";

  const androidMatch = ua.match(/Android[\s/][\d.]+;\s*([^;)\]]+)/i);
  if (androidMatch && androidMatch[1]) {
    modelGuess = androidMatch[1].trim();
  }

  return { browser, os, deviceType, modelGuess };
}

function makeConnectionId() {
  return crypto.randomBytes(12).toString("hex");
}

function getRoom(room) {
  if (!rooms[room]) rooms[room] = [];
  return rooms[room];
}

function setRoom(room, users) {
  rooms[room] = users;
}

function getRoomOnlineUsers(room) {
  if (!onlineUsersByRoom[room]) onlineUsersByRoom[room] = [];
  return onlineUsersByRoom[room];
}

function getRoomMutedWords(room) {
  if (!mutedWordsByRoom[room]) {
    mutedWordsByRoom[room] = [...defaultMutedWords];
  }
  return mutedWordsByRoom[room];
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

function isAdminUser(user) {
  return !!user && !!user.isAdmin;
}

function containsMutedWords(message, room) {
  const clean = String(message || "").toLowerCase();
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

  const recent = messageRateLimit
    .get(userKey)
    .filter((ts) => now - ts < windowMs);

  if (recent.length >= maxMessages) {
    messageRateLimit.set(userKey, recent);
    return true;
  }

  recent.push(now);
  messageRateLimit.set(userKey, recent);
  return false;
}

function isSpamMessage(userKey, message) {
  const now = Date.now();
  const windowMs = 15000;

  if (!recentMessagesByUser.has(userKey)) {
    recentMessagesByUser.set(userKey, []);
  }

  const list = recentMessagesByUser
    .get(userKey)
    .filter((item) => now - item.time < windowMs);

  list.push({ message, time: now });
  recentMessagesByUser.set(userKey, list);

  const sameCount = list.filter(
    (item) => item.message.toLowerCase() === message.toLowerCase()
  ).length;

  return sameCount >= 3;
}

function hasTooManyLinks(message) {
  const matches = String(message || "").match(/https?:\/\/|www\./gi);
  return !!(matches && matches.length >= 3);
}

function isSuspiciousText(message) {
  const text = String(message || "");
  if (text.length > 500) return true;
  if (/(.)\1{12,}/.test(text)) return true;
  return false;
}

function shouldTriggerAI(message) {
  const text = String(message || "").trim();
  if (!text) return false;

  const lower = text.toLowerCase();

  if (lower.includes("@ai")) return true;
  if (text.endsWith("?")) return true;
  if (/^(hi|hello|hey|hii|hlo)\b/i.test(text)) return true;

  return false;
}

function shouldSendAIInRoom(room) {
  return getRoom(room).length === 1;
}

function getFallbackAIReply(userMessage) {
  const text = String(userMessage || "").toLowerCase();

  if (text.includes("hi") || text.includes("hello") || text.includes("hey")) {
    return "Hello machaa 👋";
  }
  if (text.includes("how are you")) {
    return "Nenu bagunna machaa 😎";
  }
  if (text.includes("bye")) {
    return "Bye machaa 👋";
  }
  if (text.includes("love")) {
    return "Awww machaa 💚";
  }
  return "Okay machaa 🤖";
}

async function getRealAIReply(userMessage, username) {
  try {
    if (!openai) {
      return getFallbackAIReply(userMessage);
    }

    const response = await openai.responses.create({
      model: "gpt-5.4",
      reasoning: { effort: "low" },
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You are Shravan AI, a friendly stylish assistant inside Shravan.Chat. " +
                "Reply short, natural, playful, and safe. " +
                "Keep replies under 2 sentences. " +
                "Do not produce abusive, sexual, hateful, illegal, or dangerous content."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `User name: ${username}\nMessage: ${userMessage}`
            }
          ]
        }
      ]
    });

    return (response.output_text || "").trim() || getFallbackAIReply(userMessage);
  } catch (err) {
    console.error("❌ OpenAI reply error:", err);

    if (
      err?.status === 429 ||
      err?.code === "insufficient_quota" ||
      err?.type === "insufficient_quota"
    ) {
      return getFallbackAIReply(userMessage);
    }

    return "Sorry machaa, AI ippudu reply ivvalekapoyindi.";
  }
}

function sendUserList(room) {
  const userList = getRoom(room).map((user) => ({
    username: user.username,
    isAdmin: !!user.isAdmin
  }));

  broadcast(room, {
    type: "userlist",
    users: userList
  });
}

async function isBlockedUser({ username, contact, ip }) {
  return Visitor.findOne({
    blocked: true,
    $or: [{ contact }, { ip }, { username }]
  });
}

function sendOnlineUsersPanel(room) {
  const onlineUsers = getRoomOnlineUsers(room);

  getRoom(room).forEach((u) => {
    const visibleUsers = onlineUsers.map((item) => {
      if (u.isAdmin) {
        return {
          username: item.username,
          contact: item.contact,
          ip: item.ip,
          browser: item.browser,
          os: item.os,
          deviceType: item.deviceType,
          modelGuess: item.modelGuess,
          isAdmin: item.isAdmin
        };
      }

      return {
        username: item.username,
        isAdmin: item.isAdmin
      };
    });

    safeSend(u.socket, {
      type: "onlineUsersPanel",
      users: visibleUsers
    });
  });
}

function sendMutedWords(room, targetSocket = null) {
  const data = {
    type: "mutedWordsList",
    words: getRoomMutedWords(room)
  };

  if (targetSocket) {
    safeSend(targetSocket, data);
    return;
  }

  getRoom(room)
    .filter((u) => u.isAdmin)
    .forEach(({ socket }) => safeSend(socket, data));
}

async function sendBlockedUsers(room, targetSocket = null) {
  const blockedDocs = await Visitor.find({ blocked: true })
    .sort({ blockedAt: -1, time: -1 })
    .limit(200)
    .lean();

  const users = blockedDocs.map((doc) => ({
    username: doc.username || "Unknown",
    contact: doc.contact || "",
    ip: doc.ip || "",
    browser: doc.deviceInfo?.browser || "Unknown",
    os: doc.deviceInfo?.os || "Unknown",
    deviceType: doc.deviceInfo?.deviceType || "Unknown",
    modelGuess: doc.deviceInfo?.modelGuess || "Unknown",
    blockedAt: doc.blockedAt || doc.time
  }));

  const data = {
    type: "bannedList",
    users
  };

  if (targetSocket) {
    safeSend(targetSocket, data);
    return;
  }

  getRoom(room)
    .filter((u) => u.isAdmin)
    .forEach(({ socket }) => safeSend(socket, data));
}

async function sendAdminPanels(room) {
  sendOnlineUsersPanel(room);
  sendMutedWords(room);
  await sendBlockedUsers(room);
}

function syncOnlineUser(user) {
  const onlineUsers = getRoomOnlineUsers(user.room);
  const existingIndex = onlineUsers.findIndex(
    (u) => u.connectionId === user.connectionId
  );

  const payload = {
    connectionId: user.connectionId,
    username: user.username,
    contact: user.contact,
    ip: user.ip,
    browser: user.deviceInfo?.browser || "Unknown",
    os: user.deviceInfo?.os || "Unknown",
    deviceType: user.deviceInfo?.deviceType || "Unknown",
    modelGuess: user.deviceInfo?.modelGuess || "Unknown",
    isAdmin: !!user.isAdmin
  };

  if (existingIndex >= 0) {
    onlineUsers[existingIndex] = payload;
  } else {
    onlineUsers.push(payload);
  }
}

function removeOnlineUserByConnection(room, connectionId) {
  onlineUsersByRoom[room] = getRoomOnlineUsers(room).filter(
    (u) => u.connectionId !== connectionId
  );
}

function removeUserFromRoomByConnection(room, connectionId) {
  setRoom(
    room,
    getRoom(room).filter((u) => u.connectionId !== connectionId)
  );
}

async function upsertVisitor({ ip, username, contact, userAgent, deviceInfo }) {
  const existing = await Visitor.findOne({ contact });

  if (existing && existing.username && existing.username !== username) {
    throw new Error("DUPLICATE_CONTACT_USERNAME_MISMATCH");
  }

  const doc = await Visitor.findOneAndUpdate(
    { contact },
    {
      ip,
      username,
      contact,
      userAgent,
      deviceInfo,
      time: new Date()
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  allVisitorsCache.set(contact, {
    username: doc.username,
    contact: doc.contact,
    ip: doc.ip,
    time: new Date(doc.time).toISOString()
  });

  return doc;
}

/* -------------------- ROUTES -------------------- */
app.post("/log-visitor", async (req, res) => {
  try {
    const username = sanitizeText(req.body.username || "");
    const contact = String(req.body.contact || "").trim();
    const ip = getClientIp(req);
    const userAgent = req.headers["user-agent"] || "";
    const deviceInfo = parseDeviceInfo(userAgent);

    if (!contact || !/^\d{10}$/.test(contact)) {
      return res.status(400).json({
        blocked: false,
        message: "Valid 10-digit contact number is required"
      });
    }

    const blockedVisitor = await isBlockedUser({ username, contact, ip });

    if (blockedVisitor) {
      return res.status(403).json({
        blocked: true,
        message: "You are blocked from the site"
      });
    }

    const existingContactUser = await Visitor.findOne({ contact });
    if (
      existingContactUser &&
      existingContactUser.username &&
      existingContactUser.username !== username
    ) {
      return res.json({
        success:false,
        blocked: false,
        duplicateContact: true,
        message: "This contact number is already linked to another username"
      });
    }

    await upsertVisitor({
      ip,
      username,
      contact,
      userAgent,
      deviceInfo
    });

    return res.json({
      blocked: false,
      message: "Visitor logged successfully"
    });
  } catch (err) {
    if (err.message === "DUPLICATE_CONTACT_USERNAME_MISMATCH") {
      return res.status(409).json({
        blocked: false,
        duplicateContact: true,
        message: "This contact number is already linked to another username"
      });
    }

    console.error("❌ Error saving visitor:", err);
    return res.status(500).json({
      blocked: false,
      message: "Error saving visitor"
    });
  }
});

/* -------------------- WS UPGRADE -------------------- */
server.on("upgrade", (req, socket, head) => {
  try {
    const pathname = url.parse(req.url).pathname;
    if (pathname !== "/") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } catch (err) {
    console.error("❌ Upgrade error:", err);
    socket.destroy();
  }
});

/* -------------------- WEBSOCKET -------------------- */
wss.on("connection", async (ws, req) => {
  let user = null;
  let room = "default";

  ws.on("error", (err) => {
    console.error("❌ WS client error:", err);
  });

  try {
    const parameters = url.parse(req.url, true);
    room = String(parameters.query.room || "default").trim();
    const usernameParam = sanitizeText(parameters.query.username || "Anonymous");
    const contact = String(parameters.query.contact || "").trim();
    const ip = getClientIp(req);
    const userAgent = req.headers["user-agent"] || "";
    const deviceInfo = parseDeviceInfo(userAgent);

    if (!contact || !/^\d{10}$/.test(contact)) {
      safeSend(ws, {
        type: "system",
        message: "Valid 10-digit contact number is required to join the chat."
      });
      ws.close();
      return;
    }

    const blockedVisitor = await isBlockedUser({
      username: usernameParam,
      contact,
      ip
    });

    if (blockedVisitor) {
      safeSend(ws, {
        type: "blocked",
        message: "You are blocked from the site"
      });
      ws.close();
      return;
    }

    const existingContactUser = await Visitor.findOne({ contact });
    if (
      existingContactUser &&
      existingContactUser.username &&
      existingContactUser.username !== usernameParam
    ) {
      safeSend(ws, {
        type: "duplicateContact",
        message: "This contact number is already linked to another username"
      });
      ws.close();
      return;
    }

    const connectionId = makeConnectionId();

    user = {
      connectionId,
      socket: ws,
      room,
      username: usernameParam,
      contact,
      ip,
      userAgent,
      deviceInfo,
      isAdmin:
        usernameParam === ADMIN_USERNAME && contact === ADMIN_CONTACT,
      silentReplacement: false
    };

    const roomUsers = getRoom(room);
    const existingActiveUser = roomUsers.find(
      (u) => u.contact === user.contact || u.username === user.username
    );

    if (existingActiveUser) {
      existingActiveUser.silentReplacement = true;
      removeUserFromRoomByConnection(room, existingActiveUser.connectionId);
      removeOnlineUserByConnection(room, existingActiveUser.connectionId);

      try {
        existingActiveUser.socket.close(4001, "Replaced by new connection");
      } catch (_) {}
    }

    getRoom(room).push(user);
    syncOnlineUser(user);

    await upsertVisitor({
      ip,
      username: user.username,
      contact: user.contact,
      userAgent,
      deviceInfo
    });

    console.log(`📥 Visitor saved/updated: ${user.username} (${ip})`);

    broadcast(room, {
      type: "system",
      message: `${user.username} has joined the chat!`
    });

    sendUserList(room);
    await sendAdminPanels(room);

    ws.on("message", async (rawMessage) => {
      try {
        const data = JSON.parse(String(rawMessage));

        if (data.type === "join") {
          const newUsername = sanitizeText(data.username || user.username);

          const existingJoinUser = await Visitor.findOne({ contact: user.contact });
          if (
            existingJoinUser &&
            existingJoinUser.username &&
            existingJoinUser.username !== newUsername
          ) {
            safeSend(ws, {
              type: "duplicateContact",
              message: "This contact number is already linked to another username"
            });
            return;
          }

          user.username = newUsername;
          user.isAdmin =
            user.username === ADMIN_USERNAME && user.contact === ADMIN_CONTACT;

          syncOnlineUser(user);

          await upsertVisitor({
            ip: user.ip,
            username: user.username,
            contact: user.contact,
            userAgent: user.userAgent,
            deviceInfo: user.deviceInfo
          });

          sendUserList(room);
          await sendAdminPanels(room);
          return;
        }

        if (data.type === "typing") {
          broadcast(room, {
            type: "typing",
            username: user.username,
            typing: !!data.typing
          });
          return;
        }

        if (data.type === "message") {
          const sanitizedMessage = sanitizeText(data.message);
          if (!sanitizedMessage) return;

          const userKey = `${room}:${user.username}:${ip}`;

          if (isRateLimited(userKey)) {
            safeSend(ws, {
              type: "system",
              message: "Too many messages. Please wait a few seconds."
            });
            return;
          }

          if (isSpamMessage(userKey, sanitizedMessage)) {
            safeSend(ws, {
              type: "system",
              message: "Spam detected. Repeating the same message is not allowed."
            });
            return;
          }

          if (hasTooManyLinks(sanitizedMessage)) {
            safeSend(ws, {
              type: "system",
              message: "Too many links in one message."
            });
            return;
          }

          if (isSuspiciousText(sanitizedMessage)) {
            safeSend(ws, {
              type: "system",
              message: "Suspicious spam-like message blocked."
            });
            return;
          }

          if (containsMutedWords(sanitizedMessage, room)) {
            safeSend(ws, {
              type: "system",
              message: "Your message contains inappropriate language and was not sent."
            });
            return;
          }

          let safeReplyTo = null;
          if (data.replyTo && typeof data.replyTo === "object") {
            const replyUsername = sanitizeText(data.replyTo.username || "");
            const replyMessage = sanitizeText(data.replyTo.message || "");
            if (replyUsername && replyMessage) {
              safeReplyTo = {
                username: replyUsername,
                message: replyMessage
              };
            }
          }

          await ChatMessage.create({
            room,
            username: user.username,
            contact: user.contact,
            message: sanitizedMessage,
            replyTo: safeReplyTo,
            isPrivate: false
          });

          broadcast(room, {
            type: "message",
            username: user.username,
            usernameColor: data.usernameColor,
            message: sanitizedMessage,
            replyTo: safeReplyTo
          });

          const plainMessageForAI = decodeHtml(sanitizedMessage);

          if (shouldTriggerAI(plainMessageForAI) && shouldSendAIInRoom(room)) {
            setTimeout(async () => {
              try {
                if (!shouldSendAIInRoom(room)) return;

                const aiReply = await getRealAIReply(
                  plainMessageForAI,
                  user.username
                );

                await ChatMessage.create({
                  room,
                  username: "Shravan AI",
                  contact: "0000000000",
                  message: aiReply,
                  replyTo: {
                    username: user.username,
                    message: sanitizedMessage
                  },
                  isPrivate: false
                });

                broadcast(room, {
                  type: "message",
                  username: "Shravan AI",
                  usernameColor: "#ffcc00",
                  message: aiReply,
                  replyTo: {
                    username: user.username,
                    message: sanitizedMessage
                  }
                });
              } catch (err) {
                console.error("❌ AI auto reply error:", err);
              }
            }, 1200);
          }

          return;
        }

        if (data.type === "privateMessage") {
          const sanitizedPrivateMessage = sanitizeText(data.message);
          if (!sanitizedPrivateMessage) return;

          const userKey = `${room}:${user.username}:${ip}:private`;

          if (isRateLimited(userKey)) {
            safeSend(ws, {
              type: "system",
              message: "Too many private messages. Please wait a few seconds."
            });
            return;
          }

          if (isSpamMessage(userKey, sanitizedPrivateMessage)) {
            safeSend(ws, {
              type: "system",
              message: "Spam detected. Repeating the same private message is not allowed."
            });
            return;
          }

          if (hasTooManyLinks(sanitizedPrivateMessage)) {
            safeSend(ws, {
              type: "system",
              message: "Too many links in private message."
            });
            return;
          }

          if (isSuspiciousText(sanitizedPrivateMessage)) {
            safeSend(ws, {
              type: "system",
              message: "Suspicious private message blocked."
            });
            return;
          }

          if (containsMutedWords(sanitizedPrivateMessage, room)) {
            safeSend(ws, {
              type: "system",
              message: "Your private message contains inappropriate language and was not sent."
            });
            return;
          }

          const recipient = sanitizeText(data.recipient || "");
          const targetUser = getRoom(room).find((u) => u.username === recipient);

          await ChatMessage.create({
            room,
            username: user.username,
            contact: user.contact,
            message: sanitizedPrivateMessage,
            replyTo: null,
            isPrivate: true,
            recipient
          });

          if (targetUser) {
            safeSend(targetUser.socket, {
              type: "privateMessage",
              username: user.username,
              message: sanitizedPrivateMessage
            });
          } else {
            safeSend(ws, {
              type: "system",
              message: `${recipient || "User"} is offline.`
            });
          }
          return;
        }

        if (data.type === "adminAnnouncementPrivate") {
          if (!isAdminUser(user)) return;

          const targetUsername = sanitizeText(data.targetUsername || "");
          const safeMessage = sanitizeText(data.message || "");
          if (!targetUsername || !safeMessage) return;

          const targetUser = getRoom(room).find((u) => u.username === targetUsername);

          if (targetUser) {
            safeSend(targetUser.socket, {
              type: "privateAnnouncement",
              from: user.username,
              message: safeMessage
            });

            safeSend(ws, {
              type: "adminActionResult",
              message: `Private announcement sent to ${targetUsername}.`
            });
          } else {
            safeSend(ws, {
              type: "adminActionResult",
              message: `${targetUsername} is offline.`
            });
          }
          return;
        }

        if (data.type === "adminAddMutedWord") {
          if (!isAdminUser(user)) return;

          const word = sanitizeText(data.word || "").toLowerCase();
          if (!word) return;

          const words = getRoomMutedWords(room);
          if (!words.includes(word)) words.push(word);

          sendMutedWords(room);
          safeSend(ws, {
            type: "adminActionResult",
            message: `"${word}" added to muted words.`
          });
          return;
        }

        if (data.type === "adminRemoveMutedWord") {
          if (!isAdminUser(user)) return;

          const word = sanitizeText(data.word || "").toLowerCase();
          if (!word) return;

          mutedWordsByRoom[room] = getRoomMutedWords(room).filter((w) => w !== word);

          sendMutedWords(room);
          safeSend(ws, {
            type: "adminActionResult",
            message: `"${word}" removed from muted words.`
          });
          return;
        }

        if (data.type === "adminBanUser") {
          if (!isAdminUser(user)) return;

          const targetUsername = sanitizeText(data.targetUsername || "");
          if (!targetUsername || targetUsername === user.username) return;

          const targetUser = getRoom(room).find((u) => u.username === targetUsername);

          if (!targetUser) {
            safeSend(ws, {
              type: "adminActionResult",
              message: `${targetUsername} not found online.`
            });
            await sendBlockedUsers(room, ws);
            return;
          }

          await Visitor.updateMany(
            {
              $or: [
                { username: targetUser.username },
                { contact: targetUser.contact },
                { ip: targetUser.ip }
              ]
            },
            {
              $set: {
                blocked: true,
                blockedAt: new Date()
              }
            }
          );

          targetUser.silentReplacement = true;

          safeSend(targetUser.socket, {
            type: "blocked",
            message: "You are blocked from the site"
          });

          setTimeout(() => {
            try {
              targetUser.socket.close();
            } catch (_) {}
          }, 200);

          removeUserFromRoomByConnection(room, targetUser.connectionId);
          removeOnlineUserByConnection(room, targetUser.connectionId);

          safeSend(ws, {
            type: "adminActionResult",
            message: `${targetUsername} blocked successfully.`
          });

          sendUserList(room);
          await sendBlockedUsers(room);
          await sendAdminPanels(room);
          return;
        }

        if (data.type === "adminUnbanUser") {
          if (!isAdminUser(user)) return;

          const targetUsername = sanitizeText(data.targetUsername || "");
          if (!targetUsername) return;

          await Visitor.updateMany(
            { username: targetUsername },
            {
              $set: { blocked: false },
              $unset: { blockedAt: 1 }
            }
          );

          safeSend(ws, {
            type: "adminActionResult",
            message: `${targetUsername} unblocked successfully.`
          });

          await sendBlockedUsers(room);
          return;
        }

        if (data.type === "adminExportVisitors") {
          if (!isAdminUser(user)) return;

          let visitors = Array.from(allVisitorsCache.values());

          if (visitors.length === 0) {
            const docs = await Visitor.find().sort({ time: -1 }).limit(500).lean();
            visitors = docs.map((v) => ({
              username: v.username,
              contact: v.contact,
              ip: v.ip,
              time: new Date(v.time).toISOString()
            }));
          }

          safeSend(ws, {
            type: "adminVisitorsExport",
            visitors
          });
          return;
        }

        if (data.type === "kick") {
          if (!isAdminUser(user)) return;

          const targetUsername = sanitizeText(data.targetUsername || "");
          if (!targetUsername || targetUsername === user.username) return;

          const targetUser = getRoom(room).find((u) => u.username === targetUsername);
          if (!targetUser) {
            safeSend(ws, {
              type: "adminActionResult",
              message: `${targetUsername} not found online.`
            });
            return;
          }

          targetUser.silentReplacement = true;

          safeSend(targetUser.socket, {
            type: "system",
            message: "You have been kicked out of the room."
          });

          removeUserFromRoomByConnection(room, targetUser.connectionId);
          removeOnlineUserByConnection(room, targetUser.connectionId);

          try {
            targetUser.socket.close();
          } catch (_) {}

          safeSend(ws, {
            type: "adminActionResult",
            message: `${targetUsername} was kicked by admin.`
          });

          sendUserList(room);
          await sendAdminPanels(room);
        }
      } catch (err) {
        console.error("❌ Invalid message format:", err);
      }
    });

    ws.on("close", async () => {
      if (!user) return;

      const stillExists = getRoom(room).some(
        (u) => u.connectionId === user.connectionId
      );

      removeUserFromRoomByConnection(room, user.connectionId);
      removeOnlineUserByConnection(room, user.connectionId);

      if (!user.silentReplacement && stillExists) {
        broadcast(room, {
          type: "system",
          message: `${user.username} left the chat`
        });
      }

      sendUserList(room);
      await sendAdminPanels(room);

      if (rooms[room] && rooms[room].length === 0) {
        delete rooms[room];
        delete onlineUsersByRoom[room];
      }
    });
  } catch (err) {
    console.error("❌ WebSocket connection error:", err);
    try {
      ws.close();
    } catch (_) {}
  }
});

/* -------------------- START -------------------- */
server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});