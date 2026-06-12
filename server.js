const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e7 // Up to 10MB for avatar images
});

app.use(express.static(path.join(__dirname, 'public')));

// File system database configuration
const DB_FILE = path.join(__dirname, 'users.json');
let dbUsers = {};

// Load accounts dynamically on startup
if (fs.existsSync(DB_FILE)) {
    try {
        dbUsers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.error("Error reading database file:", e);
        dbUsers = {};
    }
}

function saveDatabase() {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbUsers, null, 2), 'utf8');
}

let activeServers = ['global-lounge', 'coding-zone', 'chatgpt-bot'];
const activeUsers = {}; // Tracks socket.id -> { username, color, avatarImage }

const BANNED_WORDS = ['swear1', 'swear2', 'badword', 'ass', 'bitch', 'fuck']; 
function moderateText(text) {
    let moderated = text;
    BANNED_WORDS.forEach(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        moderated = moderated.replace(regex, '■■■■');
    });
    return moderated;
}

async function askActualAI(userPrompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return "🤖 Connect your GEMINI_API_KEY in Render settings to wake up my AI brain!";
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: userPrompt }] }] })
        });
        const data = await response.json();
        return data.candidates[0].content.parts[0].text;
    } catch (error) {
        console.error("AI Error:", error);
        return "🤖 Oops! My neural network hit a bump.";
    }
}

// Broadcasts online list updates to everyone connected
function broadcastOnlineRoster() {
    const roster = Object.values(activeUsers).map(u => ({
        username: u.username,
        color: u.color,
        avatarImage: u.avatarImage
    }));
    io.emit('online-roster-updated', roster);
}

io.on('connection', (socket) => {
    socket.on('register-account', (data) => {
        const usernameTrim = data.username.trim();
        if (!usernameTrim || !data.password) return socket.emit('auth-response', { success: false, message: 'Invalid input fields.' });
        if (dbUsers[usernameTrim]) return socket.emit('auth-response', { success: false, message: 'Username is taken!' });

        dbUsers[usernameTrim] = {
            password: data.password, 
            color: data.avatarColor || '#4f46e5',
            avatarImage: data.avatarImage || null,
            friends: []
        };
        saveDatabase();
        socket.emit('auth-response', { success: true, message: 'Account registered! Logging you in...' });
    });

    socket.on('login-account', (data) => {
        const usernameTrim = data.username.trim();
        const userRecord = dbUsers[usernameTrim];

        if (!userRecord || userRecord.password !== data.password) {
            return socket.emit('auth-response', { success: false, message: 'Invalid username or password.' });
        }

        activeUsers[socket.id] = { 
            username: usernameTrim, 
            color: userRecord.color, 
            avatarImage: userRecord.avatarImage 
        };

        socket.emit('auth-response', { 
            success: true, 
            username: usernameTrim, 
            avatarColor: userRecord.color, 
            avatarImage: userRecord.avatarImage,
            servers: activeServers, 
            friends: userRecord.friends
        });
        
        broadcastOnlineRoster();
    });

    socket.on('create-server', (serverName) => {
        const cleanName = serverName.toLowerCase().trim().replace(/[^a-z0-9-_]/g, '-');
        if (cleanName && !activeServers.includes(cleanName)) {
            activeServers.push(cleanName);
            io.emit('server-list-updated', activeServers);
        }
    });

    socket.on('update-profile-settings', (data) => {
        const activeSession = activeUsers[socket.id];
        if (activeSession && dbUsers[activeSession.username]) {
            if (data.color) {
                dbUsers[activeSession.username].color = data.color;
                activeSession.color = data.color;
            }
            if (data.avatarImage) {
                dbUsers[activeSession.username].avatarImage = data.avatarImage;
                activeSession.avatarImage = data.avatarImage;
            }
            socket.emit('profile-settings-updated', { color: activeSession.color, avatarImage: activeSession.avatarImage });
            broadcastOnlineRoster();
        }
    });

    socket.on('chat message', async (data) => {
        const activeSession = activeUsers[socket.id];
        if (!activeSession) return;

        const cleanText = moderateText(data.text);
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        const packet = {
            text: cleanText, 
            username: activeSession.username, 
            avatarColor: activeSession.color,
            avatarImage: activeSession.avatarImage,
            room: data.room, 
            time: timestamp
        };

        if (data.room === 'chatgpt-bot') {
            // Echo user message back to themselves locally first
            socket.emit('chat message', packet);
            const aiResponse = await askActualAI(data.text);
            socket.emit('chat message', {
                text: aiResponse, username: "ChatGPT", avatarColor: "#10b981", avatarImage: null,
                room: 'chatgpt-bot', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        } else if (data.room.startsWith('dm-')) {
            const targetName = data.room.split('-')[1];
            // Send to sender
            socket.emit('chat message', packet);
            // Locate target user and send to them under their corresponding private room name
            const targetSocketId = Object.keys(activeUsers).find(id => activeUsers[id].username === targetName);
            if (targetSocketId) {
                io.to(targetSocketId).emit('chat message', { ...packet, room: `dm-${activeSession.username}` });
            }
        } else {
            // Standard channel broadcast
            io.emit('chat message', packet);
        }
    });

    socket.on('send-friend-request', (data) => {
        const sender = activeUsers[socket.id]?.username;
        if (!sender || sender === data.targetName) return;

        const targetSocketId = Object.keys(activeUsers).find(id => activeUsers[id].username === data.targetName);
        if (targetSocketId) {
            io.to(targetSocketId).emit('incoming-friend-request', { from: sender });
        }
    });

    socket.on('accept-friend-request', (data) => {
        const sender = activeUsers[socket.id]?.username;
        const targetName = data.targetName;

        if (!sender || !dbUsers[sender] || !dbUsers[targetName]) return;

        if (!dbUsers[sender].friends.includes(targetName)) dbUsers[sender].friends.push(targetName);
        if (!dbUsers[targetName].friends.includes(sender)) dbUsers[targetName].friends.push(sender);
        
        saveDatabase();

        // Update frontends instantly
        socket.emit('friend-list-updated', dbUsers[sender].friends);
        
        const targetSocketId = Object.keys(activeUsers).find(id => activeUsers[id].username === targetName);
        if (targetSocketId) {
            io.to(targetSocketId).emit('friend-list-updated', dbUsers[targetName].friends);
            io.to(targetSocketId).emit('friend-request-accepted', { from: sender });
        }
    });

    socket.on('disconnect', () => {
        delete activeUsers[socket.id];
        broadcastOnlineRoster();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`System Online on Port ${PORT}`));