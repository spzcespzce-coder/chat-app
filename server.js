const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e7 // Supports up to 10MB data buffers
});

app.use(express.static(path.join(__dirname, 'public')));

// Persistent Local File Database Configuration
const DB_PATH = path.join(__dirname, 'database.json');
let userDatabase = {};

if (fs.existsSync(DB_PATH)) {
    try {
        userDatabase = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch (err) {
        console.error("Database file initialization error, resetting record collection:", err);
        userDatabase = {};
    }
}

function commitDatabaseToDisk() {
    fs.writeFileSync(DB_PATH, JSON.stringify(userDatabase, null, 4), 'utf8');
}

// Global default room data configurations
let systemChannels = ['global-lounge', 'coding-zone', 'chatgpt-bot'];
const activeOnlineConnections = {}; // Tracks: socket.id -> { username, color, initial }

// Simple Profanity filter
const BANNED_TERMS = ['swear1', 'swear2', 'badword'];
function filterContentText(rawText) {
    let outputText = rawText;
    BANNED_TERMS.forEach(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        outputText = outputText.replace(regex, '■■■■');
    });
    return outputText;
}

// Google Gemini Pro Brain Integration Fetch Routine
async function queryGeminiModel(promptMessage) {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
        return "🤖 [System Alert]: Connect your GEMINI_API_KEY in environment settings to wake up my AI engine!";
    }
    
    try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: promptMessage }] }]
            })
        });
        const data = await response.json();
        return data.candidates[0].content.parts[0].text;
    } catch (error) {
        console.error("Gemini AI API connection exception:", error);
        return "🤖 Error: My neural pipeline encountered an unexpected network disruption.";
    }
}

// Broadcasts everyone currently logged in to the active roster panel
function synchronizeOnlineRoster() {
    const list = Object.values(activeOnlineConnections).map(connection => ({
        username: connection.username,
        color: connection.color,
        initial: connection.initial || connection.username.charAt(0).toUpperCase()
    }));
    io.emit('online-roster-updated', list);
}

io.on('connection', (socket) => {

    // ACCOUNT CREATION ENGINE
    socket.on('register-account', (payload) => {
        const username = payload.username ? payload.username.trim() : "";
        if (!username || !payload.password) {
            return socket.emit('auth-response', { success: false, message: 'Inputs cannot be blank!' });
        }
        if (userDatabase[username.toLowerCase()]) {
            return socket.emit('auth-response', { success: false, message: 'Username is already taken.' });
        }

        userDatabase[username.toLowerCase()] = {
            displayName: username,
            password: payload.password,
            color: payload.avatarColor || '#6366f1',
            initial: username.charAt(0).toUpperCase(),
            friends: []
        };
        commitDatabaseToDisk();
        socket.emit('auth-response', { success: true, message: 'Registration complete! Logging in...' });
    });

    // ACCOUNT LOGIN ENGINE
    socket.on('login-account', (payload) => {
        const usernameKey = payload.username ? payload.username.trim().toLowerCase() : "";
        const profile = userDatabase[usernameKey];

        if (!profile || profile.password !== payload.password) {
            return socket.emit('auth-response', { success: false, message: 'Invalid username or password match.' });
        }

        // Save session state map onto the socket link
        activeOnlineConnections[socket.id] = {
            username: profile.displayName,
            color: profile.color,
            initial: profile.initial
        };

        socket.emit('auth-response', {
            success: true,
            username: profile.displayName,
            avatarColor: profile.color,
            initial: profile.initial,
            servers: systemChannels,
            friends: profile.friends
        });

        synchronizeOnlineRoster();
    });

    // USER SETTINGS UPDATING CONTROLLER
    socket.on('update-profile-settings', (payload) => {
        const currentSession = activeOnlineConnections[socket.id];
        if (!currentSession) return;

        const dbUserKey = currentSession.username.toLowerCase();
        if (userDatabase[dbUserKey]) {
            if (payload.color) {
                userDatabase[dbUserKey].color = payload.color;
                currentSession.color = payload.color;
            }
            if (payload.initial) {
                const cleanInitial = payload.initial.trim().toUpperCase().charAt(0);
                if (cleanInitial) {
                    userDatabase[dbUserKey].initial = cleanInitial;
                    currentSession.initial = cleanInitial;
                }
            }
            commitDatabaseToDisk();
            
            // Confirm to updating client
            socket.emit('profile-settings-updated', {
                color: currentSession.color,
                initial: currentSession.initial
            });
            
            // Sync new visual avatar records down to all peer display elements
            synchronizeOnlineRoster();
        }
    });

    // CHANNELS ADDITION ENGINE
    socket.on('create-server', (channelName) => {
        const formatted = channelName.toLowerCase().trim().replace(/[^a-z0-9-_]/g, '-');
        if (formatted && !systemChannels.includes(formatted)) {
            systemChannels.push(formatted);
            io.emit('server-list-updated', systemChannels);
        }
    });

    // UNIFIED CHAT MESSAGING PIPELINE (Rooms, Channels, and DMs)
    socket.on('chat message', async (payload) => {
        const session = activeOnlineConnections[socket.id];
        if (!session) return;

        const filteredMessage = filterContentText(payload.text);
        const systemTimestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const messagePacket = {
            text: filteredMessage,
            username: session.username,
            avatarColor: session.color,
            initial: session.initial,
            room: payload.room,
            time: systemTimestamp
        };

        if (payload.room === 'chatgpt-bot') {
            // Echo sender message back to them locally inside AI space
            socket.emit('chat message', messagePacket);
            
            // Fetch live data directly from Gemini Engine model
            const botReply = await queryGeminiModel(payload.text);
            socket.emit('chat message', {
                text: botReply,
                username: "Gemini AI Brain",
                avatarColor: "#10b981",
                initial: "🤖",
                room: 'chatgpt-bot',
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        } else if (payload.room.startsWith('dm-')) {
            // Targeted Direct Message Delivery route pipeline execution
            const targetRecipientName = payload.room.split('-')[1];
            
            // Deliver to sender interface screen instance
            socket.emit('chat message', messagePacket);

            // Locate targeted friend recipient connection stream resource link
            const targetSocketId = Object.keys(activeOnlineConnections).find(
                id => activeOnlineConnections[id].username.toLowerCase() === targetRecipientName.toLowerCase()
            );

            if (targetSocketId) {
                io.to(targetSocketId).emit('chat message', {
                    ...messagePacket,
                    room: `dm-${session.username}`
                });
            }
        } else {
            // General Channel broadcast message rule execution
            io.emit('chat message', messagePacket);
        }
    });

    // SEARCH & INSTANT FRIEND SYSTEM PIPELINE
    socket.on('add-friend-search', (payload) => {
        const senderSession = activeOnlineConnections[socket.id];
        if (!senderSession) return;

        const targetSearchName = payload.targetName ? payload.targetName.trim() : "";
        const senderKey = senderSession.username.toLowerCase();
        const targetKey = targetSearchName.toLowerCase();

        if (!targetSearchName) {
            return socket.emit('search-alert', { success: false, message: 'Please enter a name to search.' });
        }
        if (senderKey === targetKey) {
            return socket.emit('search-alert', { success: false, message: 'You cannot add yourself as a friend.' });
        }
        if (!userDatabase[targetKey]) {
            return socket.emit('search-alert', { success: false, message: `User "${targetSearchName}" not found.` });
        }
        
        const senderFriendsList = userDatabase[senderKey].friends || [];
        if (senderFriendsList.includes(userDatabase[targetKey].displayName)) {
            return socket.emit('search-alert', { success: false, message: 'User is already on your friends list!' });
        }

        // Establish matching relationship maps persistently inside databases profiles
        userDatabase[senderKey].friends.push(userDatabase[targetKey].displayName);
        userDatabase[targetKey].friends.push(userDatabase[senderKey].displayName);
        commitDatabaseToDisk();

        // Push layout updates dynamically to active client
        socket.emit('friend-list-updated', userDatabase[senderKey].friends);
        socket.emit('search-alert', { success: true, message: `Successfully added ${userDatabase[targetKey].displayName}!` });

        // If your new friend is currently online, update their UI instantly
        const friendSocketId = Object.keys(activeOnlineConnections).find(
            id => activeOnlineConnections[id].username.toLowerCase() === targetKey
        );
        if (friendSocketId) {
            io.to(friendSocketId).emit('friend-list-updated', userDatabase[targetKey].friends);
        }
    });

    socket.on('disconnect', () => {
        delete activeOnlineConnections[socket.id];
        synchronizeOnlineRoster();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`>>> CHAT CORE RUNNING ON PORT ${PORT} <<<`));