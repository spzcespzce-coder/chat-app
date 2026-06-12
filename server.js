const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 });

app.use(express.static(path.join(__dirname, 'public')));

// Persistent Database using a JSON file
const DB_FILE = 'users.json';
let dbUsers = {};

if (fs.existsSync(DB_FILE)) {
    try {
        dbUsers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.error("Error reading database:", e);
    }
}

function saveDb() {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbUsers, null, 2));
}

const activeUsers = {}; 

function moderateText(text) {
    const BANNED_WORDS = ['swear1', 'swear2', 'badword']; 
    let moderated = text;
    BANNED_WORDS.forEach(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        moderated = moderated.replace(regex, '■■■■');
    });
    return moderated;
}

function broadcastOnlineUsers() {
    const onlineList = Object.values(activeUsers).map(u => ({ username: u.username, color: u.color }));
    io.emit('online-users-list', onlineList);
}

io.on('connection', (socket) => {
    socket.on('register-account', (data) => {
        const usernameTrim = data.username.trim();
        if (!usernameTrim || !data.password) return socket.emit('auth-response', { success: false, message: 'Invalid input fields.' });
        if (dbUsers[usernameTrim]) return socket.emit('auth-response', { success: false, message: 'Username is taken!' });

        dbUsers[usernameTrim] = {
            password: data.password, 
            color: data.avatarColor || '#007bff',
            friends: []
        };
        saveDb(); 
        socket.emit('auth-response', { success: true, message: 'Account registered! You can now log in.' });
    });

    socket.on('login-account', (data) => {
        const usernameTrim = data.username.trim();
        const userRecord = dbUsers[usernameTrim];

        if (!userRecord || userRecord.password !== data.password) {
            return socket.emit('auth-response', { success: false, message: 'Invalid username or password.' });
        }

        activeUsers[socket.id] = { username: usernameTrim, color: userRecord.color };

        socket.emit('auth-response', { 
            success: true, 
            username: usernameTrim, 
            avatarColor: userRecord.color,
            friends: userRecord.friends
        });

        broadcastOnlineUsers(); 
    });

    socket.on('chat message', (data) => {
        const cleanText = moderateText(data.text);
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const senderSession = activeUsers[socket.id] || {};
        
        const packet = {
            text: cleanText, 
            username: senderSession.username || 'Anonymous', 
            avatarColor: senderSession.color || '#ccc',
            time: timestamp
        };

        io.emit('chat message', packet);
    });

    // Friend System Logic
    socket.on('send-friend-request', (data) => {
        const sender = activeUsers[socket.id]?.username;
        const targetSocketId = Object.keys(activeUsers).find(id => activeUsers[id].username === data.targetName);
        if (targetSocketId && sender) {
            io.to(targetSocketId).emit('incoming-friend-request', { from: sender });
        }
    });

    socket.on('accept-friend-request', (data) => {
        const sender = activeUsers[socket.id]?.username; // The person who clicked "accept"
        const targetName = data.targetName; // The person who sent the request

        if (sender && dbUsers[sender] && !dbUsers[sender].friends.includes(targetName)) {
            dbUsers[sender].friends.push(targetName);
        }
        if (dbUsers[targetName] && !dbUsers[targetName].friends.includes(sender)) {
            dbUsers[targetName].friends.push(sender);
        }
        saveDb(); 
        
        // Update the person who clicked accept
        socket.emit('friends-list-updated', dbUsers[sender].friends);

        // Update the person who sent the request (if they are currently online)
        const targetSocketId = Object.keys(activeUsers).find(id => activeUsers[id].username === targetName);
        if (targetSocketId) {
            io.to(targetSocketId).emit('friends-list-updated', dbUsers[targetName].friends);
        }
    });

    socket.on('disconnect', () => {
        delete activeUsers[socket.id];
        broadcastOnlineUsers(); 
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`System Online on Port ${PORT}`));