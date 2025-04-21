const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const url = require('url');
const mongoose = require('mongoose');
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/chatVisitors';  
mongoose.connect(mongoURI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = {};
const bannedWords = ['badword1', 'badword2'];
const bannedUsers = {};


mongoose.connect('mongodb://localhost:27017/chatVisitors')
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => console.error('❌ MongoDB connection error:', err));


const visitorSchema = new mongoose.Schema({
    ip: String,
    username: String,
    contact: {type: String, required: true },
    time: { type: Date, default: Date.now }
});
const Visitor = mongoose.model('Visitor', visitorSchema);


function logVisitor(ip, username, contact) {
    const visitor = new Visitor({ ip, username, contact });
    visitor.save()
        .then(() => console.log(`📥 Visitor saved: ${username} (${ip})`))
        .catch(err => console.error('❌ Error saving visitor:', err));
}


function containsBannedWords(message) {
    return bannedWords.some(word => message.toLowerCase().includes(word.toLowerCase()));
}

wss.on('connection', function connection(ws, req) {
    const parameters = url.parse(req.url, true);
    const room = parameters.query.room || 'default';
    const username = parameters.query.username || 'Anonymous';
    const contact = parameters.query.contact;
    if (!contact) {
        ws.send(JSON.stringify({
            type: 'system',
            message: 'Contact number is required to join the chat.'
        }));
        ws.close();
        return;
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    logVisitor(ip, username, contact); 

    if (!rooms[room]) rooms[room] = [];

    if (bannedUsers[room] && bannedUsers[room].includes(username)) {
        ws.close();
        return;
    }

    const user = { socket: ws, username: username };
    rooms[room].push(user);

    broadcast(room, {
        type: 'system',
        message: `${user.username} has joined the chat!`
    });

    sendUserList(room);

    ws.on('message', function incoming(message) {
        try {
            const data = JSON.parse(message);

            if (data.type === 'join') {
                user.username = data.username;
                broadcast(room, {
                    type: '🤗',
                    message: `${data.username} joined the chat`
                });
                sendUserList(room);
            }

            if (data.type === 'message' && containsBannedWords(data.message)) {
                ws.send(JSON.stringify({
                    type: 'system',
                    message: 'Your message contains inappropriate language and was not sent.'
                }));
                return;
            }

            if (data.type === 'message') {
                broadcast(room, {
                    type: 'message',
                    username: user.username,
                    usernameColor: data.usernameColor,
                    message: data.message
                });
            }

            if (data.type === 'privateMessage') {
                const targetUser = rooms[room].find(u => u.username === data.recipient);
                if (targetUser) {
                    targetUser.socket.send(JSON.stringify({
                        type: 'privateMessage',
                        username: user.username,
                        message: data.message
                    }));
                }
            }

            if (data.type === 'typing') {
                broadcast(room, {
                    type: 'typing',
                    username: user.username,
                    typing: data.typing
                });
            }

            if (data.type === 'kick') {
                const isAdmin = user.username === 'admin';
                if (isAdmin && data.targetUsername && data.targetUsername !== user.username) {
                    const targetUser = rooms[room].find(u => u.username === data.targetUsername);
                    if (targetUser) {
                        targetUser.socket.send(JSON.stringify({
                            type: '*',
                            message: 'You have been kicked out of the room.'
                        }));
                        targetUser.socket.close();
                        rooms[room] = rooms[room].filter(u => u !== targetUser);

                        broadcast(room, {
                            type: '$*',
                            message: `${data.targetUsername} was kicked by admin.`
                        });
                        sendUserList(room);
                    }
                }
            }

        } catch (err) {
            console.error('Invalid message format', err);
        }
    });

    ws.on('close', function () {
        rooms[room] = rooms[room].filter(u => u.socket !== ws);
        broadcast(room, {
            type: 'system',
            message: `${user.username} left the chat`
        });
        sendUserList(room);
        if (rooms[room].length === 0) {
            delete rooms[room];
        }
    });
});

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
    const userList = rooms[room].map(user => user.username);
    broadcast(room, {
        type: 'userlist',
        users: userList
    });
}

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
