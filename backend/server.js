require('dotenv').config(); 
const express = require('express');
const mysql = require('mysql2/promise'); 
const redis = require('redis');
const cors = require('cors');
const client = require('prom-client');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors()); 
app.use(express.json()); 

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDurationMicroseconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10] 
});

app.use((req, res, next) => {
  const end = httpRequestDurationMicroseconds.startTimer();
  
  res.on('finish', () => {

    end({ route: req.route ? req.route.path : req.path, code: res.statusCode, method: req.method });
  });
  next();
});

let dbPool;

async function initializeMySQL() {
    const dbHost = process.env.DB_HOST;
    const dbUser = process.env.DB_USER;
    const dbPassword = process.env.DB_PASSWORD;
    const dbName = process.env.DB_NAME;

    if (!dbHost || !dbUser || !dbPassword || !dbName) {
        console.error('Missing critical MySQL environment variables (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME).');
        process.exit(1);
    }

    let initialConnection;
    try {
        initialConnection = await mysql.createConnection({
            host: dbHost,
            user: dbUser,
            password: dbPassword
        });
        console.log(`Temporarily connected to MySQL server at ${dbHost} to check database.`);

        await initialConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`);
        console.log(`Database '${dbName}' ensured to exist.`);
        await initialConnection.end(); 
        console.log('Temporary connection closed.');

        dbPool = await mysql.createPool({
            host: dbHost,
            user: dbUser,
            password: dbPassword,
            database: dbName, 
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });
        console.log(`Successfully created connection pool to MySQL database '${dbName}'.`);

        await dbPool.execute(`
            CREATE TABLE IF NOT EXISTS messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log(`Table 'messages' checked/created in database '${dbName}'.`);

    } catch (error) {
        console.error(`Failed during MySQL initialization (for database '${dbName}'):`, error);
        if (initialConnection) {
            try {
                await initialConnection.end();
                console.log('Ensured temporary connection is closed after error.');
            } catch (closeError) {
                console.error('Error closing temporary connection:', closeError);
            }
        }
        process.exit(1); 
    }
}


let redisClient;
const REDIS_MESSAGES_KEY = 'guestbook:messages';

async function initializeRedis() {
    const redisHost = process.env.REDIS_HOST;
    const redisPort = process.env.REDIS_PORT;
    const redisPassword = process.env.REDIS_PASSWORD;

    if (!redisHost || !redisPort) {
        console.warn('Missing REDIS_HOST or REDIS_PORT. Redis caching will be disabled.');
        return;
    }

    const redisUrl = redisPassword
        ? `redis://:${redisPassword}@${redisHost}:${redisPort}`
        : `redis://${redisHost}:${redisPort}`;
    
    console.log(`Attempting to connect to Redis at: ${redisHost}:${redisPort}`);

    redisClient = redis.createClient({
        url: redisUrl
    });

    redisClient.on('error', (err) => console.error('Redis Client Error:', err));
    redisClient.on('connect', () => console.log('Successfully connected to Redis.'));
    
    try {
        await redisClient.connect();
    } catch (error) {
        console.error('Failed to connect to Redis during initialization:', error);
    }
}

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/api/messages', async (req, res) => {
    try {
        if (redisClient && redisClient.isOpen) {
            const cachedMessages = await redisClient.get(REDIS_MESSAGES_KEY);
            if (cachedMessages) {
                console.log('Serving messages from Redis cache');
                return res.json(JSON.parse(cachedMessages));
            }
        } else {
            console.log('Redis client not available or not open, skipping cache lookup.');
        }
        if (!dbPool) {
            return res.status(503).json({ error: 'Database service not available.' });
        }
        console.log('Fetching messages from MySQL');
        const [rows] = await dbPool.query('SELECT id, content, created_at FROM messages ORDER BY created_at DESC');
        if (redisClient && redisClient.isOpen) {
            await redisClient.setEx(REDIS_MESSAGES_KEY, 3600, JSON.stringify(rows));
            console.log('Messages cached in Redis');
        }
        
        res.json(rows);
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ error: 'Failed to retrieve messages' });
    }
});

app.post('/api/messages', async (req, res) => {
    const { content } = req.body;

    if (!content || content.trim() === '') {
        return res.status(400).json({ error: 'Message content cannot be empty' });
    }

    try {
        if (!dbPool) {
            return res.status(503).json({ error: 'Database service not available.' });
        }
        const [result] = await dbPool.execute(
            'INSERT INTO messages (content) VALUES (?)',
            [content.trim()]
        );
        const newMessageId = result.insertId;

        if (redisClient && redisClient.isOpen) {
            await redisClient.del(REDIS_MESSAGES_KEY);
            console.log('Redis cache for messages invalidated.');
        }  else {
            console.log('Redis client not available or not open, skipping cache invalidation.');
        }

        const [newMessages] = await dbPool.query('SELECT id, content, created_at FROM messages WHERE id = ?', [newMessageId]);
        res.status(201).json(newMessages[0]);

    } catch (error) {
        console.error('Error posting message:', error);
        res.status(500).json({ error: 'Failed to post message' });
    }
});

async function startServer() {
    await initializeMySQL();
    
    await initializeRedis();

    app.listen(port, () => {
        console.log(`Backend server running at http://localhost:${port}`);
        console.log(`API endpoints available at http://localhost:${port}/api/messages`);
        console.log(`Metrics available at http://localhost:${port}/metrics`);
    });
}

startServer();