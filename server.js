const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Tracks active connections: socket.id -> { username, color }
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

// Actual AI Integration function using Google's free Gemini API
async function askActualAI(userPrompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return "🤖 AI Mode: Connect your free GEMINI_API_KEY in Render settings to activate my brain! Right now, I'm running in offline mode.";
    }

    try {
       // Change this line inside your askActualAI function:
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
    // 1. Register User Identity
    socket.on('register-user', (data) => {
        activeUsers[socket.id] = {
            username: data.username,
            color: data.avatarColor
        };
        console.log(`${data.username} registered on network.`);
    });

    // 2. Multi-Room & Global Chat Router
    socket.on('chat message', async (data) => {
        const cleanText = moderateText(data.text);
        
        const packet = {
            text: cleanText,
            username: data.username,
            avatarColor: data.avatarColor,
            room: data.room 
        };

        if (data.room === 'chatgpt-bot') {
            // Process Live AI Query
            const aiResponse = await askActualAI(data.text);
            socket.emit('chat message', {
                text: aiResponse,
                username: "ChatGPT",
                avatarColor: "#10b981",
                room: 'chatgpt-bot'
            });
        } else if (data.room.startsWith('dm-')) {
            // Route Private Direct Message to specific recipient username
            const targetName = data.room.split('-')[1];
            const targetSocketId = Object.keys(activeUsers).find(id => activeUsers[id].username === targetName);
            
            if (targetSocketId) {
                io.to(targetSocketId).emit('chat message', {
                    text: cleanText,
                    username: data.username,
                    avatarColor: data.avatarColor,
                    room: `dm-${data.username}` // Inverts room name so recipient maps it correctly
                });
            }
        } else {
            // Standard Server Broadcast
            socket.broadcast.emit('chat message', packet);
        }
    });

    // 3. Live Friend Request Handling
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
    console.log(`Talking App Online on Port ${PORT}`);
});