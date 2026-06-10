const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Simple moderation filter list (Add any words you want to block here in lowercase)
const BANNED_WORDS = ['swear1', 'swear2', 'badword', 'ass', 'bitch', 'fuck']; 

function moderateText(text) {
    let moderated = text;
    BANNED_WORDS.forEach(word => {
        // Creates a regular expression to find the word safely case-insensitive
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        moderated = moderated.replace(regex, '■■■■');
    });
    return moderated;
}

io.on('connection', (socket) => {
    console.log('A user connected!');

    // Listen for incoming message objects containing text and user profile data
    socket.on('chat message', (data) => {
        // Moderate the text before sending it to anyone
        const cleanText = moderateText(data.text);
        
        const packet = {
            text: cleanText,
            username: data.username,
            avatarColor: data.avatarColor
        };

        // Broadcast the cleaned message package to everyone else
        socket.broadcast.emit('chat message', packet);
    });

    socket.on('disconnect', () => {
        console.log('A user disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});