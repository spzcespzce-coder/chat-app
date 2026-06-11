const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e7 // Up to 10MB for avatar images
});

app.use(express.static(path.join(__dirname, 'public')));

// Persistent server-side account database
const dbUsers = {}; 
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
        console.error("AI Error:", error);
        return "🤖 Oops! My neural network hit a bump.";
    }
}

io.on('connection', (socket) => {
    socket.on('register-account', (data) => {
        const usernameTrim = data.username.trim();
        if (!usernameTrim || !data.password) return socket.emit('auth-response', { success: false, message: 'Invalid input fields.' });
        if (dbUsers[usernameTrim]) return socket.emit('auth-response', { success: false, message: 'Username is taken!' });

        dbUsers[usernameTrim] = {
            password: data.password, 
            color: data.avatarColor,
            avatarImage: data.avatarImage || null,
            friends: []
        };
        socket.emit('auth-response', { success: true, message: 'Account registered! Logging you in...' });
    });

    socket.on('login-account', (data) => {
        const usernameTrim = data.username.trim();
        const userRecord = dbUsers[usernameTrim];

        if (!userRecord || userRecord.password !== data.password) {
            return socket.emit('auth-response', { success: false, message: 'Invalid username or password.' });
        }

        activeUsers[socket.id] = { username: usernameTrim, color: userRecord.color, avatarImage: userRecord.avatarImage };

        socket.emit('auth-response', { 
            success: true, username: usernameTrim, 
            avatarColor: userRecord.color, avatarImage: userRecord.avatarImage,
            servers: activeServers, friends: userRecord.friends
        });
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
        }
    });

    socket.on('chat message', async (data) => {
        const cleanText = moderateText(data.text);
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const senderSession = activeUsers[socket.id] || {};
        
        const packet = {
            text: cleanText, username: data.username, 
            avatarColor: senderSession.color || data.avatarColor,
            avatarImage: senderSession.avatarImage || null,
            room: data.room, time: timestamp
        };

        if (data.room === 'chatgpt-bot') {
            const aiResponse = await askActualAI(data.text);
            socket.emit('chat message', {
                text: aiResponse, username: "ChatGPT", avatarColor: "#10b981", avatarImage: null,
                room: 'chatgpt-bot', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        } else if (data.room.startsWith('dm-')) {
            const targetName = data.room.split('-')[1];
            const targetSocketId = Object.keys(activeUsers).find(id => activeUsers[id].username === targetName);
            if (targetSocketId) {
                io.to(targetSocketId).emit('chat message', { ...packet, room: `dm-${data.username}` });
            }
        } else {
            socket.broadcast.emit('chat message', packet);
        }
    });

    socket.on('send-friend-request', (data) => {
        const sender = activeUsers[socket.id]?.username;
        const targetSocketId = Object.keys(activeUsers).find(id => activeUsers[id].username === data.targetName);
        if (targetSocketId && sender) io.to(targetSocketId).emit('incoming-friend-request', { from: sender });
    });

    socket.on('accept-friend-request', (data) => {
        const sender = activeUsers[socket.id]?.username;
        const targetSocketId = Object.keys(activeUsers).find(id => activeUsers[id].username === data.targetName);

        if (sender && dbUsers[sender] && !dbUsers[sender].friends.includes(data.targetName)) dbUsers[sender].friends.push(data.targetName);
        if (dbUsers[data.targetName] && !dbUsers[data.targetName].friends.includes(sender)) dbUsers[data.targetName].friends.push(sender);

        if (targetSocketId && sender) io.to(targetSocketId).emit('friend-request-accepted', { from: sender });
    });

    socket.on('disconnect', () => delete activeUsers[socket.id]);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`System Online on Port ${PORT}`));