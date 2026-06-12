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

app.use(express.static(path.join(__dirname, 'public')));

// File database setup
const DB_FILE = path.join(__dirname, 'users.json');
let dbUsers = {};

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
const activeUsers = {}; 

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
        return "🤖 Oops! My neural network hit a bump.";
    }
}

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
            socket.emit('chat message', packet);
            const aiResponse = await askActualAI(data.text);
            socket.emit('chat message', {
                text: aiResponse, username: "ChatGPT", avatarColor: "#10b981", avatarImage: null,
                room: 'chatgpt-bot', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        } else if (data.room.startsWith('dm-')) {
            const targetName = data.room.split('-')[1];
            socket.emit('chat message', packet);
            const targetSocketId = Object.keys(activeUsers).find(id => activeUsers[id].username === targetName);
            if (targetSocketId) {
                io.to(targetSocketId).emit('chat message', { ...packet, room: `dm-${activeSession.username}` });
            }
        } else {
            io.emit('chat message', packet);
        }
    });

    // SIMPLIFIED INSTANT FRIEND SYSTEM
    socket.on('add-friend-instant', (data) => {
        const sender = activeUsers[socket.id]?.username;
        const targetName = data.targetName;

        if (!sender || !dbUsers[sender] || !dbUsers[targetName] || sender === targetName) return;

        // Seamlessly add each other to respective lists
        if (!dbUsers[sender].friends.includes(targetName)) {
            dbUsers[sender].friends.push(targetName);
        }
        if (!dbUsers[targetName].friends.includes(sender)) {
            dbUsers[targetName].friends.push(sender);
        }
        
        saveDatabase();

        // Push new friend list values down instantly
        socket.emit('friend-list-updated', dbUsers[sender].friends);
        
        const targetSocketId = Object.keys(activeUsers).find(id => activeUsers[id].username === targetName);
        if (targetSocketId) {
            io.to(targetSocketId).emit('friend-list-updated', dbUsers[targetName].friends);
        }
    });

    socket.on('disconnect', () => {
        delete activeUsers[socket.id];
        broadcastOnlineRoster();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`System Online on Port ${PORT}`));