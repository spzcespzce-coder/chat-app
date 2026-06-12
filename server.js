const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e7
});

// Serve static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Persistent Database using a JSON file
const DB_FILE = 'users.json';
let dbUsers = {};

// Load existing users if the file exists
if (fs.existsSync(DB_FILE)) {
    try {
        dbUsers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.error("Error reading database:", e);
    }
}

// Function to save to database
function saveDb() {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbUsers, null, 2));
}

let activeServers = ['global-lounge', 'coding-zone', 'chatgpt-bot'];
const activeUsers = {}; // Tracks currently online users

const BANNED_WORDS = ['swear1', 'swear2', 'badword']; 
function moderateText(text) {
    let moderated = text;
    BANNED_WORDS.forEach(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        moderated = moderated.replace(regex, '■■■■');
    });
    return moderated;
}

// Broadcasts the current online users to everyone
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
        saveDb(); // Save to file
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

        broadcastOnlineUsers(); // Update online list for everyone
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

        // Broadcast to everyone
        io.emit('chat message', packet);
    });

    socket.on('send-friend-request', (data) => {
        const sender = activeUsers[socket.id]?.username;
        const targetSocketId = Object.keys(activeUsers).find(id => activeUsers[id].username === data.targetName);
        if (targetSocketId && sender) io.to(targetSocketId).emit('incoming-friend-request', { from: sender });
    });

    socket.on('accept-friend-request', (data) => {
        const sender = activeUsers[socket.id]?.username;
        if (sender && dbUsers[sender] && !dbUsers[sender].friends.includes(data.targetName)) {
            dbUsers[sender].friends.push(data.targetName);
        }
        if (dbUsers[data.targetName] && !dbUsers[data.targetName].friends.includes(sender)) {
            dbUsers[data.targetName].friends.push(sender);
        }
        saveDb(); // Save new friends to file
    });

    socket.on('disconnect', () => {
        delete activeUsers[socket.id];
        broadcastOnlineUsers(); // Update online list when someone leaves
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`System Online on Port ${PORT}`));