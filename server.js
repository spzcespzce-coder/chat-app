const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Persistent in-memory account database 
const dbUsers = {}; 

// Dynamic list of active servers across the app
let activeServers = ['global-lounge', 'coding-zone', 'chatgpt-bot'];

// Tracks active session tokens: socket.id -> { username, color }
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

// Gemini API Interface Handler
async function askActualAI(userPrompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return "🤖 AI Mode: Connect your free GEMINI_API_KEY in Render settings to activate my brain! Right now, I'm running in offline mode.";
    }

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: userPrompt }] }]
            })
        });
        const data = await response.json();
        return data.candidates[0].content.parts[0].text;
    } catch (error) {
        console.error("AI Error:", error);
        return "🤖 Oops! My neural network hit a bump. Try sending that message again.";
    }
}

io.on('connection', (socket) => {

    // 1. Core Registration System
    socket.on('register-account', (data) => {
        const usernameTrim = data.username.trim();
        if (!usernameTrim || !data.password) {
            socket.emit('auth-response', { success: false, message: 'Invalid input parameters.' });
            return;
        }
        if (dbUsers[usernameTrim]) {
            socket.emit('auth-response', { success: false, message: 'Username is already taken!' });
            return;
        }

        dbUsers[usernameTrim] = {
            password: data.password, 
            color: data.avatarColor,
            friends: []
        };
        socket.emit('auth-response', { success: true, message: 'Registration complete! You can now log in.' });
    });

    // 2. Secure Account Login Validation
    socket.on('login-account', (data) => {
        const usernameTrim = data.username.trim();
        const userRecord = dbUsers[usernameTrim];

        if (!userRecord || userRecord.password !== data.password) {
            socket.emit('auth-response', { success: false, message: 'Invalid username or password configuration.' });
            return;
        }

        // Link live socket to validated user identity
        activeUsers[socket.id] = {
            username: usernameTrim,
            color: userRecord.color
        };

        socket.emit('auth-response', { 
            success: true, 
            username: usernameTrim, 
            avatarColor: userRecord.color,
            servers: activeServers,
            friends: userRecord.friends
        });
        console.log(`${usernameTrim} securely authenticated onto the server.`);
    });

    // 3. Custom Server Creation Network Engine
    socket.on('create-server', (serverName) => {
        const cleanName = serverName.toLowerCase().trim().replace(/[^a-z0-9-_]/g, '-');
        if (cleanName && !activeServers.includes(cleanName)) {
            activeServers.push(cleanName);
            io.emit('server-list-updated', activeServers);
        }
    });

    // 4. Client Side Profile Configuration Upgrades
    socket.on('update-profile-settings', (data) => {
        const activeSession = activeUsers[socket.id];
        if (activeSession && dbUsers[activeSession.username]) {
            dbUsers[activeSession.username].color = data.color;
            activeSession.color = data.color;
            socket.emit('profile-settings-updated', { color: data.color });
        }
    });

    // 5. Global Message Router
    socket.on('chat message', async (data) => {
        const cleanText = moderateText(data.text);
        const packet = {
            text: cleanText,
            username: data.username,
            avatarColor: data.avatarColor,
            room: data.room 
        };

        if (data.room === 'chatgpt-bot') {
            const aiResponse = await askActualAI(data.text);
            socket.emit('chat message', {
                text: aiResponse,
                username: "ChatGPT",
                avatarColor: "#10b981",
                room: 'chatgpt-bot'
            });
        } else if (data.room.startsWith('dm-')) {
            const targetName = data.room.split('-')[1];
            const targetSocketId = Object.keys(activeUsers).find(id => activeUsers[id].username === targetName);
            
            if (targetSocketId) {
                io.to(targetSocketId).emit('chat message', {
                    text: cleanText,
                    username: data.username,
                    avatarColor: data.avatarColor,
                    room: `dm-${data.username}` 
                });
            }
        } else {
            socket.broadcast.emit('chat message', packet);
        }
    });

    // 6. Live Friend Requests Engine
    socket.on('send-friend-request', (data) => {
        const sender = activeUsers[socket.id]?.username;
        const targetSocketId = Object.keys(activeUsers).find(id => activeUsers[id].username === data.targetName);

        if (targetSocketId && sender) {
            io.to(targetSocketId).emit('incoming-friend-request', { from: sender });
        }
    });

    socket.on('accept-friend-request', (data) => {
        const sender = activeUsers[socket.id]?.username;
        const targetSocketId = Object.keys(activeUsers).find(id => activeUsers[id].username === data.targetName);

        if (sender && dbUsers[sender] && !dbUsers[sender].friends.includes(data.targetName)) {
            dbUsers[sender].friends.push(data.targetName);
        }
        if (dbUsers[data.targetName] && !dbUsers[data.targetName].friends.includes(sender)) {
            dbUsers[data.targetName].friends.push(sender);
        }

        if (targetSocketId && sender) {
            io.to(targetSocketId).emit('friend-request-accepted', { from: sender });
        }
    });

    socket.on('disconnect', () => {
        delete activeUsers[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Talking App Secure System Online on Port ${PORT}`);
});