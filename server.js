// ==================== ADVANCED LMS - SERVER.JS (PRODUCTION READY V2.0) ====================
console.log("🚀 Starting Advanced LMS Server v2.0 - Full Feature Update...");

const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const cron = require('node-cron');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
require('dotenv').config();

const app = express();

const PORT = process.env.PORT || 3000;

// ==================== CONFIG ====================
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'super_secret_change_this_in_production';
const DEFAULT_MEET = process.env.DEFAULT_MEET_LINK || 'https://meet.google.com/qne-muzw-wav';

// ==================== CLOUDINARY CONFIG ====================
// Configure Cloudinary for persistent file storage
// Support both CLOUDINARY_URL and individual env vars
let cloudName = process.env.CLOUDINARY_CLOUD_NAME;
let apiKey = process.env.CLOUDINARY_API_KEY;
let apiSecret = process.env.CLOUDINARY_API_SECRET;

// Parse CLOUDINARY_URL if individual vars not set (format: cloudinary://api_key:api_secret@cloud_name)
if (!cloudName && process.env.CLOUDINARY_URL) {
  try {
    const url = new URL(process.env.CLOUDINARY_URL.replace('cloudinary://', 'https://'));
    apiKey = url.username;
    apiSecret = url.password;
    cloudName = url.hostname;
    console.log('☁️ Parsed Cloudinary credentials from CLOUDINARY_URL');
  } catch (e) {
    console.error('Failed to parse CLOUDINARY_URL:', e.message);
  }
}

cloudinary.config({
  cloud_name: cloudName,
  api_key: apiKey,
  api_secret: apiSecret
});

const useCloudinary = !!(cloudName && apiKey && apiSecret);
if (useCloudinary) {
  console.log('☁️ Cloudinary configured for file storage');
} else {
  console.log('📁 Using local file storage (files may be lost on server restart)');
}

// ==================== DATABASE CONNECTION ====================
// Log which database we're connecting to (hide password)
let dbUrl = process.env.DATABASE_URL || '';
const dbHost = dbUrl.includes('@') ? dbUrl.split('@')[1]?.split('/')[0] : 'NOT SET';
console.log(`🔌 Connecting to database: ${dbHost}`);

// Add pgbouncer flag for Supabase transaction pooler (port 6543)
if (dbUrl.includes('pooler.supabase.com') && !dbUrl.includes('pgbouncer=true')) {
  dbUrl += dbUrl.includes('?') ? '&pgbouncer=true' : '?pgbouncer=true';
  console.log('📌 Added pgbouncer=true for Supabase pooler');
}

// Robust pool configuration for free-tier hosting with cold starts
const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },  // Always use SSL for Supabase
  // Pool configuration optimized for free-tier hosting (Supabase)
  max: 2,                          // Reduce to 2 connections (Supabase pooler limit)
  min: 0,                          // Allow pool to shrink to 0 when idle
  idleTimeoutMillis: 10000,        // Close idle connections after 10 seconds
  connectionTimeoutMillis: 60000,  // Wait 60 seconds for connection (cold start)
  allowExitOnIdle: true,           // Allow process to exit when pool is empty
  statement_timeout: 30000,        // 30 second query timeout
  query_timeout: 30000             // 30 second query timeout
});

// Track database readiness
let dbReady = false;
let dbInitializing = false;

// Pool error handler - critical for catching connection issues
pool.on('error', (err, client) => {
  console.error('❌ Unexpected database pool error:', err.message);
  dbReady = false;
  // Don't crash - the pool will attempt to reconnect on next query
});

pool.on('connect', (client) => {
  console.log('🔗 New database connection established');
});

pool.on('remove', (client) => {
  console.log('🔌 Database connection removed from pool');
});

// Robust query wrapper with retry logic for transient errors
async function executeQuery(queryText, params = [], retries = 5) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await pool.query(queryText, params);
      // Mark DB as ready on successful query
      if (!dbReady) {
        dbReady = true;
        console.log('✅ Database connection restored');
      }
      return result;
    } catch (err) {
      lastError = err;

      // Check if it's a transient/connection error worth retrying
      const isTransientError =
        err.code === 'ECONNRESET' ||
        err.code === 'ENOTFOUND' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNREFUSED' ||
        err.code === '57P01' ||  // admin_shutdown
        err.code === '57P02' ||  // crash_shutdown
        err.code === '57P03' ||  // cannot_connect_now
        err.code === '08006' ||  // connection_failure
        err.code === '08001' ||  // sqlclient_unable_to_establish_sqlconnection
        err.code === '08004' ||  // sqlserver_rejected_establishment_of_sqlconnection
        err.message.includes('Connection terminated') ||
        err.message.includes('connection timeout') ||
        err.message.includes('timeout expired') ||
        err.message.includes('Client has encountered a connection error');

      if (isTransientError && attempt < retries) {
        console.warn(`⚠️ Database query failed (attempt ${attempt}/${retries}): ${err.message}`);
        dbReady = false;
        // Longer exponential backoff: 1s, 2s, 4s, 8s for cold starts
        const delay = 1000 * Math.pow(2, attempt - 1);
        console.log(`⏳ Retrying in ${delay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // Non-transient error or final attempt, throw
      throw err;
    }
  }

  throw lastError;
}

// Initialize database with retry logic
async function initializeDatabaseConnection() {
  if (dbInitializing) return;
  dbInitializing = true;

  const maxAttempts = 5;
  const retryDelay = 3000; // 3 seconds

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`🔄 Attempting database connection (attempt ${attempt}/${maxAttempts})...`);

      // Test the connection
      const client = await pool.connect();
      console.log('✅ Connected to PostgreSQL');
      client.release();

      dbReady = true;

      // Run initialization
      await initializeDatabase();
      await runMigrations();

      dbInitializing = false;
      return true;
    } catch (err) {
      console.error(`❌ Database connection attempt ${attempt} failed:`, err.message);

      if (attempt < maxAttempts) {
        console.log(`⏳ Retrying in ${retryDelay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  console.error('❌ Failed to connect to database after all attempts. Server will retry on first request.');
  dbInitializing = false;
  return false;
}

// Start database connection
initializeDatabaseConnection();

// Keep-alive ping every 4 minutes to prevent idle disconnection (Supabase pooler timeout is ~5min)
setInterval(async () => {
  try {
    await pool.query('SELECT 1');
    console.log('🏓 Database keep-alive ping successful');
  } catch (err) {
    console.warn('⚠️ Keep-alive ping failed, connection will be re-established on next request');
    dbReady = false;
  }
}, 4 * 60 * 1000); // 4 minutes

// ==================== MIDDLEWARE ====================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Create upload directories
['uploads', 'uploads/materials', 'uploads/homework'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ==================== FILE UPLOAD SETUP ====================
// Local disk storage (fallback when Cloudinary is not configured)
const localDiskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dest = req.body.uploadType === 'homework' ? 'uploads/homework/' : 'uploads/materials/';
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(safeName);
    cb(null, uniqueName);
  }
});

// Cloudinary storage configuration
let cloudinaryStorage = null;
if (useCloudinary) {
  cloudinaryStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
      const isVideo = ['.mp4', '.mov', '.avi', '.webm'].includes(ext);
      const folder = req.body.uploadType === 'homework' ? 'fluentfeathers/homework' : 'fluentfeathers/materials';

      // Create unique filename - include extension for raw files (PDFs, docs, etc.)
      const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9);
      // For raw files, append extension to public_id so it downloads correctly
      const publicId = (isImage || isVideo) ? uniqueName : uniqueName + ext;

      return {
        folder: folder,
        resource_type: isVideo ? 'video' : isImage ? 'image' : 'raw',
        public_id: publicId,
        allowed_formats: null // Allow all formats
      };
    }
  });
}

// Helper function to get proper download URL from Cloudinary
function getCloudinaryDownloadUrl(url, originalFilename) {
  if (!url || !url.includes('cloudinary')) return url;

  // For Cloudinary URLs, add fl_attachment to force download with proper filename
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    const uploadIndex = pathParts.indexOf('upload');

    if (uploadIndex !== -1) {
      // Insert transformation after 'upload'
      const filename = originalFilename || 'download';
      pathParts.splice(uploadIndex + 1, 0, `fl_attachment:${encodeURIComponent(filename)}`);
      urlObj.pathname = pathParts.join('/');
      return urlObj.toString();
    }
  } catch (e) {
    console.error('Error creating download URL:', e);
  }
  return url;
}

// File filter for security
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const forbidden = ['.exe', '.sh', '.bat', '.cmd', '.php', '.py', '.rb', '.dll', '.msi', '.com', '.scr'];
  if (forbidden.includes(ext)) return cb(new Error('Executable files not allowed'));
  if (file.originalname.includes('..')) return cb(new Error('Invalid filename'));
  cb(null, true);
};

// Use Cloudinary storage if available, otherwise use local disk
const upload = multer({
  storage: useCloudinary ? cloudinaryStorage : localDiskStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max for videos
  fileFilter: fileFilter
});

// Wrapper to handle multer upload errors properly
const handleUpload = (fieldName) => {
  return (req, res, next) => {
    upload.single(fieldName)(req, res, (err) => {
      if (err) {
        console.error('❌ Upload error:', err.message, err);
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File too large. Maximum size is 100MB.' });
        }
        if (err.message.includes('Cloudinary') || err.message.includes('cloudinary')) {
          return res.status(500).json({ error: 'Cloudinary upload failed: ' + err.message + '. Check Cloudinary credentials in Render.' });
        }
        return res.status(500).json({ error: 'Upload failed: ' + err.message });
      }
      next();
    });
  };
};

// ==================== CONFIG API ====================
// Endpoint to get logo URL and storage status for frontend
app.get('/api/config', (req, res) => {
  try {
    res.json({
      logoUrl: process.env.LOGO_URL || '/logo.png',
      storageType: useCloudinary ? 'cloudinary' : 'local',
      cloudinaryConfigured: useCloudinary,
      cloudName: useCloudinary ? cloudName : null
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load config' });
  }
});

// Debug endpoint to check recent file uploads and their URLs
app.get('/api/debug/files', async (req, res) => {
  try {
    // Get recent sessions with files
    const sessions = await pool.query(`
      SELECT id, session_number, ppt_file_path, recording_file_path, homework_file_path
      FROM sessions
      WHERE ppt_file_path IS NOT NULL OR recording_file_path IS NOT NULL OR homework_file_path IS NOT NULL
      ORDER BY id DESC LIMIT 10
    `);

    res.json({
      cloudinaryConfigured: useCloudinary,
      cloudName: useCloudinary ? cloudName : 'NOT SET',
      recentFileSessions: sessions.rows.map(s => ({
        sessionId: s.id,
        sessionNumber: s.session_number,
        ppt: s.ppt_file_path ? { url: s.ppt_file_path, isCloudinary: s.ppt_file_path?.includes('cloudinary'), isLink: s.ppt_file_path?.startsWith('LINK:') } : null,
        recording: s.recording_file_path ? { url: s.recording_file_path, isCloudinary: s.recording_file_path?.includes('cloudinary'), isLink: s.recording_file_path?.startsWith('LINK:') } : null,
        homework: s.homework_file_path ? { url: s.homework_file_path, isCloudinary: s.homework_file_path?.includes('cloudinary'), isLink: s.homework_file_path?.startsWith('LINK:') } : null
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test upload endpoint - to verify Cloudinary is working
app.post('/api/debug/test-upload', handleUpload('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    res.json({
      success: true,
      storageType: useCloudinary ? 'cloudinary' : 'local',
      fileInfo: {
        originalName: req.file.originalname,
        path: req.file.path,
        filename: req.file.filename,
        size: req.file.size,
        mimetype: req.file.mimetype,
        // Cloudinary specific fields
        publicId: req.file.public_id,
        secureUrl: req.file.secure_url,
        url: req.file.url,
        format: req.file.format,
        resourceType: req.file.resource_type
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cloudinary status check endpoint
app.get('/api/debug/cloudinary-status', (req, res) => {
  res.json({
    cloudinaryConfigured: useCloudinary,
    cloudName: cloudName ? cloudName.substring(0, 3) + '***' : 'NOT SET',
    apiKeySet: !!apiKey,
    apiSecretSet: !!apiSecret,
    storageType: useCloudinary ? 'cloudinary' : 'local',
    message: useCloudinary
      ? 'Cloudinary is configured. Uploads should work.'
      : 'Cloudinary NOT configured. Add CLOUDINARY_URL or individual CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_CLOUD_NAME to Render environment variables.'
  });
});

// ==================== ADMIN SETTINGS API ====================
// Get admin settings (bio, name, title)
app.get('/api/admin/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT setting_key, setting_value FROM admin_settings');
    const settings = {};
    result.rows.forEach(row => {
      settings[row.setting_key] = row.setting_value;
    });
    res.json(settings);
  } catch (err) {
    res.json({ admin_bio: '', admin_name: 'Aaliya', admin_title: 'Founder & Lead Instructor' });
  }
});

// Update admin settings
app.put('/api/admin/settings', async (req, res) => {
  const { admin_bio, admin_name, admin_title } = req.body;
  try {
    if (admin_bio !== undefined) {
      await pool.query(`
        INSERT INTO admin_settings (setting_key, setting_value, updated_at)
        VALUES ('admin_bio', $1, CURRENT_TIMESTAMP)
        ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = CURRENT_TIMESTAMP
      `, [admin_bio]);
    }
    if (admin_name !== undefined) {
      await pool.query(`
        INSERT INTO admin_settings (setting_key, setting_value, updated_at)
        VALUES ('admin_name', $1, CURRENT_TIMESTAMP)
        ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = CURRENT_TIMESTAMP
      `, [admin_name]);
    }
    if (admin_title !== undefined) {
      await pool.query(`
        INSERT INTO admin_settings (setting_key, setting_value, updated_at)
        VALUES ('admin_title', $1, CURRENT_TIMESTAMP)
        ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = CURRENT_TIMESTAMP
      `, [admin_title]);
    }
    res.json({ success: true, message: 'Settings updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== DATABASE BACKUP ENDPOINT ====================
// Export all data as SQL for migration
app.get('/api/backup/export', async (req, res) => {
  try {
    // Verify admin password from query parameter for security
    const adminPass = req.query.pass;
    if (adminPass !== (process.env.ADMIN_PASSWORD || 'admin123')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let sql = '-- Fluent Feathers LMS Database Backup\n';
    sql += '-- Generated: ' + new Date().toISOString() + '\n\n';

    // Get all tables
    const tables = ['students', 'groups', 'sessions', 'materials', 'badges', 'assessments', 'announcements', 'events', 'event_registrations', 'email_log', 'class_feedback'];

    for (const table of tables) {
      try {
        const result = await pool.query(`SELECT * FROM ${table}`);

        if (result.rows.length > 0) {
          sql += `-- Table: ${table}\n`;
          sql += `DELETE FROM ${table};\n`;

          for (const row of result.rows) {
            const columns = Object.keys(row).join(', ');
            const values = Object.values(row).map(val => {
              if (val === null) return 'NULL';
              if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
              if (typeof val === 'number') return val;
              if (val instanceof Date) return `'${val.toISOString()}'`;
              // Escape single quotes in strings
              return `'${String(val).replace(/'/g, "''")}'`;
            }).join(', ');

            sql += `INSERT INTO ${table} (${columns}) VALUES (${values});\n`;
          }
          sql += '\n';
        }
      } catch (tableErr) {
        sql += `-- Table ${table} not found or error: ${tableErr.message}\n\n`;
      }
    }

    // Reset sequences for auto-increment IDs
    sql += '-- Reset sequences\n';
    for (const table of tables) {
      sql += `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true);\n`;
    }

    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', 'attachment; filename=fluentfeathers_backup_' + new Date().toISOString().split('T')[0] + '.sql');
    res.send(sql);
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== SECURITY HELPERS ====================
function generateAdminToken(studentId) {
  const payload = `${studentId}:${Date.now()}`;
  const signature = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('hex');
  return `${payload}:${signature}`;
}

function verifyAdminToken(token) {
  try {
    const [studentId, timestamp, signature] = token.split(':');
    const payload = `${studentId}:${timestamp}`;
    const expected = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('hex');
    if (expected !== signature) return null;
    if (Date.now() - Number(timestamp) > 10 * 60 * 1000) return null;
    return studentId;
  } catch { return null; }
}

function verifyParentAccess(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return next();
  const studentId = verifyAdminToken(token);
  if (!studentId) return res.status(403).json({ error: 'Invalid or expired admin access token' });
  req.adminStudentId = studentId;
  next();
}

app.use('/api/parent', verifyParentAccess);
app.use('/api/sessions', verifyParentAccess);
app.use('/api/upload', verifyParentAccess);
app.use('/api/events', verifyParentAccess);

// ==================== DATABASE INITIALIZATION ====================
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('🔧 Checking database tables...');

    // Check if tables already exist
    const checkTable = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'students'
      );
    `);

    if (checkTable.rows[0].exists) {
      console.log('✅ Database tables already exist. Skipping initialization to preserve data.');
      await client.query('COMMIT');
      return;
    }

    console.log('🔧 Creating new database tables...');

    // 1. Create Tables with ALL required columns from the start
    console.log('🔧 Creating students table...');
    await client.query(`
      CREATE TABLE students (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        grade TEXT NOT NULL,
        parent_name TEXT NOT NULL,
        parent_email TEXT NOT NULL,
        primary_contact TEXT,
        alternate_contact TEXT,
        timezone TEXT DEFAULT 'Asia/Kolkata',
        program_name TEXT,
        class_type TEXT,
        duration TEXT,
        currency TEXT DEFAULT '₹',
        per_session_fee DECIMAL(10,2),
        total_sessions INTEGER DEFAULT 0,
        completed_sessions INTEGER DEFAULT 0,
        remaining_sessions INTEGER DEFAULT 0,
        fees_paid DECIMAL(10,2) DEFAULT 0,
        group_id INTEGER,
        group_name TEXT,
        date_of_birth DATE,
        payment_method TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('🔧 Creating groups table...');
    await client.query(`
      CREATE TABLE groups (
        id SERIAL PRIMARY KEY,
        group_name TEXT NOT NULL,
        program_name TEXT NOT NULL,
        duration TEXT NOT NULL,
        timezone TEXT DEFAULT 'Asia/Kolkata',
        max_students INTEGER DEFAULT 10,
        current_students INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('🔧 Creating sessions table...');
    await client.query(`
      CREATE TABLE sessions (
        id SERIAL PRIMARY KEY,
        student_id INTEGER,
        group_id INTEGER,
        session_type TEXT DEFAULT 'Private',
        session_number INTEGER NOT NULL,
        session_date DATE NOT NULL,
        session_time TIME NOT NULL,
        status TEXT DEFAULT 'Pending',
        attendance TEXT,
        cancelled_by TEXT,
        meet_link TEXT,
        teacher_notes TEXT,
        ppt_file_path TEXT,
        recording_file_path TEXT,
        homework_file_path TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
      )
    `);

    console.log('🔧 Creating session_attendance table...');
    await client.query(`
      CREATE TABLE session_attendance (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        attendance TEXT DEFAULT 'Pending',
        homework_grade TEXT,
        homework_comments TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        UNIQUE(session_id, student_id)
      )
    `);

    console.log('🔧 Creating materials table...');
    await client.query(`
      CREATE TABLE materials (
        id SERIAL PRIMARY KEY,
        student_id INTEGER,
        group_id INTEGER,
        session_id INTEGER,
        session_date DATE NOT NULL,
        file_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        uploaded_by TEXT NOT NULL,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        feedback_grade TEXT,
        feedback_comments TEXT,
        feedback_given INTEGER DEFAULT 0,
        feedback_date TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    console.log('🔧 Creating makeup_classes table...');
    await client.query(`
      CREATE TABLE makeup_classes (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
        original_session_id INTEGER,
        reason TEXT NOT NULL,
        credit_date DATE NOT NULL,
        status TEXT DEFAULT 'Available',
        used_date DATE,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    console.log('🔧 Creating payment_history table...');
    await client.query(`
      CREATE TABLE payment_history (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
        payment_date DATE NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        currency TEXT NOT NULL,
        payment_method TEXT NOT NULL,
        receipt_number TEXT,
        sessions_covered TEXT,
        payment_status TEXT DEFAULT 'Paid',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    console.log('🔧 Creating events table...');
    await client.query(`
      CREATE TABLE events (
        id SERIAL PRIMARY KEY,
        event_name TEXT NOT NULL,
        event_description TEXT,
        event_date DATE NOT NULL,
        event_time TIME NOT NULL,
        event_duration TEXT,
        target_audience TEXT DEFAULT 'All',
        specific_grades TEXT,
        meet_link TEXT,
        max_participants INTEGER,
        current_participants INTEGER DEFAULT 0,
        status TEXT DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('🔧 Creating event_registrations table...');
    await client.query(`
      CREATE TABLE event_registrations (
        id SERIAL PRIMARY KEY,
        event_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        registration_method TEXT DEFAULT 'Parent',
        attendance TEXT DEFAULT 'Pending',
        registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        UNIQUE(event_id, student_id)
      )
    `);

    console.log('🔧 Creating email_log table...');
    await client.query(`
      CREATE TABLE email_log (
        id SERIAL PRIMARY KEY,
        recipient_name TEXT NOT NULL,
        recipient_email TEXT NOT NULL,
        email_type TEXT NOT NULL,
        subject TEXT NOT NULL,
        status TEXT NOT NULL,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('🔧 Creating demo_leads table...');
    await client.query(`
      CREATE TABLE demo_leads (
        id SERIAL PRIMARY KEY,
        child_name TEXT NOT NULL,
        child_grade TEXT,
        parent_name TEXT NOT NULL,
        parent_email TEXT NOT NULL,
        phone TEXT,
        program_interest TEXT,
        demo_date DATE,
        demo_time TIME,
        source TEXT,
        notes TEXT,
        status TEXT DEFAULT 'Scheduled',
        converted_student_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('🔧 Creating parent_credentials table...');
    await client.query(`
      CREATE TABLE parent_credentials (
        id SERIAL PRIMARY KEY,
        parent_email TEXT UNIQUE NOT NULL,
        password TEXT,
        otp TEXT,
        otp_expiry TIMESTAMP,
        otp_attempts INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      )
    `);

    console.log('🔧 Creating class_feedback table...');
    await client.query(`
      CREATE TABLE class_feedback (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        rating INTEGER CHECK (rating >= 1 AND rating <= 5),
        feedback_text TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        UNIQUE(session_id, student_id)
      )
    `);

    console.log('🔧 Creating student_badges table...');
    await client.query(`
      CREATE TABLE student_badges (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
        badge_type TEXT NOT NULL,
        badge_name TEXT NOT NULL,
        badge_description TEXT,
        earned_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    console.log('🔧 Creating payment_renewals table...');
    await client.query(`
      CREATE TABLE payment_renewals (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
        renewal_date DATE NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        currency TEXT NOT NULL,
        sessions_added INTEGER NOT NULL,
        payment_method TEXT,
        notes TEXT,
        status TEXT DEFAULT 'Paid',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    console.log('🔧 Creating announcements table...');
    await client.query(`
      CREATE TABLE announcements (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        announcement_type TEXT DEFAULT 'General',
        priority TEXT DEFAULT 'Normal',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('🔧 Creating student_certificates table...');
    await client.query(`
      CREATE TABLE student_certificates (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
        certificate_type TEXT NOT NULL,
        award_title TEXT NOT NULL,
        month INTEGER NOT NULL,
        year INTEGER NOT NULL,
        issued_date DATE DEFAULT CURRENT_DATE,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    console.log('🔧 Creating monthly_assessments table...');
    await client.query(`
      CREATE TABLE monthly_assessments (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
        month INTEGER NOT NULL,
        year INTEGER NOT NULL,
        skills TEXT,
        certificate_title TEXT,
        performance_summary TEXT,
        areas_of_improvement TEXT,
        teacher_comments TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    console.log('🔧 Creating expenses table...');
    await client.query(`
      CREATE TABLE expenses (
        id SERIAL PRIMARY KEY,
        expense_date DATE NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        currency TEXT DEFAULT 'INR',
        payment_method TEXT,
        receipt_url TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    console.log('🔧 Creating indexes...');
    await client.query('CREATE INDEX IF NOT EXISTS idx_students_email ON students(parent_email)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_feedback_student ON class_feedback(student_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_badges_student ON student_badges(student_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_certificates_student ON student_certificates(student_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_students_birthday ON students(date_of_birth)');

    await client.query('COMMIT');
    console.log('✅ Database initialized successfully with all tables and columns');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Database initialization error:', err);
    throw err;
  } finally {
    client.release();
  }
}
// ==================== DATABASE MIGRATION ====================
async function runMigrations() {
  const client = await pool.connect();
  try {
    console.log('🔧 Running database migrations...');

    // Migration 1: Add date_of_birth to students
    try {
      await client.query(`
        ALTER TABLE students 
        ADD COLUMN IF NOT EXISTS date_of_birth DATE;
      `);
      console.log('✅ Added date_of_birth column');
    } catch (err) {
      if (err.code === '42701') {
        console.log('ℹ️  date_of_birth column already exists');
      } else {
        console.error('❌ Error adding date_of_birth:', err.message);
      }
    }

    // Migration 2: Add payment_method to students
    try {
      await client.query(`
        ALTER TABLE students 
        ADD COLUMN IF NOT EXISTS payment_method TEXT;
      `);
      console.log('✅ Added payment_method column');
    } catch (err) {
      if (err.code === '42701') {
        console.log('ℹ️  payment_method column already exists');
      } else {
        console.error('❌ Error adding payment_method:', err.message);
      }
    }

    // Migration 3: Ensure announcements table exists
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS announcements (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          announcement_type TEXT DEFAULT 'General',
          priority TEXT DEFAULT 'Normal',
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('✅ Announcements table checked/created');
    } catch (err) {
      console.error('❌ Error with announcements table:', err.message);
    }

    // Migration 4: Ensure student_certificates table exists
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS student_certificates (
          id SERIAL PRIMARY KEY,
          student_id INTEGER NOT NULL,
          certificate_type TEXT NOT NULL,
          award_title TEXT NOT NULL,
          month INTEGER NOT NULL,
          year INTEGER NOT NULL,
          issued_date DATE DEFAULT CURRENT_DATE,
          description TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        );
      `);
      console.log('✅ Student certificates table checked/created');
    } catch (err) {
      console.error('❌ Error with certificates table:', err.message);
    }

    // Migration 5: Ensure monthly_assessments table exists
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS monthly_assessments (
          id SERIAL PRIMARY KEY,
          student_id INTEGER NOT NULL,
          month INTEGER NOT NULL,
          year INTEGER NOT NULL,
          skills TEXT,
          certificate_title TEXT,
          performance_summary TEXT,
          areas_of_improvement TEXT,
          teacher_comments TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        );
      `);
      console.log('✅ Monthly assessments table checked/created');
    } catch (err) {
      console.error('❌ Error with assessments table:', err.message);
    }

    // Migration 6: Ensure student_badges table exists
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS student_badges (
          id SERIAL PRIMARY KEY,
          student_id INTEGER NOT NULL,
          badge_type TEXT NOT NULL,
          badge_name TEXT NOT NULL,
          badge_description TEXT,
          earned_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        );
      `);
      await client.query('CREATE INDEX IF NOT EXISTS idx_badges_student ON student_badges(student_id)');
      console.log('✅ Student badges table checked/created');
    } catch (err) {
      console.error('❌ Error with badges table:', err.message);
    }

    // Migration 7: Ensure class_feedback table exists
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS class_feedback (
          id SERIAL PRIMARY KEY,
          session_id INTEGER NOT NULL,
          student_id INTEGER NOT NULL,
          rating INTEGER CHECK (rating >= 1 AND rating <= 5),
          feedback_text TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
          FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        );
      `);
      await client.query('CREATE INDEX IF NOT EXISTS idx_feedback_session ON class_feedback(session_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_feedback_student ON class_feedback(student_id)');
      // Add unique constraint for session_id + student_id
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_unique ON class_feedback(session_id, student_id)');
      console.log('✅ Class feedback table checked/created');
    } catch (err) {
      console.error('❌ Error with class_feedback table:', err.message);
    }

    // Migration 8: Ensure payment_renewals table exists
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS payment_renewals (
          id SERIAL PRIMARY KEY,
          student_id INTEGER NOT NULL,
          renewal_date DATE NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          currency TEXT NOT NULL,
          sessions_added INTEGER NOT NULL,
          payment_method TEXT,
          notes TEXT,
          status TEXT DEFAULT 'Paid',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        );
      `);
      console.log('✅ Payment renewals table checked/created');
    } catch (err) {
      console.error('❌ Error with payment_renewals table:', err.message);
    }

    // Migration 9: Ensure demo_leads table exists
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS demo_leads (
          id SERIAL PRIMARY KEY,
          child_name TEXT NOT NULL,
          child_grade TEXT,
          parent_name TEXT NOT NULL,
          parent_email TEXT NOT NULL,
          phone TEXT,
          program_interest TEXT,
          demo_date DATE,
          demo_time TIME,
          source TEXT,
          notes TEXT,
          status TEXT DEFAULT 'Scheduled',
          converted_student_id INTEGER,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('✅ Demo leads table checked/created');
    } catch (err) {
      console.error('❌ Error with demo_leads table:', err.message);
    }

    // Migration 10: Weekly challenges table
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS weekly_challenges (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          challenge_type TEXT DEFAULT 'General',
          points INTEGER DEFAULT 10,
          week_start DATE NOT NULL,
          week_end DATE NOT NULL,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS student_challenges (
          id SERIAL PRIMARY KEY,
          student_id INTEGER NOT NULL,
          challenge_id INTEGER NOT NULL,
          status TEXT DEFAULT 'Assigned',
          completed_at TIMESTAMP,
          notes TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
          FOREIGN KEY (challenge_id) REFERENCES weekly_challenges(id) ON DELETE CASCADE
        );
      `);
      console.log('✅ Weekly challenges tables checked/created');
    } catch (err) {
      console.error('❌ Error with weekly_challenges tables:', err.message);
    }

    // Migration 11: Parent expectations column
    try {
      await client.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS parent_expectations TEXT`);
      // Add badge_reward column to weekly_challenges
      await client.query(`ALTER TABLE weekly_challenges ADD COLUMN IF NOT EXISTS badge_reward TEXT DEFAULT '🎯 Challenge Champion'`);
      await client.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS renewal_reminder_sent BOOLEAN DEFAULT false`);
      // Add meet_link column to students table
      await client.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS meet_link TEXT`);
      console.log('✅ Parent expectations, renewal reminder & meet_link columns added');
    } catch (err) {
      console.error('❌ Error adding columns:', err.message);
    }

    // Migration 12: Session materials table for multiple files
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS session_materials (
          id SERIAL PRIMARY KEY,
          session_id INTEGER NOT NULL,
          material_type TEXT NOT NULL,
          file_name TEXT,
          file_path TEXT NOT NULL,
          file_size INTEGER,
          uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
      `);
      console.log('✅ Session materials table created');
    } catch (err) {
      console.error('❌ Error creating session_materials table:', err.message);
    }

    // Migration 13: Add columns to makeup_classes for tracking scheduled makeup sessions
    try {
      await client.query(`ALTER TABLE makeup_classes ADD COLUMN IF NOT EXISTS scheduled_session_id INTEGER REFERENCES sessions(id)`);
      await client.query(`ALTER TABLE makeup_classes ADD COLUMN IF NOT EXISTS added_by TEXT DEFAULT 'system'`);
      await client.query(`ALTER TABLE makeup_classes ADD COLUMN IF NOT EXISTS scheduled_date DATE`);
      await client.query(`ALTER TABLE makeup_classes ADD COLUMN IF NOT EXISTS scheduled_time TIME`);
      console.log('✅ Makeup classes columns added for tracking');
    } catch (err) {
      console.error('❌ Error adding makeup_classes columns:', err.message);
    }

    // Migration 14: Resource Library table
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS resource_library (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          category TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          file_path TEXT,
          external_link TEXT,
          thumbnail_url TEXT,
          grade_level TEXT,
          tags TEXT,
          is_featured BOOLEAN DEFAULT false,
          view_count INTEGER DEFAULT 0,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ Resource library table created');
    } catch (err) {
      console.error('❌ Error creating resource_library table:', err.message);
    }

    // Migration 15: Add image_url to announcements table
    try {
      await client.query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS image_url TEXT`);
      console.log('✅ Announcements image_url column added');
    } catch (err) {
      console.error('❌ Error adding image_url to announcements:', err.message);
    }

    // Migration 16: Admin settings table for bio and other settings
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS admin_settings (
          id SERIAL PRIMARY KEY,
          setting_key TEXT UNIQUE NOT NULL,
          setting_value TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // Insert default bio if not exists
      await client.query(`
        INSERT INTO admin_settings (setting_key, setting_value)
        VALUES ('admin_bio', '')
        ON CONFLICT (setting_key) DO NOTHING
      `);
      await client.query(`
        INSERT INTO admin_settings (setting_key, setting_value)
        VALUES ('admin_name', 'Aaliya')
        ON CONFLICT (setting_key) DO NOTHING
      `);
      await client.query(`
        INSERT INTO admin_settings (setting_key, setting_value)
        VALUES ('admin_title', 'Founder & Lead Instructor')
        ON CONFLICT (setting_key) DO NOTHING
      `);
      console.log('✅ Admin settings table created');
    } catch (err) {
      console.error('❌ Error creating admin_settings table:', err.message);
    }

    // Migration 17: Add assessment_type and demo_lead_id columns to monthly_assessments
    try {
      // Add assessment_type column (default 'monthly' for backwards compatibility)
      await client.query(`
        ALTER TABLE monthly_assessments
        ADD COLUMN IF NOT EXISTS assessment_type TEXT DEFAULT 'monthly'
      `);
      // Add demo_lead_id for demo assessments
      await client.query(`
        ALTER TABLE monthly_assessments
        ADD COLUMN IF NOT EXISTS demo_lead_id INTEGER REFERENCES demo_leads(id) ON DELETE SET NULL
      `);
      console.log('✅ Migration 17: Assessment type and demo_lead_id columns added');
    } catch (err) {
      console.error('❌ Migration 17 error:', err.message);
    }

    // Migration 18: Allow NULL student_id for demo assessments
    try {
      await client.query(`
        ALTER TABLE monthly_assessments
        ALTER COLUMN student_id DROP NOT NULL
      `);
      console.log('✅ Migration 18: student_id now allows NULL for demo assessments');
    } catch (err) {
      // Ignore if already nullable or other issues
      console.log('Migration 18 note:', err.message);
    }

    // Migration 19: Allow NULL month/year for demo assessments
    try {
      await client.query(`ALTER TABLE monthly_assessments ALTER COLUMN month DROP NOT NULL`);
      await client.query(`ALTER TABLE monthly_assessments ALTER COLUMN year DROP NOT NULL`);
      console.log('✅ Migration 19: month/year now allow NULL for demo assessments');
    } catch (err) {
      console.log('Migration 19 note:', err.message);
    }

    // Migration 20: Add missed_sessions column to students table
    try {
      await client.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS missed_sessions INTEGER DEFAULT 0`);
      console.log('✅ Migration 20: Added missed_sessions column to students');
    } catch (err) {
      console.log('Migration 20 note:', err.message);
    }

    // Migration 21: Create expenses table for financial tracking
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS expenses (
          id SERIAL PRIMARY KEY,
          expense_date DATE NOT NULL,
          category TEXT NOT NULL,
          description TEXT NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          currency TEXT DEFAULT 'INR',
          payment_method TEXT,
          receipt_url TEXT,
          notes TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ Migration 21: Created expenses table');
    } catch (err) {
      console.log('Migration 21 note:', err.message);
    }

    // Migration 22: Sync existing student payments to payment_history for financial reports
    try {
      // Get all students with fees_paid > 0
      const students = await client.query(`
        SELECT id, name, fees_paid, currency, total_sessions, created_at
        FROM students
        WHERE fees_paid > 0
      `);

      let synced = 0;
      for (const student of students.rows) {
        // Check if this student already has an initial payment entry
        const existing = await client.query(`
          SELECT id FROM payment_history
          WHERE student_id = $1 AND notes LIKE '%Initial enrollment%'
        `, [student.id]);

        if (existing.rows.length === 0) {
          // Add initial payment to history
          await client.query(`
            INSERT INTO payment_history (student_id, payment_date, amount, currency, payment_method, sessions_covered, notes, payment_status)
            VALUES ($1, $2, $3, $4, 'Bank Transfer', $5, 'Initial enrollment payment', 'completed')
          `, [student.id, student.created_at || new Date(), student.fees_paid, student.currency || 'INR', student.total_sessions || '']);
          synced++;
        }
      }
      if (synced > 0) {
        console.log(`✅ Migration 22: Synced ${synced} existing student payments to payment_history`);
      } else {
        console.log('✅ Migration 22: All student payments already synced');
      }
    } catch (err) {
      console.log('Migration 22 note:', err.message);
    }

    console.log('✅ All database migrations completed successfully!');

    // Auto-sync badges for students who should have them
    try {
      const students = await client.query('SELECT id, completed_sessions FROM students WHERE is_active = true');
      let awarded = 0;

      for (const student of students.rows) {
        const count = student.completed_sessions || 0;
        if (count >= 1) {
          const existing = await client.query('SELECT id FROM student_badges WHERE student_id = $1 AND badge_type = $2', [student.id, 'first_class']);
          if (existing.rows.length === 0) {
            await client.query('INSERT INTO student_badges (student_id, badge_type, badge_name, badge_description) VALUES ($1, $2, $3, $4)',
              [student.id, 'first_class', '🌟 First Class Star', 'Attended first class!']);
            awarded++;
          }
        }
        if (count >= 5) {
          const existing = await client.query('SELECT id FROM student_badges WHERE student_id = $1 AND badge_type = $2', [student.id, '5_classes']);
          if (existing.rows.length === 0) {
            await client.query('INSERT INTO student_badges (student_id, badge_type, badge_name, badge_description) VALUES ($1, $2, $3, $4)',
              [student.id, '5_classes', '🏆 5 Classes Champion', 'Completed 5 classes!']);
            awarded++;
          }
        }
        if (count >= 10) {
          const existing = await client.query('SELECT id FROM student_badges WHERE student_id = $1 AND badge_type = $2', [student.id, '10_classes']);
          if (existing.rows.length === 0) {
            await client.query('INSERT INTO student_badges (student_id, badge_type, badge_name, badge_description) VALUES ($1, $2, $3, $4)',
              [student.id, '10_classes', '👑 10 Classes Master', 'Completed 10 classes!']);
            awarded++;
          }
        }
      }
      if (awarded > 0) console.log(`✅ Auto-synced ${awarded} missing badges`);
    } catch (badgeErr) {
      console.error('Badge sync error:', badgeErr.message);
    }

  } catch (err) {
    console.error('❌ Migration error:', err);
  } finally {
    client.release();
  }
}
// ==================== HELPERS ====================
function istToUTC(dateStr, timeStr) {
  try {
    if (!dateStr || !timeStr) throw new Error('Date/Time missing');
    const cleanDate = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
    let cleanTime = timeStr.trim();
    if (cleanTime.length === 5) cleanTime += ':00';
    const isoString = `${cleanDate}T${cleanTime}+05:30`;
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return { date: cleanDate, time: cleanTime.substring(0, 5) };
    const utcDate = date.toISOString().split('T')[0];
    const utcTime = date.toISOString().split('T')[1].substring(0, 8);
    return { date: utcDate, time: utcTime };
  } catch (e) { return { date: dateStr, time: timeStr }; }
}

function formatUTCToLocal(utcDateStr, utcTimeStr, timezone) {
  try {
    if (!utcDateStr || !utcTimeStr) {
      console.error('Missing UTC date or time:', utcDateStr, utcTimeStr);
      return { date: 'Invalid Date', time: 'Invalid Time', day: '' };
    }

    // Handle Date objects from PostgreSQL
    let dateInput = utcDateStr;
    if (utcDateStr instanceof Date) {
      dateInput = utcDateStr.toISOString();
    } else if (typeof utcDateStr !== 'string') {
      dateInput = String(utcDateStr);
    }

    const dateStr = dateInput.includes('T') ? dateInput.split('T')[0] : dateInput;
    let timeStr = utcTimeStr.toString().trim();

    // Ensure time is in HH:MM:SS format
    if (timeStr.length === 5) timeStr += ':00';
    else if (timeStr.length === 8) { /* already good */ }
    else timeStr = timeStr.substring(0, 8);

    const isoString = `${dateStr}T${timeStr}Z`;
    const date = new Date(isoString);

    if (isNaN(date.getTime())) {
      console.error('Invalid date created from:', isoString);
      return { date: dateStr, time: timeStr, day: '' };
    }

    const tz = timezone || 'Asia/Kolkata';

    return {
      date: date.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }),
      time: date.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }),
      day: date.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' })
    };
  } catch (e) {
    console.error('Error in formatUTCToLocal:', e, 'Date:', utcDateStr, 'Time:', utcTimeStr);
    return { date: utcDateStr, time: utcTimeStr, day: '' };
  }
}

// Get friendly timezone label from IANA timezone
function getTimezoneLabel(timezone) {
  const tzLabels = {
    // Asia
    'Asia/Kolkata': 'India Time',
    'Asia/Dubai': 'Dubai Time',
    'Asia/Muscat': 'Oman Time',
    'Asia/Riyadh': 'Saudi Time',
    'Asia/Qatar': 'Qatar Time',
    'Asia/Kuwait': 'Kuwait Time',
    'Asia/Bahrain': 'Bahrain Time',
    'Asia/Singapore': 'Singapore Time',
    'Asia/Hong_Kong': 'Hong Kong Time',
    'Asia/Tokyo': 'Tokyo Time',
    'Asia/Seoul': 'Seoul Time',
    'Asia/Shanghai': 'China Time',
    'Asia/Bangkok': 'Bangkok Time',
    'Asia/Jakarta': 'Jakarta Time',
    'Asia/Manila': 'Manila Time',
    'Asia/Karachi': 'Pakistan Time',
    'Asia/Dhaka': 'Bangladesh Time',
    'Asia/Colombo': 'Sri Lanka Time',
    'Asia/Kathmandu': 'Nepal Time',
    'Asia/Tehran': 'Iran Time',
    'Asia/Jerusalem': 'Israel Time',
    // Americas
    'America/New_York': 'New York Time',
    'America/Chicago': 'Chicago Time',
    'America/Denver': 'Denver Time',
    'America/Los_Angeles': 'LA Time',
    'America/Toronto': 'Toronto Time',
    'America/Vancouver': 'Vancouver Time',
    'America/Mexico_City': 'Mexico Time',
    'America/Sao_Paulo': 'Brazil Time',
    'America/Argentina/Buenos_Aires': 'Argentina Time',
    'America/Lima': 'Peru Time',
    'America/Bogota': 'Colombia Time',
    // Europe
    'Europe/London': 'London Time',
    'Europe/Paris': 'Paris Time',
    'Europe/Berlin': 'Berlin Time',
    'Europe/Rome': 'Rome Time',
    'Europe/Madrid': 'Madrid Time',
    'Europe/Amsterdam': 'Amsterdam Time',
    'Europe/Brussels': 'Brussels Time',
    'Europe/Zurich': 'Zurich Time',
    'Europe/Vienna': 'Vienna Time',
    'Europe/Stockholm': 'Stockholm Time',
    'Europe/Oslo': 'Oslo Time',
    'Europe/Copenhagen': 'Copenhagen Time',
    'Europe/Helsinki': 'Helsinki Time',
    'Europe/Athens': 'Athens Time',
    'Europe/Istanbul': 'Istanbul Time',
    'Europe/Moscow': 'Moscow Time',
    'Europe/Warsaw': 'Warsaw Time',
    // Africa
    'Africa/Cairo': 'Cairo Time',
    'Africa/Johannesburg': 'South Africa Time',
    'Africa/Lagos': 'Nigeria Time',
    'Africa/Nairobi': 'Kenya Time',
    'Africa/Casablanca': 'Morocco Time',
    // Oceania
    'Australia/Sydney': 'Sydney Time',
    'Australia/Melbourne': 'Melbourne Time',
    'Australia/Perth': 'Perth Time',
    'Pacific/Auckland': 'Auckland Time',
    'Pacific/Fiji': 'Fiji Time'
  };
  return tzLabels[timezone] || 'Your Local Time';
}

async function sendEmail(to, subject, html, recipientName, emailType) {
  try {
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
      console.warn('⚠️ BREVO_API_KEY missing. Email not sent.');
      return false;
    }
    await axios.post('https://api.brevo.com/v3/smtp/email', { sender: { name: 'Fluent Feathers Academy', email: process.env.EMAIL_USER || 'test@test.com' }, to: [{ email: to, name: recipientName || to }], subject: subject, htmlContent: html }, { headers: { 'api-key': apiKey, 'Content-Type': 'application/json' } });
    await pool.query(`INSERT INTO email_log (recipient_name, recipient_email, email_type, subject, status) VALUES ($1, $2, $3, $4, 'Sent')`, [recipientName || '', to, emailType, subject]);
    return true;
  } catch (e) {
    console.error('Email Error:', e.message);
    await pool.query(`INSERT INTO email_log (recipient_name, recipient_email, email_type, subject, status) VALUES ($1, $2, $3, $4, 'Failed')`, [recipientName || '', to, emailType, subject]);
    return false;
  }
}

function getWelcomeEmail(data) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f4f8;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 32px;">🎓 Welcome to Fluent Feathers Academy!</h1>
    </div>
    <div style="padding: 40px 30px;">
      <p style="font-size: 18px; color: #2d3748; margin-bottom: 20px;">Dear <strong>${data.parent_name}</strong>,</p>
      <p style="font-size: 16px; color: #4a5568; line-height: 1.8; margin-bottom: 25px;">
        We are thrilled to welcome <strong style="color: #667eea;">${data.student_name}</strong> to our <strong>${data.program_name}</strong> program!
        This is the beginning of an exciting learning journey, and we're here to support every step of the way.
      </p>

      <div style="background: #f7fafc; border-left: 4px solid #667eea; padding: 20px; margin: 25px 0; border-radius: 8px;">
        <h3 style="color: #667eea; margin-top: 0; margin-bottom: 15px;">📚 What's Next?</h3>
        <ul style="color: #4a5568; line-height: 2; margin: 0; padding-left: 20px;">
          <li>Check your email for class schedule details</li>
          <li>Access the parent portal to view sessions and materials</li>
          <li>Join classes using the Meet link provided</li>
          <li>Upload homework and track progress</li>
        </ul>
      </div>

      <div style="text-align: center; margin: 35px 0;">
        <a href="${data.meet_link}" style="display: inline-block; background: linear-gradient(135deg, #38b2ac 0%, #2c7a7b 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 30px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 15px rgba(56, 178, 172, 0.4);">
  🎥 Join Your First Class on Meet
</a>
      </div>

      <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 20px; border-radius: 8px; margin-top: 25px;">
        <p style="margin: 0; color: #856404; font-size: 14px;">
          <strong>💡 Pro Tip:</strong> Save the Google Meet link for easy access to all your classes. We recommend testing your camera and microphone before the first session.
        </p>
      </div>

      <p style="font-size: 16px; color: #4a5568; margin-top: 30px; line-height: 1.8;">
        If you have any questions or need assistance, feel free to reach out to us anytime. We're excited to work with ${data.student_name}!
      </p>

      <p style="font-size: 16px; color: #2d3748; margin-top: 25px;">
        Warm regards,<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getScheduleEmail(data) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f4f8;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 32px;">📅 Your Class Schedule</h1>
    </div>
    <div style="padding: 40px 30px;">
      <p style="font-size: 18px; color: #2d3748; margin-bottom: 20px;">Hi <strong>${data.parent_name}</strong>,</p>
      <p style="font-size: 16px; color: #4a5568; line-height: 1.8; margin-bottom: 25px;">
        Great news! We've scheduled the upcoming classes for <strong style="color: #667eea;">${data.student_name}</strong>.
        Please find the complete schedule below:
      </p>

      <table style="width: 100%; border-collapse: collapse; margin: 25px 0; box-shadow: 0 2px 10px rgba(0,0,0,0.05);">
        <thead>
          <tr style="background: #667eea; color: white;">
            <th style="padding: 15px; text-align: left; border-bottom: 2px solid #5568d3;">Session</th>
            <th style="padding: 15px; text-align: left; border-bottom: 2px solid #5568d3;">Date</th>
            <th style="padding: 15px; text-align: left; border-bottom: 2px solid #5568d3;">Time</th>
          </tr>
        </thead>
        <tbody>
          ${data.schedule_rows}
        </tbody>
      </table>

      <div style="background: #e6fffa; border-left: 4px solid #38b2ac; padding: 20px; margin: 25px 0; border-radius: 8px;">
        <h3 style="color: #2c7a7b; margin-top: 0; margin-bottom: 15px;">🎥 Join Your Classes</h3>
<p style="color: #234e52; margin: 0; font-size: 14px; line-height: 1.8;">
  All classes will use the same Google Meet link. We recommend joining 5 minutes early to ensure a smooth start.
          The link will also be available in your parent portal next to each class.
        </p>
      </div>

      <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 20px; border-radius: 8px; margin-top: 25px;">
        <p style="margin: 0; color: #856404; font-size: 14px;">
          <strong>📌 Important:</strong> If you need to cancel a class, please do so at least 1 hour before the scheduled time to receive a makeup credit.
          You can cancel classes directly from your parent portal.
        </p>
      </div>

      <p style="font-size: 16px; color: #4a5568; margin-top: 30px; line-height: 1.8;">
        Looking forward to seeing ${data.student_name} in class! If you have any questions or need to reschedule, please don't hesitate to contact us.
      </p>

      <p style="font-size: 16px; color: #2d3748; margin-top: 25px;">
        Best regards,<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getAnnouncementEmail(data) {
  const priorityColors = {
    'Urgent': { bg: '#fed7d7', border: '#c53030', text: '#c53030' },
    'High': { bg: '#feebc8', border: '#c05621', text: '#c05621' },
    'Normal': { bg: '#e2e8f0', border: '#718096', text: '#4a5568' }
  };
  const colors = priorityColors[data.priority] || priorityColors['Normal'];

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f4f8;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #B05D9E 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 28px;">📢 Announcement</h1>
      <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0; font-size: 14px;">Fluent Feathers Academy By Aaliya</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="font-size: 18px; color: #2d3748; margin-bottom: 20px;">Hi <strong>${data.parentName}</strong>,</p>

      <div style="background: ${colors.bg}; border-left: 4px solid ${colors.border}; padding: 20px; margin: 25px 0; border-radius: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
          <span style="background: #B05D9E; color: white; padding: 4px 12px; border-radius: 4px; font-size: 12px;">${data.type}</span>
          <span style="background: ${colors.border}; color: white; padding: 4px 12px; border-radius: 4px; font-size: 12px;">${data.priority}</span>
        </div>
        <h2 style="color: #2d3748; margin: 0 0 15px; font-size: 22px;">${data.title}</h2>
        <p style="color: #4a5568; margin: 0; font-size: 16px; line-height: 1.8; white-space: pre-wrap;">${data.content}</p>
        ${data.imageUrl ? `<div style="margin-top: 20px; text-align: center;"><img src="${data.imageUrl}" style="max-width: 100%; max-height: 400px; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);" alt="Announcement Image"></div>` : ''}
      </div>

      <p style="font-size: 16px; color: #4a5568; margin-top: 30px; line-height: 1.8;">
        If you have any questions regarding this announcement, please feel free to contact us.
      </p>

      <p style="font-size: 16px; color: #2d3748; margin-top: 25px;">
        Best regards,<br>
        <strong style="color: #B05D9E;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getDemoConfirmationEmail(data) {
  const bioHtml = data.adminBio ? `
    <div style="background: #f7fafc; padding: 25px; border-radius: 12px; margin: 25px 0; border-left: 4px solid #B05D9E;">
      <h3 style="color: #B05D9E; margin: 0 0 15px; font-size: 18px;">👋 Meet Your Instructor</h3>
      <div style="display: flex; align-items: flex-start; gap: 20px;">
        <div style="width: 70px; height: 70px; background: linear-gradient(135deg, #B05D9E 0%, #764ba2 100%); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-size: 28px; font-weight: bold; flex-shrink: 0;">
          ${data.adminName ? data.adminName.charAt(0).toUpperCase() : 'A'}
        </div>
        <div style="flex: 1;">
          <h4 style="margin: 0 0 5px; color: #2d3748; font-size: 18px;">${data.adminName || 'Aaliya'}</h4>
          <p style="margin: 0 0 12px; color: #B05D9E; font-size: 14px; font-weight: 600;">${data.adminTitle || 'Founder & Lead Instructor'}</p>
          <p style="margin: 0; color: #4a5568; font-size: 15px; line-height: 1.7; white-space: pre-wrap;">${data.adminBio}</p>
        </div>
      </div>
    </div>
  ` : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f4f8;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #B05D9E 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 28px;">🎉 Demo Class Confirmed!</h1>
      <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0; font-size: 14px;">Fluent Feathers Academy By Aaliya</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="font-size: 18px; color: #2d3748; margin-bottom: 25px;">Hi <strong>${data.parentName}</strong>,</p>

      <p style="font-size: 16px; color: #4a5568; line-height: 1.8;">
        Thank you for scheduling a demo class for <strong style="color: #B05D9E;">${data.childName}</strong>! We're excited to meet you and your child.
      </p>

      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 25px; margin: 25px 0; border-radius: 12px; text-align: center;">
        <h3 style="margin: 0 0 15px; font-size: 16px; opacity: 0.9;">📅 Demo Class Details</h3>
        <p style="margin: 0 0 8px; font-size: 20px; font-weight: bold;">${data.demoDate}</p>
        <p style="margin: 0; font-size: 24px; font-weight: bold;">🕐 ${data.demoTime} IST</p>
        <p style="margin: 15px 0 0; font-size: 14px; opacity: 0.9;">Program: ${data.programInterest}</p>
        ${data.meetLink ? `<a href="${data.meetLink}" style="display: inline-block; margin-top: 20px; background: white; color: #667eea; padding: 14px 35px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 16px;">🎥 Join Demo Class</a>` : ''}
      </div>

      ${bioHtml}

      <div style="background: #fff8e6; border: 1px solid #f6e05e; padding: 20px; border-radius: 10px; margin: 25px 0;">
        <h4 style="color: #744210; margin: 0 0 10px; font-size: 16px;">📝 What to Expect</h4>
        <ul style="color: #744210; margin: 0; padding-left: 20px; line-height: 1.8;">
          <li>Interactive and fun 30-minute session</li>
          <li>Assessment of your child's current level</li>
          <li>Discussion about learning goals</li>
          <li>Q&A with the instructor</li>
        </ul>
      </div>

      <p style="font-size: 16px; color: #4a5568; line-height: 1.8;">
        ${data.meetLink ? 'Click the "Join Demo Class" button above at the scheduled time to join the demo.' : 'We\'ll send you the meeting link closer to the demo time.'} If you have any questions, feel free to reply to this email.
      </p>

      <p style="font-size: 16px; color: #2d3748; margin-top: 30px;">
        Looking forward to meeting ${data.childName}!<br><br>
        Best regards,<br>
        <strong style="color: #B05D9E;">${data.adminName || 'Aaliya'}</strong><br>
        <span style="color: #718096; font-size: 14px;">${data.adminTitle || 'Fluent Feathers Academy'}</span>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getRescheduleEmailTemplate(data) {
  // Format dates for display
  const formatDate = (dateStr) => {
    try {
      const d = new Date(dateStr + 'T00:00:00');
      return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    } catch (e) {
      return dateStr;
    }
  };

  const formatTime = (timeStr, timezone) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const d = new Date(today + 'T' + timeStr + 'Z');
      return d.toLocaleTimeString('en-US', { timeZone: timezone || 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
    } catch (e) {
      return timeStr;
    }
  };

  const oldDateFormatted = formatDate(data.old_date);
  const newDateFormatted = formatDate(data.new_date);
  const oldTimeFormatted = formatTime(data.old_time, data.timezone);
  const newTimeFormatted = formatTime(data.new_time, data.timezone);
  const sessionType = data.is_group ? `Group Class (${data.group_name})` : 'Private Class';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f4f8;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 40px 30px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 28px;">📅 Class Rescheduled</h1>
      <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0; font-size: 14px;">Fluent Feathers Academy By Aaliya</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="font-size: 18px; color: #2d3748; margin-bottom: 20px;">Dear <strong>${data.parent_name}</strong>,</p>

      <p style="font-size: 16px; color: #4a5568; line-height: 1.8; margin-bottom: 25px;">
        We wanted to inform you that <strong>${data.student_name}'s</strong> Session #${data.session_number} has been rescheduled.
      </p>

      <!-- Old Schedule (Crossed out) -->
      <div style="background: #fed7d7; padding: 20px; border-radius: 12px; margin: 20px 0; border-left: 4px solid #c53030;">
        <h3 style="margin: 0 0 15px; color: #c53030; font-size: 16px;">❌ Previous Schedule</h3>
        <p style="margin: 0; color: #742a2a; text-decoration: line-through;">
          📆 ${oldDateFormatted}<br>
          ⏰ ${oldTimeFormatted}
        </p>
      </div>

      <!-- New Schedule -->
      <div style="background: linear-gradient(135deg, #c6f6d5 0%, #9ae6b4 100%); padding: 20px; border-radius: 12px; margin: 20px 0; border-left: 4px solid #38a169;">
        <h3 style="margin: 0 0 15px; color: #276749; font-size: 16px;">✅ New Schedule</h3>
        <p style="margin: 0; color: #22543d; font-weight: 600; font-size: 18px;">
          📆 ${newDateFormatted}<br>
          ⏰ ${newTimeFormatted}
        </p>
      </div>

      <div style="background: #f7fafc; padding: 15px 20px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 0; color: #4a5568; font-size: 14px;">
          <strong>Class Type:</strong> ${sessionType}<br>
          <strong>Reason:</strong> ${data.reason || 'Schedule adjustment'}
        </p>
      </div>

      <p style="font-size: 16px; color: #4a5568; line-height: 1.8; margin-top: 25px;">
        Please make a note of this change. If you have any questions or need further adjustments, please feel free to contact us.
      </p>

      <p style="font-size: 16px; color: #2d3748; margin-top: 25px;">
        Thank you for your understanding! 🙏<br><br>
        Best regards,<br>
        <strong style="color: #B05D9E;">Teacher Aaliya</strong><br>
        <span style="color: #718096; font-size: 14px;">Fluent Feathers Academy</span>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getEventEmail(data) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f4f8;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 40px 30px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 32px;">🎉 ${data.event_name}</h1>
    </div>
    <div style="padding: 40px 30px;">
      <p style="font-size: 18px; color: #2d3748; margin-bottom: 20px;">Dear <strong>${data.parent_name}</strong>,</p>
      <p style="font-size: 16px; color: #4a5568; line-height: 1.8; margin-bottom: 25px;">
        We're excited to invite you and your child to a special event! This is a wonderful opportunity for learning, fun, and connecting with other students.
      </p>

      ${data.event_description ? `
      <div style="background: #f7fafc; padding: 20px; border-radius: 8px; margin: 25px 0;">
        <h3 style="color: #667eea; margin-top: 0; margin-bottom: 15px;">📝 About This Event</h3>
        <p style="color: #4a5568; margin: 0; line-height: 1.8;">${data.event_description}</p>
      </div>
      ` : ''}

      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 25px; border-radius: 12px; margin: 25px 0; color: white;">
        <h3 style="margin-top: 0; margin-bottom: 20px; font-size: 20px;">📅 Event Details</h3>
        <div style="display: flex; align-items: center; margin-bottom: 15px;">
          <span style="font-size: 24px; margin-right: 15px;">📆</span>
          <div>
            <div style="font-weight: bold; margin-bottom: 5px;">Date</div>
            <div style="opacity: 0.9;">${data.event_date}</div>
          </div>
        </div>
        <div style="display: flex; align-items: center; margin-bottom: 15px;">
          <span style="font-size: 24px; margin-right: 15px;">🕐</span>
          <div>
            <div style="font-weight: bold; margin-bottom: 5px;">Time</div>
            <div style="opacity: 0.9;">${data.event_time}</div>
          </div>
        </div>
        ${data.event_duration ? `
        <div style="display: flex; align-items: center;">
          <span style="font-size: 24px; margin-right: 15px;">⏱️</span>
          <div>
            <div style="font-weight: bold; margin-bottom: 5px;">Duration</div>
            <div style="opacity: 0.9;">${data.event_duration}</div>
          </div>
        </div>
        ` : ''}
      </div>

      <div style="text-align: center; margin: 35px 0;">
        <a href="${data.registration_link}" style="display: inline-block; background: linear-gradient(135deg, #38a169 0%, #2f855a 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 30px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 15px rgba(56, 161, 105, 0.4);">
          ✅ Register Now
        </a>
      </div>

      ${data.meet_link ? `
      <div style="background: #e6fffa; border-left: 4px solid #38b2ac; padding: 20px; margin: 25px 0; border-radius: 8px;">
        <h3 style="color: #2c7a7b; margin-top: 0; margin-bottom: 15px;">🎥 Join Information</h3>
        <p style="color: rgba(255,255,255,0.9); margin: 0 0 15px 0; font-size: 14px;">
  After registering, you'll receive the Google Meet link to join the event. We recommend joining 5 minutes early!
</p>
<a href="${data.meet_link}" style="display: inline-block; background: #38b2ac; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-size: 14px;">
  🔗 Event Meet Link
</a>
      </div>
      ` : ''}

      <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 20px; border-radius: 8px; margin-top: 25px;">
        <p style="margin: 0; color: #856404; font-size: 14px;">
          <strong>💡 Note:</strong> Spots may be limited! Register early to secure your place.
          You can also register directly from your parent portal in the Events section.
        </p>
      </div>

      <p style="font-size: 16px; color: #4a5568; margin-top: 30px; line-height: 1.8;">
        We can't wait to see you there! If you have any questions about the event, feel free to reach out to us.
      </p>

      <p style="font-size: 16px; color: #2d3748; margin-top: 25px;">
        See you soon!<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getPaymentConfirmationEmail(data) {
  const { parentName, studentName, amount, currency, paymentType, sessionsAdded, paymentMethod, receiptNumber } = data;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #38a169 0%, #276749 100%); padding: 40px 30px; text-align: center;">
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">✅ Payment Confirmed</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 16px;">Thank you for your payment!</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">
        Dear <strong>${parentName}</strong>,
      </p>
      <p style="margin: 0 0 25px; font-size: 15px; color: #4a5568; line-height: 1.6;">
        We have received your payment for <strong>${studentName}</strong>. Here are the details:
      </p>

      <div style="background: #f7fafc; padding: 25px; border-radius: 12px; border-left: 4px solid #38a169; margin: 20px 0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 10px 0; color: #4a5568;">Payment Type:</td><td style="padding: 10px 0; font-weight: bold; color: #2d3748;">${paymentType}</td></tr>
          <tr><td style="padding: 10px 0; color: #4a5568;">Amount:</td><td style="padding: 10px 0; font-weight: bold; color: #38a169; font-size: 1.2rem;">${currency} ${amount}</td></tr>
          ${sessionsAdded ? `<tr><td style="padding: 10px 0; color: #4a5568;">Sessions:</td><td style="padding: 10px 0; font-weight: bold; color: #2d3748;">${paymentType === 'Renewal' ? '+' : ''}${sessionsAdded} sessions</td></tr>` : ''}
          ${paymentMethod ? `<tr><td style="padding: 10px 0; color: #4a5568;">Payment Method:</td><td style="padding: 10px 0; font-weight: bold; color: #2d3748;">${paymentMethod}</td></tr>` : ''}
          ${receiptNumber ? `<tr><td style="padding: 10px 0; color: #4a5568;">Receipt Number:</td><td style="padding: 10px 0; font-weight: bold; color: #2d3748;">${receiptNumber}</td></tr>` : ''}
        </table>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6;">
        If you have any questions about this payment, please feel free to reach out to us.<br><br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getOTPEmail(data) {
  const { parentName, otp } = data;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">🔐 Login OTP</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 16px;">Fluent Feathers Academy Parent Portal</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">
        Dear <strong>${parentName}</strong>,
      </p>
      <p style="margin: 0 0 25px; font-size: 15px; color: #4a5568; line-height: 1.6;">
        You have requested to login to the Fluent Feathers Academy Parent Portal. Please use the OTP below to complete your login:
      </p>

      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px; text-align: center; margin: 30px 0;">
        <p style="margin: 0 0 10px; color: rgba(255,255,255,0.9); font-size: 14px;">Your One-Time Password</p>
        <h2 style="margin: 0; color: white; font-size: 42px; font-weight: bold; letter-spacing: 8px;">${otp}</h2>
      </div>

      <div style="background: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 8px; margin-top: 25px;">
        <p style="margin: 0; color: #856404; font-size: 14px; line-height: 1.5;">
          <strong>⚠️ Important:</strong> This OTP is valid for <strong>10 minutes</strong> only. Do not share this code with anyone.
        </p>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6;">
        If you didn't request this OTP, please ignore this email.<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getClassReminderEmail(data) {
  const { studentName, sessionNumber, localDate, localTime, localDay, meetLink, hoursBeforeClass, timezoneLabel } = data;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">⏰ Class Reminder</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 16px;">Your class is starting ${hoursBeforeClass === 5 ? 'in 5 hours' : 'in 1 hour'}!</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">
        Hi <strong>${studentName}</strong>,
      </p>
      <p style="margin: 0 0 25px; font-size: 15px; color: #4a5568; line-height: 1.6;">
        This is a friendly reminder that your upcoming class is ${hoursBeforeClass === 5 ? '<strong>starting in 5 hours</strong>' : '<strong>starting in 1 hour</strong>'}!
      </p>

      <div style="background: linear-gradient(135deg, #f6f9fc 0%, #e9f2ff 100%); padding: 25px; border-radius: 10px; border-left: 4px solid #667eea; margin-bottom: 25px;">
        <h2 style="margin: 0 0 15px; color: #667eea; font-size: 20px;">📅 Class Details</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong>Session:</strong></td>
            <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">#${sessionNumber}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong>Date:</strong></td>
            <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${localDay}, ${localDate}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong>Time:</strong></td>
            <td style="padding: 8px 0; color: #667eea; font-size: 16px; font-weight: bold; text-align: right;">${localTime}${timezoneLabel ? ` <span style="font-size: 12px; font-weight: normal; color: #718096;">(${timezoneLabel})</span>` : ''}</td>
          </tr>
        </table>
      </div>

      <div style="text-align: center; margin: 30px 0;">
        <a href="${meetLink}" style="display: inline-block; background: linear-gradient(135deg, #38b2ac 0%, #2c7a7b 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 8px; font-size: 18px; font-weight: bold; box-shadow: 0 4px 15px rgba(56, 178, 172, 0.3);">
  🎥 Join Meet Class
</a>
      </div>

      <div style="background: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 8px; margin-top: 25px;">
        <p style="margin: 0; color: #856404; font-size: 14px; line-height: 1.5;">
          <strong>💡 Pro Tip:</strong> Make sure you're in a quiet place with good internet connection. Have your materials ready!
        </p>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6;">
        We're excited to see you in class!<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getHomeworkFeedbackEmail(data) {
  const { studentName, sessionNumber, grade, comments, fileName } = data;

  // Get emoji based on grade
  const gradeEmoji = grade.toLowerCase().includes('a') || grade.toLowerCase().includes('excellent') ? '🌟' :
                     grade.toLowerCase().includes('b') || grade.toLowerCase().includes('good') ? '👍' :
                     grade.toLowerCase().includes('c') ? '📝' : '⭐';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #38a169 0%, #2f855a 100%); padding: 40px 30px; text-align: center;">
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">📝 Homework Reviewed!</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 16px;">Great job on completing your homework!</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">
        Hi <strong>${studentName}</strong>'s Parent,
      </p>
      <p style="margin: 0 0 25px; font-size: 15px; color: #4a5568; line-height: 1.6;">
        We're happy to let you know that ${studentName}'s homework has been reviewed! Here are the details:
      </p>

      <div style="background: linear-gradient(135deg, #f0fff4 0%, #c6f6d5 100%); padding: 25px; border-radius: 10px; border-left: 4px solid #38a169; margin-bottom: 25px;">
        <h2 style="margin: 0 0 15px; color: #38a169; font-size: 20px;">📋 Homework Details</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong>Session:</strong></td>
            <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">#${sessionNumber}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong>File:</strong></td>
            <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${fileName || 'Homework submission'}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong>Grade:</strong></td>
            <td style="padding: 8px 0; font-size: 18px; font-weight: bold; text-align: right;">
              <span style="background: linear-gradient(135deg, #48bb78 0%, #38a169 100%); color: white; padding: 5px 15px; border-radius: 20px;">
                ${gradeEmoji} ${grade}
              </span>
            </td>
          </tr>
        </table>
      </div>

      ${comments ? `
      <div style="background: #fef5e7; padding: 20px; border-radius: 10px; border-left: 4px solid #f6ad55; margin-bottom: 25px;">
        <h3 style="margin: 0 0 10px; color: #c05621; font-size: 16px;">💬 Teacher's Feedback</h3>
        <p style="margin: 0; color: #2d3748; font-size: 15px; line-height: 1.6; font-style: italic;">
          "${comments}"
        </p>
      </div>
      ` : ''}

      <div style="background: #e6fffa; border: 1px solid #38b2ac; padding: 15px; border-radius: 8px; margin-top: 25px;">
        <p style="margin: 0; color: #234e52; font-size: 14px; line-height: 1.5;">
          <strong>🎯 Keep it up!</strong> Regular homework completion helps reinforce learning and build good study habits. We're proud of ${studentName}'s progress!
        </p>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6;">
        Keep up the excellent work!<br>
        <strong style="color: #38a169;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getBirthdayEmail(data) {
  const { studentName, age } = data;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #FF6B9D 0%, #C06FF9 100%); padding: 50px 30px; text-align: center; position: relative;">
      <div style="font-size: 60px; margin-bottom: 10px;">🎉🎂🎈</div>
      <h1 style="margin: 0; color: white; font-size: 36px; font-weight: bold;">Happy Birthday!</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 18px;">Wishing you a fantastic day!</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 18px; color: #2d3748; text-align: center;">
        Dear <strong>${studentName}</strong>,
      </p>
      <div style="text-align: center; font-size: 50px; margin: 20px 0;">🎊🎁🌟</div>
      <p style="margin: 0 0 25px; font-size: 16px; color: #4a5568; line-height: 1.8; text-align: center;">
        Everyone at <strong style="color: #667eea;">Fluent Feathers Academy</strong><br>
        wishes you a very <strong>Happy Birthday</strong>!<br><br>
        May this special day bring you lots of happiness,<br>
        joy, and wonderful memories! 🎈🎂❤️
      </p>

      <div style="background: linear-gradient(135deg, #FFF5E1 0%, #FFE4E1 100%); padding: 25px; border-radius: 10px; border-left: 4px solid #FF6B9D; margin: 30px 0;">
        <p style="margin: 0; color: #4a5568; font-size: 16px; line-height: 1.6; text-align: center;">
          <span style="font-size: 24px;">🌟</span><br>
          <strong style="color: #C06FF9;">You are amazing!</strong><br>
          Keep shining and learning!
        </p>
      </div>

      <div style="text-align: center; margin: 30px 0; font-size: 40px;">
        🎵 🎶 🎉 🎂 🎁 🎈 🎊
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6; text-align: center;">
        With lots of love,<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getRenewalReminderEmail(data) {
  const { parentName, studentName, remainingSessions, programName, perSessionFee, currency } = data;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">⏰</div>
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">Session Renewal Reminder</h1>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">
        Dear <strong>${parentName}</strong>,
      </p>

      <div style="background: linear-gradient(135deg, #fff5f5 0%, #fed7d7 100%); padding: 25px; border-radius: 12px; border-left: 4px solid #e53e3e; margin: 25px 0;">
        <p style="margin: 0; font-size: 18px; color: #c53030; font-weight: bold; text-align: center;">
          ⚠️ Only ${remainingSessions} session${remainingSessions > 1 ? 's' : ''} remaining for ${studentName}!
        </p>
      </div>

      <p style="margin: 0 0 20px; font-size: 15px; color: #4a5568; line-height: 1.7;">
        We wanted to remind you that <strong>${studentName}</strong>'s sessions for
        <strong style="color: #667eea;">${programName || 'their program'}</strong> are running low.
      </p>

      <p style="margin: 0 0 25px; font-size: 15px; color: #4a5568; line-height: 1.7;">
        To ensure uninterrupted learning, please consider renewing the sessions soon.
        We'd hate for ${studentName} to miss out on their learning journey! 📚
      </p>

      <div style="background: #f7fafc; padding: 20px; border-radius: 10px; margin: 25px 0;">
        <h3 style="margin: 0 0 15px; color: #2d3748; font-size: 16px;">📋 Current Status:</h3>
        <table style="width: 100%; font-size: 14px; color: #4a5568;">
          <tr><td style="padding: 8px 0;">Student:</td><td style="padding: 8px 0; text-align: right; font-weight: bold;">${studentName}</td></tr>
          <tr><td style="padding: 8px 0;">Program:</td><td style="padding: 8px 0; text-align: right; font-weight: bold;">${programName || 'N/A'}</td></tr>
          <tr><td style="padding: 8px 0;">Sessions Remaining:</td><td style="padding: 8px 0; text-align: right; font-weight: bold; color: #e53e3e;">${remainingSessions}</td></tr>
          ${perSessionFee ? `<tr><td style="padding: 8px 0;">Per Session Fee:</td><td style="padding: 8px 0; text-align: right; font-weight: bold;">${currency || '₹'}${perSessionFee}</td></tr>` : ''}
        </table>
      </div>

      <p style="margin: 25px 0; font-size: 15px; color: #4a5568; line-height: 1.7;">
        To renew, simply reply to this email or contact us directly. We're happy to help! 😊
      </p>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568;">
        Warm regards,<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getClassCancelledEmail(data) {
  const { parentName, studentName, sessionDate, sessionTime, cancelledBy, reason, hasMakeupCredit } = data;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #f56565 0%, #c53030 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">📅</div>
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">Class Cancelled</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 16px;">Session Update Notification</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">
        Dear <strong>${parentName}</strong>,
      </p>
      <p style="margin: 0 0 25px; font-size: 15px; color: #4a5568; line-height: 1.6;">
        We wanted to inform you that <strong>${studentName}</strong>'s scheduled class has been cancelled.
      </p>

      <div style="background: #f7fafc; padding: 25px; border-radius: 12px; border-left: 4px solid #f56565; margin: 20px 0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 10px 0; color: #4a5568;">Scheduled Date:</td><td style="padding: 10px 0; font-weight: bold; color: #2d3748;">${sessionDate}</td></tr>
          <tr><td style="padding: 10px 0; color: #4a5568;">Scheduled Time:</td><td style="padding: 10px 0; font-weight: bold; color: #2d3748;">${sessionTime}</td></tr>
          <tr><td style="padding: 10px 0; color: #4a5568;">Cancelled By:</td><td style="padding: 10px 0; font-weight: bold; color: #2d3748;">${cancelledBy}</td></tr>
          ${reason ? `<tr><td style="padding: 10px 0; color: #4a5568;">Reason:</td><td style="padding: 10px 0; font-weight: bold; color: #2d3748;">${reason}</td></tr>` : ''}
        </table>
      </div>

      ${hasMakeupCredit ? `
      <div style="background: linear-gradient(135deg, #e6fffa 0%, #b2f5ea 100%); padding: 25px; border-radius: 12px; border-left: 4px solid #38b2ac; margin: 20px 0;">
        <h3 style="margin: 0 0 10px; color: #234e52; font-size: 18px;">🎁 Makeup Credit Added!</h3>
        <p style="margin: 0; color: #234e52; font-size: 15px; line-height: 1.6;">
          A makeup credit has been added to <strong>${studentName}</strong>'s account. You can use this credit during renewal to book an extra session. The credit will remain available until used.
        </p>
      </div>
      ` : ''}

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6;">
        If you have any questions, please don't hesitate to reach out to us.<br><br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getMakeupCreditAddedEmail(data) {
  const { parentName, studentName, reason, notes } = data;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #38b2ac 0%, #319795 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">🎁</div>
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">Makeup Credit Added!</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 16px;">Extra Session Available</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">
        Dear <strong>${parentName}</strong>,
      </p>
      <p style="margin: 0 0 25px; font-size: 15px; color: #4a5568; line-height: 1.6;">
        Great news! A makeup credit has been added to <strong>${studentName}</strong>'s account.
      </p>

      <div style="background: linear-gradient(135deg, #e6fffa 0%, #b2f5ea 100%); padding: 25px; border-radius: 12px; border-left: 4px solid #38b2ac; margin: 20px 0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 10px 0; color: #234e52;">Credit Type:</td><td style="padding: 10px 0; font-weight: bold; color: #234e52;">Exception Class / Makeup Session</td></tr>
          <tr><td style="padding: 10px 0; color: #234e52;">Reason:</td><td style="padding: 10px 0; font-weight: bold; color: #234e52;">${reason || 'Added by teacher'}</td></tr>
          ${notes ? `<tr><td style="padding: 10px 0; color: #234e52;">Notes:</td><td style="padding: 10px 0; font-weight: bold; color: #234e52;">${notes}</td></tr>` : ''}
          <tr><td style="padding: 10px 0; color: #234e52;">Status:</td><td style="padding: 10px 0; font-weight: bold; color: #38b2ac;">✅ Available</td></tr>
        </table>
      </div>

      <div style="background: #fffbeb; padding: 20px; border-radius: 12px; border-left: 4px solid #f59e0b; margin: 20px 0;">
        <h3 style="margin: 0 0 10px; color: #92400e; font-size: 16px;">📅 How to Use This Credit</h3>
        <p style="margin: 0; color: #92400e; font-size: 14px; line-height: 1.6;">
          This exception class credit will be available during your next renewal. You can use it to book an additional session at no extra cost. The credit will remain in your account until used.
        </p>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6;">
        If you have any questions, please don't hesitate to reach out to us.<br><br>
        <strong style="color: #38b2ac;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getCertificateEmail(data) {
  const { studentName, awardTitle, month, year, description } = data;
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #FFD700 0%, #FFA500 100%); padding: 50px 30px; text-align: center;">
      <div style="font-size: 60px; margin-bottom: 10px;">🏆</div>
      <h1 style="margin: 0; color: #2d3748; font-size: 32px; font-weight: bold; text-shadow: 1px 1px 2px rgba(255,255,255,0.5);">Certificate of Achievement</h1>
      <p style="margin: 10px 0 0; color: #4a5568; font-size: 16px; font-weight: 600;">${monthNames[month - 1]} ${year}</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #4a5568; text-align: center;">
        This certificate is proudly presented to
      </p>
      <h2 style="margin: 0 0 30px; font-size: 32px; color: #667eea; text-align: center; font-weight: bold;">${studentName}</h2>

      <div style="background: linear-gradient(135deg, #FFD700 0%, #FFA500 100%); padding: 30px; border-radius: 15px; text-align: center; box-shadow: 0 8px 20px rgba(255, 215, 0, 0.4); margin: 30px 0;">
        <p style="margin: 0 0 10px; color: #2d3748; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Award</p>
        <h3 style="margin: 0; color: #2d3748; font-size: 28px; font-weight: bold; text-shadow: 1px 1px 2px rgba(255,255,255,0.5);">🌟 ${awardTitle} 🌟</h3>
      </div>

      ${description ? `
      <div style="background: #f7fafc; padding: 20px; border-radius: 10px; border-left: 4px solid #667eea; margin: 25px 0;">
        <p style="margin: 0; color: #4a5568; font-size: 15px; line-height: 1.6;">
          ${description}
        </p>
      </div>
      ` : ''}

      <div style="text-align: center; margin: 30px 0; font-size: 36px;">
        ⭐ 🏆 🎖️ 👑 💎
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6; text-align: center;">
        Congratulations on your outstanding achievement!<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getMonthlyReportCardEmail(data) {
  const { assessmentId, studentName, month, year, skills, certificateTitle, performanceSummary, areasOfImprovement, teacherComments } = data;
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const skillsList = skills && skills.length > 0 ? skills : [];
  const appUrl = process.env.BASE_URL || process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com';
  const certificateUrl = `${appUrl}/monthly-certificate.html?id=${assessmentId}`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 700px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">📊</div>
      <h1 style="margin: 0; color: white; font-size: 32px; font-weight: bold;">Monthly Progress Report</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 18px; font-weight: 600;">${monthNames[month - 1]} ${year}</p>
    </div>

    <!-- Student Info -->
    <div style="padding: 30px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 10px; text-align: center; margin-bottom: 30px;">
        <p style="margin: 0 0 5px; color: rgba(255,255,255,0.9); font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Student Name</p>
        <h2 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">${studentName}</h2>
      </div>

      ${certificateTitle ? `
      <!-- Certificate Award Notice & Download Button -->
      <div style="background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); padding: 25px; border-radius: 12px; text-align: center; margin-bottom: 25px; border: 2px solid #f59e0b;">
        <div style="font-size: 40px; margin-bottom: 10px;">🏆</div>
        <h3 style="margin: 0 0 10px; color: #92400e; font-size: 22px; font-weight: bold;">${certificateTitle}</h3>
        <p style="margin: 0 0 5px; color: #b45309; font-size: 14px;">Congratulations to</p>
        <p style="margin: 0 0 15px; color: #92400e; font-size: 20px; font-weight: bold; text-transform: uppercase;">${studentName}</p>
        <a href="${certificateUrl}" target="_blank" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 14px 30px; border-radius: 30px; font-size: 16px; font-weight: 600; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);">
          📥 Download Certificate
        </a>
        <p style="margin: 15px 0 0; color: #92400e; font-size: 12px;">Click to view and download the full certificate as PDF</p>
      </div>
      ` : ''}

      ${skillsList.length > 0 ? `
      <!-- Skills Assessment -->
      <div style="margin-bottom: 30px;">
        <h3 style="color: #2d3748; font-size: 20px; margin: 0 0 15px; display: flex; align-items: center; gap: 8px;">
          <span>📝</span> Skills Assessed This Month
        </h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          ${skillsList.map(skill => `
          <div style="background: #f7fafc; padding: 12px; border-radius: 8px; border-left: 4px solid #667eea; font-size: 14px; color: #4a5568; font-weight: 600;">
            ✓ ${skill}
          </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      ${performanceSummary ? `
      <!-- Performance Summary -->
      <div style="margin-bottom: 30px;">
        <h3 style="color: #2d3748; font-size: 20px; margin: 0 0 15px; display: flex; align-items: center; gap: 8px;">
          <span>📈</span> Overall Performance Summary
        </h3>
        <div style="background: #e6fffa; padding: 20px; border-radius: 10px; border-left: 4px solid #38b2ac;">
          <p style="margin: 0; color: #2d3748; font-size: 15px; line-height: 1.7;">
            ${performanceSummary}
          </p>
        </div>
      </div>
      ` : ''}

      ${areasOfImprovement ? `
      <!-- Areas of Improvement -->
      <div style="margin-bottom: 30px;">
        <h3 style="color: #2d3748; font-size: 20px; margin: 0 0 15px; display: flex; align-items: center; gap: 8px;">
          <span>📌</span> Areas of Improvement
        </h3>
        <div style="background: #fff5f5; padding: 20px; border-radius: 10px; border-left: 4px solid #fc8181;">
          <p style="margin: 0; color: #2d3748; font-size: 15px; line-height: 1.7;">
            ${areasOfImprovement}
          </p>
        </div>
      </div>
      ` : ''}

      ${teacherComments ? `
      <!-- Teacher's Comments -->
      <div style="margin-bottom: 30px;">
        <h3 style="color: #2d3748; font-size: 20px; margin: 0 0 15px; display: flex; align-items: center; gap: 8px;">
          <span>💬</span> Teacher's Comments
        </h3>
        <div style="background: #fef5e7; padding: 20px; border-radius: 10px; border-left: 4px solid #f6ad55;">
          <p style="margin: 0; color: #2d3748; font-size: 15px; line-height: 1.7; font-style: italic;">
            "${teacherComments}"
          </p>
        </div>
      </div>
      ` : ''}

      <!-- Motivational Footer -->
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 25px; border-radius: 10px; text-align: center; margin-top: 30px;">
        <p style="margin: 0; color: white; font-size: 16px; line-height: 1.6; font-weight: 500;">
          🌟 Keep up the great work, ${studentName}! 🌟<br>
          <span style="font-size: 14px; opacity: 0.95;">We're proud of your progress and look forward to seeing you continue to grow!</span>
        </p>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; text-align: center; line-height: 1.6;">
        With love and encouragement,<br>
        <strong style="color: #667eea; font-size: 16px;">Team Fluent Feathers Academy</strong>
      </p>
    </div>

    <!-- Footer -->
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

// Demo Assessment Email Template
function getDemoAssessmentEmail(data) {
  const { assessmentId, childName, childGrade, demoDate, skills, certificateTitle, performanceSummary, areasOfImprovement, teacherComments } = data;
  const skillsList = skills && skills.length > 0 ? skills : [];
  const formattedDate = demoDate ? new Date(demoDate).toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'Demo Class';
  const appUrl = process.env.BASE_URL || process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com';
  const certificateUrl = `${appUrl}/demo-certificate.html?id=${assessmentId}`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 700px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #38b2ac 0%, #319795 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">🎯</div>
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">Demo Class Assessment Report</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 16px;">${formattedDate}</p>
    </div>

    <!-- Content -->
    <div style="padding: 30px;">
      <!-- Child Info -->
      <div style="background: linear-gradient(135deg, #38b2ac 0%, #319795 100%); padding: 20px; border-radius: 10px; text-align: center; margin-bottom: 30px;">
        <p style="margin: 0 0 5px; color: rgba(255,255,255,0.9); font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Student</p>
        <h2 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">${childName}</h2>
        <p style="margin: 8px 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">${childGrade || ''}</p>
      </div>

      <!-- Thank You Message -->
      <div style="background: #e6fffa; padding: 20px; border-radius: 10px; border-left: 4px solid #38b2ac; margin-bottom: 25px;">
        <p style="margin: 0; color: #234e52; font-size: 15px; line-height: 1.7;">
          Thank you for attending the demo class with Fluent Feathers Academy! We were delighted to have ${childName} join us. Here's a summary of what we observed during the session.
        </p>
      </div>

      ${certificateTitle ? `
      <!-- Demo Certificate Award Notice & Download Button -->
      <div style="background: linear-gradient(135deg, #e6fffa 0%, #b2f5ea 100%); padding: 25px; border-radius: 12px; text-align: center; margin-bottom: 25px; border: 2px solid #38b2ac;">
        <div style="font-size: 40px; margin-bottom: 10px;">🏆</div>
        <h3 style="margin: 0 0 10px; color: #234e52; font-size: 22px; font-weight: bold;">${certificateTitle}</h3>
        <p style="margin: 0 0 5px; color: #319795; font-size: 14px;">Congratulations to</p>
        <p style="margin: 0 0 15px; color: #234e52; font-size: 20px; font-weight: bold; text-transform: uppercase;">${childName}</p>
        <a href="${certificateUrl}" target="_blank" style="display: inline-block; background: linear-gradient(135deg, #38b2ac 0%, #319795 100%); color: white; text-decoration: none; padding: 14px 30px; border-radius: 30px; font-size: 16px; font-weight: 600; box-shadow: 0 4px 15px rgba(56, 178, 172, 0.4);">
          📥 Download Certificate
        </a>
        <p style="margin: 15px 0 0; color: #234e52; font-size: 12px;">Click to view and download the full certificate as PDF</p>
      </div>
      ` : ''}

      ${skillsList.length > 0 ? `
      <!-- Skills Observed -->
      <div style="margin-bottom: 30px;">
        <h3 style="color: #234e52; font-size: 20px; margin: 0 0 15px; display: flex; align-items: center; gap: 8px;">
          <span>📝</span> Skills Observed During Demo
        </h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          ${skillsList.map(skill => `
          <div style="background: #e6fffa; padding: 12px; border-radius: 8px; border-left: 4px solid #38b2ac; font-size: 14px; color: #234e52; font-weight: 600;">
            ✓ ${skill}
          </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      ${performanceSummary ? `
      <!-- Performance Summary -->
      <div style="margin-bottom: 30px;">
        <h3 style="color: #234e52; font-size: 20px; margin: 0 0 15px; display: flex; align-items: center; gap: 8px;">
          <span>📈</span> Demo Session Summary
        </h3>
        <div style="background: #e6fffa; padding: 20px; border-radius: 10px; border-left: 4px solid #38b2ac;">
          <p style="margin: 0; color: #234e52; font-size: 15px; line-height: 1.7;">
            ${performanceSummary}
          </p>
        </div>
      </div>
      ` : ''}

      ${areasOfImprovement ? `
      <!-- Areas to Focus -->
      <div style="margin-bottom: 30px;">
        <h3 style="color: #234e52; font-size: 20px; margin: 0 0 15px; display: flex; align-items: center; gap: 8px;">
          <span>🎯</span> Recommended Focus Areas
        </h3>
        <div style="background: #fefce8; padding: 20px; border-radius: 10px; border-left: 4px solid #eab308;">
          <p style="margin: 0; color: #713f12; font-size: 15px; line-height: 1.7;">
            ${areasOfImprovement}
          </p>
        </div>
      </div>
      ` : ''}

      ${teacherComments ? `
      <!-- Teacher's Comments -->
      <div style="margin-bottom: 30px;">
        <h3 style="color: #234e52; font-size: 20px; margin: 0 0 15px; display: flex; align-items: center; gap: 8px;">
          <span>💬</span> Teacher's Notes
        </h3>
        <div style="background: #faf5ff; padding: 20px; border-radius: 10px; border-left: 4px solid #B05D9E;">
          <p style="margin: 0; color: #4a5568; font-size: 15px; line-height: 1.7; font-style: italic;">
            "${teacherComments}"
          </p>
        </div>
      </div>
      ` : ''}

      <!-- Call to Action -->
      <div style="background: linear-gradient(135deg, #38b2ac 0%, #319795 100%); padding: 25px; border-radius: 10px; text-align: center; margin-top: 30px;">
        <p style="margin: 0; color: white; font-size: 16px; line-height: 1.6; font-weight: 500;">
          🌟 We'd love to have ${childName} join our classes! 🌟<br>
          <span style="font-size: 14px; opacity: 0.95;">Contact us to enroll and continue this learning journey.</span>
        </p>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; text-align: center; line-height: 1.6;">
        With warm regards,<br>
        <strong style="color: #38b2ac; font-size: 16px;">Team Fluent Feathers Academy</strong>
      </p>
    </div>

    <!-- Footer -->
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ==================== CLASS REMINDER CRON JOB ====================
// Runs every 15 minutes to check for upcoming classes
// Function to check and send class reminders (used by both cron and manual trigger)
async function checkAndSendReminders() {
  const now = new Date();
  console.log('🔔 Checking for upcoming classes to send reminders...');
  console.log(`⏰ Current server time (UTC): ${now.toISOString()}`);

  try {
    // Find all upcoming PRIVATE sessions
    // Use session_date >= CURRENT_DATE - 1 to catch sessions that might span across midnight UTC
    const privateSessions = await pool.query(`
      SELECT s.*, st.name as student_name, st.parent_email, st.parent_name, st.timezone,
             CONCAT(s.session_date, 'T', s.session_time, 'Z') as full_datetime
      FROM sessions s
      JOIN students st ON s.student_id = st.id
      WHERE s.status IN ('Pending', 'Scheduled')
        AND s.session_type = 'Private'
        AND s.session_date >= CURRENT_DATE - INTERVAL '1 day'
        AND st.is_active = true
        AND st.parent_email IS NOT NULL
    `);

    // Find all upcoming GROUP sessions and get students in those groups
    const groupSessions = await pool.query(`
      SELECT s.*, g.group_name, g.timezone as group_timezone,
             st.name as student_name, st.parent_email, st.parent_name, st.timezone,
             CONCAT(s.session_date, 'T', s.session_time, 'Z') as full_datetime
      FROM sessions s
      JOIN groups g ON s.group_id = g.id
      JOIN students st ON st.group_id = g.id
      WHERE s.status IN ('Pending', 'Scheduled')
        AND s.session_type = 'Group'
        AND s.session_date >= CURRENT_DATE - INTERVAL '1 day'
        AND st.is_active = true
        AND st.parent_email IS NOT NULL
    `);

    // Combine all sessions - mark group sessions for identification
    const markedPrivateSessions = privateSessions.rows.map(s => ({ ...s, is_group: false }));
    const markedGroupSessions = groupSessions.rows.map(s => ({ ...s, is_group: true }));
    const upcomingSessions = { rows: [...markedPrivateSessions, ...markedGroupSessions] };

    console.log(`📋 Found ${privateSessions.rows.length} private + ${groupSessions.rows.length} group = ${upcomingSessions.rows.length} total sessions to check for reminders`);

    for (const session of upcomingSessions.rows) {
      try {
        const sessionDateTime = new Date(session.full_datetime);
        const timeDiff = sessionDateTime - now;
        const hoursDiff = timeDiff / (1000 * 60 * 60);

        // Skip past sessions
        if (hoursDiff < 0) continue;

        // Determine session type label for logging and emails
        const sessionTypeLabel = session.is_group ? `Group (${session.group_name})` : 'Private';

        // Log session details for debugging
        console.log(`📌 ${sessionTypeLabel} Session #${session.session_number} for ${session.student_name}: ${session.full_datetime} (${hoursDiff.toFixed(2)} hours away)`);

        // Check if we need to send 5-hour reminder (widened window: 4.5 to 5.5 hours for reliability)
        if (hoursDiff > 4.5 && hoursDiff <= 5.5) {
          const emailType5hr = session.is_group ? 'Reminder-5hrs-Group' : 'Reminder-5hrs';
          console.log(`⏰ ${sessionTypeLabel} Session #${session.session_number} (ID:${session.id}) is within 5-hour window, checking if reminder already sent...`);
          // Check if 5-hour reminder already sent for this SPECIFIC session using unique session ID
          const sentCheck = await pool.query(
            `SELECT id FROM email_log
             WHERE recipient_email = $1
               AND email_type IN ('Reminder-5hrs', 'Reminder-5hrs-Group')
               AND subject LIKE $2`,
            [session.parent_email, `%[SID:${session.id}]%`]
          );

          if (sentCheck.rows.length === 0) {
            // Use student timezone, fallback to group timezone for group sessions
            const studentTimezone = session.timezone || session.group_timezone || 'Asia/Kolkata';
            console.log(`📍 Using timezone: ${studentTimezone} for ${session.student_name}`);
            const localTime = formatUTCToLocal(session.session_date, session.session_time, studentTimezone);
            console.log(`📧 Converted time: ${localTime.date} ${localTime.time} (${localTime.day})`);
            const reminderEmailHTML = getClassReminderEmail({
              studentName: session.student_name,
              sessionNumber: session.session_number,
              localDate: localTime.date,
              localTime: localTime.time,
              localDay: localTime.day,
              meetLink: session.meet_link || DEFAULT_MEET,
              hoursBeforeClass: 5,
              timezoneLabel: getTimezoneLabel(studentTimezone)
            });

            const subjectPrefix = session.is_group ? `⏰ Group Class Reminder (${session.group_name})` : '⏰ Class Reminder';
            await sendEmail(
              session.parent_email,
              `${subjectPrefix} - Session #${session.session_number} in 5 hours [SID:${session.id}]`,
              reminderEmailHTML,
              session.parent_name,
              emailType5hr
            );
            console.log(`✅ Sent 5-hour ${sessionTypeLabel} reminder to ${session.parent_email} for Session #${session.session_number} (ID:${session.id})`);
          } else {
            console.log(`⏭️ 5-hour reminder already sent for ${sessionTypeLabel} Session #${session.session_number} (ID:${session.id})`);
          }
        }

        // Check if we need to send 1-hour reminder (widened window: 0.5 to 1.5 hours for reliability)
        if (hoursDiff > 0.5 && hoursDiff <= 1.5) {
          const emailType1hr = session.is_group ? 'Reminder-1hr-Group' : 'Reminder-1hr';
          console.log(`⏰ ${sessionTypeLabel} Session #${session.session_number} (ID:${session.id}) is within 1-hour window, checking if reminder already sent...`);
          // Check if 1-hour reminder already sent for this SPECIFIC session using unique session ID
          const sentCheck = await pool.query(
            `SELECT id FROM email_log
             WHERE recipient_email = $1
               AND email_type IN ('Reminder-1hr', 'Reminder-1hr-Group')
               AND subject LIKE $2`,
            [session.parent_email, `%[SID:${session.id}]%`]
          );

          if (sentCheck.rows.length === 0) {
            // Use student timezone, fallback to group timezone for group sessions
            const studentTimezone = session.timezone || session.group_timezone || 'Asia/Kolkata';
            console.log(`📍 Using timezone: ${studentTimezone} for ${session.student_name}`);
            const localTime = formatUTCToLocal(session.session_date, session.session_time, studentTimezone);
            console.log(`📧 Converted time: ${localTime.date} ${localTime.time} (${localTime.day})`);
            const reminderEmailHTML = getClassReminderEmail({
              studentName: session.student_name,
              sessionNumber: session.session_number,
              localDate: localTime.date,
              localTime: localTime.time,
              localDay: localTime.day,
              meetLink: session.meet_link || DEFAULT_MEET,
              hoursBeforeClass: 1,
              timezoneLabel: getTimezoneLabel(studentTimezone)
            });

            const subjectPrefix = session.is_group ? `⏰ Group Class Reminder (${session.group_name})` : '⏰ Class Reminder';
            await sendEmail(
              session.parent_email,
              `${subjectPrefix} - Session #${session.session_number} in 1 hour [SID:${session.id}]`,
              reminderEmailHTML,
              session.parent_name,
              emailType1hr
            );
            console.log(`✅ Sent 1-hour ${sessionTypeLabel} reminder to ${session.parent_email} for Session #${session.session_number} (ID:${session.id})`);
          } else {
            console.log(`⏭️ 1-hour reminder already sent for ${sessionTypeLabel} Session #${session.session_number} (ID:${session.id})`);
          }
        }
      } catch (sessionErr) {
        console.error(`Error processing session ${session.id}:`, sessionErr);
      }
    }
  } catch (err) {
    console.error('❌ Error in class reminder check:', err);
  }
}

// Cron job to run reminders every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  try {
    await checkAndSendReminders();
  } catch (err) {
    console.error('❌ Error in class reminder cron job:', err);
  }
});

console.log('✅ Class reminder system initialized - checking every 15 minutes');

// ==================== BIRTHDAY REMINDER CRON JOB ====================
// Runs daily at 8:00 AM to check for birthdays
cron.schedule('0 8 * * *', async () => {
  try {
    console.log('🎂 Checking for birthdays today...');

    const today = new Date();
    const month = today.getMonth() + 1; // JavaScript months are 0-indexed
    const day = today.getDate();

    // Find students with birthday today
    const birthdayStudents = await pool.query(`
      SELECT id, name, parent_email, parent_name, date_of_birth
      FROM students
      WHERE EXTRACT(MONTH FROM date_of_birth) = $1
        AND EXTRACT(DAY FROM date_of_birth) = $2
        AND is_active = true
        AND date_of_birth IS NOT NULL
    `, [month, day]);

    for (const student of birthdayStudents.rows) {
      try {
        const birthYear = new Date(student.date_of_birth).getFullYear();
        const age = today.getFullYear() - birthYear;

        const birthdayEmailHTML = getBirthdayEmail({
          studentName: student.name,
          age: age
        });

        await sendEmail(
          student.parent_email,
          `🎉 Happy Birthday ${student.name}! 🎂`,
          birthdayEmailHTML,
          student.parent_name,
          'Birthday'
        );

        console.log(`✅ Sent birthday email to ${student.name} (${student.parent_email})`);
      } catch (emailErr) {
        console.error(`Error sending birthday email to ${student.name}:`, emailErr);
      }
    }

    if (birthdayStudents.rows.length === 0) {
      console.log('No birthdays today');
    }
  } catch (err) {
    console.error('❌ Error in birthday cron job:', err);
  }
});

console.log('✅ Birthday reminder system initialized - checking daily at 8:00 AM');

// ==================== PAYMENT RENEWAL REMINDER CRON JOB ====================
// Runs daily at 9:00 AM to check for students with 2 or fewer sessions remaining
cron.schedule('0 9 * * *', async () => {
  try {
    console.log('💳 Checking for payment renewal reminders...');

    // Find students with 2 or fewer sessions remaining who haven't been reminded
    const lowSessionStudents = await pool.query(`
      SELECT id, name, parent_email, parent_name, remaining_sessions, program_name, per_session_fee, currency
      FROM students
      WHERE is_active = true
        AND remaining_sessions <= 2
        AND remaining_sessions > 0
        AND (renewal_reminder_sent = false OR renewal_reminder_sent IS NULL)
    `);

    for (const student of lowSessionStudents.rows) {
      try {
        const renewalEmailHTML = getRenewalReminderEmail({
          parentName: student.parent_name,
          studentName: student.name,
          remainingSessions: student.remaining_sessions,
          programName: student.program_name,
          perSessionFee: student.per_session_fee,
          currency: student.currency
        });

        await sendEmail(
          student.parent_email,
          `⏰ Renewal Reminder - Only ${student.remaining_sessions} Session${student.remaining_sessions > 1 ? 's' : ''} Left for ${student.name}`,
          renewalEmailHTML,
          student.parent_name,
          'Renewal-Reminder'
        );

        // Mark reminder as sent
        await pool.query('UPDATE students SET renewal_reminder_sent = true WHERE id = $1', [student.id]);

        console.log(`✅ Sent renewal reminder to ${student.parent_name} for ${student.name} (${student.remaining_sessions} sessions left)`);
      } catch (emailErr) {
        console.error(`Error sending renewal reminder for ${student.name}:`, emailErr);
      }
    }

    if (lowSessionStudents.rows.length === 0) {
      console.log('No renewal reminders needed today');
    }
  } catch (err) {
    console.error('❌ Error in payment renewal cron job:', err);
  }
});

console.log('✅ Payment renewal reminder system initialized - checking daily at 9:00 AM');

// ==================== API ROUTES ====================

// Currency conversion rates to INR (approximate)
const currencyToINR = {
  '₹': 1,
  'INR': 1,
  '$': 83,
  'USD': 83,
  '£': 105,
  'GBP': 105,
  '€': 90,
  'EUR': 90,
  'AED': 23,
  'د.إ': 23
};

function convertToINR(amount, currency) {
  const rate = currencyToINR[currency] || currencyToINR[currency?.toUpperCase()] || 1;
  return amount * rate;
}

app.get('/api/dashboard/stats', async (req, res) => {
  try {
    // Get student count
    const countResult = await executeQuery('SELECT COUNT(*) as total FROM students WHERE is_active = true');

    // Get all students with fees and currency to convert to INR
    const studentsResult = await executeQuery('SELECT fees_paid, currency FROM students WHERE is_active = true');
    let totalRevenueINR = 0;
    for (const student of studentsResult.rows) {
      const fees = parseFloat(student.fees_paid) || 0;
      const currency = student.currency || '₹';
      totalRevenueINR += convertToINR(fees, currency);
    }

    const sess = await executeQuery(`SELECT COUNT(*) as upcoming FROM sessions WHERE status IN ('Pending', 'Scheduled') AND session_date >= CURRENT_DATE`);
    const g = await executeQuery('SELECT COUNT(*) as total FROM groups');
    const e = await executeQuery('SELECT COUNT(*) as total FROM events WHERE status = \'Active\'');
    res.json({
      totalStudents: parseInt(countResult.rows[0].total)||0,
      totalRevenue: Math.round(totalRevenueINR),
      upcomingSessions: parseInt(sess.rows[0].upcoming)||0,
      totalGroups: parseInt(g.rows[0].total)||0,
      activeEvents: parseInt(e.rows[0].total)||0
    });
  } catch (err) {
    console.error('Dashboard stats error:', err.message);
    res.status(500).json({ error: 'Database temporarily unavailable. Please refresh.' });
  }
});

// Calendar API - Get all sessions for a date range
app.get('/api/calendar/sessions', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: 'Start and end dates required' });
    }

    // Get private sessions (student_id set, no group_id - these are 1-on-1 sessions)
    const privateSessions = await pool.query(`
      SELECT s.id, s.session_date, s.session_time, s.session_number, s.status,
             'Private' as session_type,
             st.name as student_name
      FROM sessions s
      JOIN students st ON s.student_id = st.id
      WHERE s.student_id IS NOT NULL
        AND s.group_id IS NULL
        AND s.session_date >= $1 AND s.session_date <= $2
      ORDER BY s.session_date, s.session_time
    `, [start, end]);

    // Get group sessions (group_id set - these are group classes)
    const groupSessions = await pool.query(`
      SELECT s.id, s.session_date, s.session_time, s.session_number, s.status,
             'Group' as session_type,
             g.group_name as student_name
      FROM sessions s
      JOIN groups g ON s.group_id = g.id
      WHERE s.group_id IS NOT NULL
        AND s.session_date >= $1 AND s.session_date <= $2
      ORDER BY s.session_date, s.session_time
    `, [start, end]);

    // Get demo sessions
    const demoSessions = await pool.query(`
      SELECT id, demo_date as session_date, demo_time as session_time,
             1 as session_number, status, 'Demo' as session_type,
             child_name as student_name
      FROM demo_leads
      WHERE demo_date >= $1 AND demo_date <= $2
        AND status IN ('Scheduled', 'Demo Scheduled', 'Pending')
      ORDER BY demo_date, demo_time
    `, [start, end]);

    const allSessions = [
      ...privateSessions.rows,
      ...groupSessions.rows,
      ...demoSessions.rows
    ];

    res.json(allSessions);
  } catch (err) {
    console.error('Calendar error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/upcoming-classes', async (req, res) => {
  try {
    // Get private sessions (only for active students) - using retry-enabled query
    const priv = await executeQuery(`
      SELECT s.*, st.name as student_name, st.timezone, s.session_number,
      CONCAT(st.program_name, ' - ', st.duration) as class_info,
      'Private' as display_type,
      COALESCE(s.meet_link, $1) as meet_link
      FROM sessions s
      JOIN students st ON s.student_id = st.id
      WHERE s.status IN ('Pending', 'Scheduled') AND s.session_type = 'Private'
        AND st.is_active = true
      ORDER BY s.session_date ASC, s.session_time ASC
    `, [DEFAULT_MEET]);

    // Get group sessions
    const grp = await executeQuery(`
      SELECT s.*, g.group_name as student_name, g.timezone, s.session_number,
      CONCAT(g.program_name, ' - ', g.duration) as class_info,
      'Group' as display_type,
      COALESCE(s.meet_link, $1) as meet_link
      FROM sessions s
      JOIN groups g ON s.group_id = g.id
      WHERE s.status IN ('Pending', 'Scheduled') AND s.session_type = 'Group'
      ORDER BY s.session_date ASC, s.session_time ASC
    `, [DEFAULT_MEET]);

    // Get upcoming events as well
    const events = await executeQuery(`
  SELECT id,
    event_name as student_name,
    event_date as session_date,
    event_time as session_time,
    event_duration as class_info,
    'Asia/Kolkata' as timezone,
    0 as session_number,
    'Event' as display_type,
    'Event' as session_type,
    COALESCE(e.meet_link, '') as meet_link
  FROM events e
  WHERE status = 'Active'
  ORDER BY event_date ASC, event_time ASC
`);

    // Get scheduled demo classes
    const demos = await executeQuery(`
      SELECT id,
        child_name || ' (DEMO)' as student_name,
        demo_date as session_date,
        demo_time as session_time,
        COALESCE(program_interest, 'Demo Class') as class_info,
        'Asia/Kolkata' as timezone,
        0 as session_number,
        'Demo' as display_type,
        'Demo' as session_type,
        $1 as meet_link
      FROM demo_leads
      WHERE status = 'Scheduled' AND demo_date IS NOT NULL
      ORDER BY demo_date ASC, demo_time ASC
    `, [DEFAULT_MEET]);

    // Combine all
    const all = [...priv.rows, ...grp.rows, ...events.rows, ...demos.rows];

    // Filter and sort by UTC datetime (since database stores UTC)
    const now = new Date();
    // Keep classes visible for 40 minutes after start time
    const cutoffTime = new Date(now.getTime() - (40 * 60 * 1000));
    const upcoming = all.filter(session => {
      try {
        // Parse date - handle both Date objects and strings
        let dateStr = session.session_date;
        if (dateStr instanceof Date) {
          dateStr = dateStr.toISOString().split('T')[0];
        } else if (typeof dateStr === 'string' && dateStr.includes('T')) {
          dateStr = dateStr.split('T')[0];
        }

        // Parse time
        let timeStr = session.session_time || '00:00:00';
        if (typeof timeStr === 'string') {
          timeStr = timeStr.substring(0, 8);
        }

        const sessionDateTime = new Date(`${dateStr}T${timeStr}Z`);
        // Show classes until 40 minutes after their start time
        return sessionDateTime >= cutoffTime;
      } catch (e) {
        console.error('Error parsing session date/time:', e);
        return false;
      }
    }).sort((a, b) => {
      try {
        // Get date strings
        let dateA = a.session_date;
        let dateB = b.session_date;
        if (dateA instanceof Date) dateA = dateA.toISOString().split('T')[0];
        else if (typeof dateA === 'string' && dateA.includes('T')) dateA = dateA.split('T')[0];
        if (dateB instanceof Date) dateB = dateB.toISOString().split('T')[0];
        else if (typeof dateB === 'string' && dateB.includes('T')) dateB = dateB.split('T')[0];

        // Get time strings
        let timeA = a.session_time || '00:00:00';
        let timeB = b.session_time || '00:00:00';
        if (typeof timeA === 'string') timeA = timeA.substring(0, 8);
        if (typeof timeB === 'string') timeB = timeB.substring(0, 8);

        const dtA = new Date(`${dateA}T${timeA}Z`);
        const dtB = new Date(`${dateB}T${timeB}Z`);
        return dtA - dtB;
      } catch (e) {
        console.error('Error sorting sessions:', e);
        return 0;
      }
    }).slice(0, 10); // Show 10 upcoming classes

   // SUCCESS
res.json({
  success: true,
  classes: upcoming
});

  } catch (err) {
    console.error('Error loading upcoming classes:', err);
    // ERROR
res.status(500).json({
  success: false,
  classes: []   // 🔑 CRITICAL
});

  }
});

// ==================== DEMO LEADS API ====================
// Get all demo leads
app.get('/api/demo-leads', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM demo_leads ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new demo lead
app.post('/api/demo-leads', async (req, res) => {
  const { child_name, child_grade, parent_name, parent_email, phone, program_interest, demo_date, demo_time, source, notes, send_email } = req.body;
  try {
    // Convert demo date/time to UTC
    let utcDate = demo_date;
    let utcTime = demo_time;
    if (demo_date && demo_time) {
      const utc = istToUTC(demo_date, demo_time);
      utcDate = utc.date;
      utcTime = utc.time;
    }

    const r = await pool.query(`
      INSERT INTO demo_leads (child_name, child_grade, parent_name, parent_email, phone, program_interest, demo_date, demo_time, source, notes, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Scheduled')
      RETURNING *
    `, [child_name, child_grade, parent_name, parent_email, phone, program_interest, utcDate, utcTime, source, notes]);

    let emailSent = false;

    // Send demo confirmation email if requested
    if (send_email && parent_email && demo_date && demo_time) {
      try {
        // Get admin settings (bio, name, title)
        const settingsResult = await pool.query('SELECT setting_key, setting_value FROM admin_settings');
        const settings = {};
        settingsResult.rows.forEach(row => {
          settings[row.setting_key] = row.setting_value;
        });

        // Format date and time for display (IST)
        const displayDate = new Date(demo_date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const displayTime = demo_time;

        const emailHtml = getDemoConfirmationEmail({
          parentName: parent_name || 'Parent',
          childName: child_name,
          demoDate: displayDate,
          demoTime: displayTime,
          programInterest: program_interest || 'English Communication',
          adminName: settings.admin_name || 'Aaliya',
          adminTitle: settings.admin_title || 'Founder & Lead Instructor',
          adminBio: settings.admin_bio || '',
          meetLink: DEFAULT_MEET
        });

        emailSent = await sendEmail(
          parent_email,
          `🎉 Demo Class Confirmed for ${child_name} - Fluent Feathers Academy`,
          emailHtml,
          parent_name,
          'Demo Confirmation'
        );
      } catch (emailErr) {
        console.error('Demo email error:', emailErr);
      }
    }

    res.json({
      success: true,
      lead: r.rows[0],
      message: emailSent ? 'Demo scheduled and confirmation email sent!' : 'Demo scheduled successfully!'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update demo lead status
app.put('/api/demo-leads/:id/status', async (req, res) => {
  const { status, notes } = req.body;
  try {
    const existingNotes = await pool.query('SELECT notes FROM demo_leads WHERE id = $1', [req.params.id]);
    const updatedNotes = existingNotes.rows[0]?.notes
      ? existingNotes.rows[0].notes + '\n[' + new Date().toLocaleDateString() + '] ' + status + (notes ? ': ' + notes : '')
      : notes || '';

    await pool.query(
      'UPDATE demo_leads SET status = $1, notes = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [status, updatedNotes, req.params.id]
    );
    res.json({ success: true, message: 'Status updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update demo lead details (edit)
app.put('/api/demo-leads/:id', async (req, res) => {
  const { child_name, child_grade, parent_name, parent_email, phone, program_interest, demo_date, demo_time, source, status, notes, send_email } = req.body;

  try {
    // Get original lead data for comparison
    const originalLead = await pool.query('SELECT * FROM demo_leads WHERE id = $1', [req.params.id]);
    if (originalLead.rows.length === 0) {
      return res.status(404).json({ error: 'Demo lead not found' });
    }
    const original = originalLead.rows[0];

    // Convert demo time to UTC for storage
    let utcTime = demo_time;
    if (demo_date && demo_time) {
      const istDateTime = new Date(`${demo_date}T${demo_time}:00+05:30`);
      utcTime = istDateTime.toISOString().substr(11, 5);
    }

    // Update the demo lead
    const r = await pool.query(`
      UPDATE demo_leads
      SET child_name = $1, child_grade = $2, parent_name = $3, parent_email = $4,
          phone = $5, program_interest = $6, demo_date = $7, demo_time = $8,
          source = $9, status = $10, notes = $11, updated_at = CURRENT_TIMESTAMP
      WHERE id = $12
      RETURNING *
    `, [child_name, child_grade, parent_name, parent_email, phone, program_interest, demo_date, utcTime, source, status, notes, req.params.id]);

    // Send updated confirmation email if requested and date/time changed
    let emailSent = false;
    if (send_email && parent_email && (original.demo_date !== demo_date || original.demo_time !== utcTime)) {
      try {
        // Get admin settings for email
        const settingsResult = await pool.query('SELECT setting_key, setting_value FROM admin_settings');
        const settings = {};
        settingsResult.rows.forEach(row => {
          settings[row.setting_key] = row.setting_value;
        });

        // Format date and time for display
        const displayDate = new Date(demo_date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const displayTime = demo_time;

        const emailHtml = getDemoConfirmationEmail({
          parentName: parent_name || 'Parent',
          childName: child_name,
          demoDate: displayDate,
          demoTime: displayTime,
          programInterest: program_interest || 'English Communication',
          adminName: settings.admin_name || 'Aaliya',
          adminTitle: settings.admin_title || 'Founder & Lead Instructor',
          adminBio: settings.admin_bio || '',
          meetLink: DEFAULT_MEET
        });

        emailSent = await sendEmail(
          parent_email,
          `📅 Updated Demo Class Details for ${child_name} - Fluent Feathers Academy`,
          emailHtml,
          parent_name,
          'Demo Reschedule'
        );
      } catch (emailErr) {
        console.error('Demo update email error:', emailErr);
      }
    }

    res.json({
      success: true,
      lead: r.rows[0],
      message: emailSent ? 'Demo details updated and confirmation email sent!' : 'Demo details updated successfully!'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Convert demo lead to permanent student
app.post('/api/demo-leads/:id/convert', async (req, res) => {
  const { program_name, duration, per_session_fee, currency, total_sessions, amount_paid, payment_method, timezone, send_welcome_email } = req.body;
  try {
    // Get demo lead info
    const lead = await pool.query('SELECT * FROM demo_leads WHERE id = $1', [req.params.id]);
    if (lead.rows.length === 0) {
      return res.status(404).json({ error: 'Demo lead not found' });
    }
    const demoLead = lead.rows[0];

    // Create new student from demo lead
    const studentResult = await pool.query(`
      INSERT INTO students (name, grade, parent_name, parent_email, primary_contact, timezone, program_name, class_type, duration, currency, per_session_fee, total_sessions, completed_sessions, remaining_sessions, fees_paid, payment_method, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'Private', $8, $9, $10, $11, 0, $11, $12, $13, true)
      RETURNING *
    `, [demoLead.child_name, demoLead.child_grade, demoLead.parent_name, demoLead.parent_email, demoLead.phone, timezone, program_name, duration, currency, per_session_fee, total_sessions, amount_paid, payment_method]);

    const newStudent = studentResult.rows[0];

    // Record the payment in payment_history table
    await pool.query(`
      INSERT INTO payment_history (student_id, payment_date, amount, currency, payment_method, sessions_covered, notes, payment_status)
      VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, 'Initial payment - converted from demo', 'Paid')
    `, [newStudent.id, amount_paid, currency, payment_method, String(total_sessions)]);

    // Update demo lead status to Converted
    await pool.query(
      'UPDATE demo_leads SET status = $1, converted_student_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      ['Converted', newStudent.id, req.params.id]
    );

    // Send emails if requested
    if (send_welcome_email) {
      try {
        // Send payment confirmation email
        const paymentEmailHTML = getPaymentConfirmationEmail({
          parentName: demoLead.parent_name,
          studentName: demoLead.child_name,
          amount: amount_paid,
          currency: currency,
          paymentType: 'Initial Enrollment',
          sessionsAdded: total_sessions,
          paymentMethod: payment_method,
          receiptNumber: `FFA-${Date.now()}`
        });

        await sendEmail(
          demoLead.parent_email,
          `💳 Payment Confirmation - ${demoLead.child_name}`,
          paymentEmailHTML,
          demoLead.parent_name,
          'Payment Confirmation'
        );

        // Send welcome email
        const welcomeEmailHTML = getWelcomeEmail({
          parent_name: demoLead.parent_name,
          student_name: demoLead.child_name,
          program_name,
          meet_link: DEFAULT_MEET
        });

        await sendEmail(
          demoLead.parent_email,
          `🎉 Welcome to Fluent Feathers Academy - ${demoLead.child_name}`,
          welcomeEmailHTML,
          demoLead.parent_name,
          'Welcome'
        );
      } catch (emailErr) {
        console.error('Failed to send emails:', emailErr);
      }
    }

    res.json({ success: true, message: 'Demo lead converted to student', student: newStudent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete demo lead
app.delete('/api/demo-leads/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM demo_leads WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Demo lead deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== STUDENTS API ====================
app.get('/api/students', async (req, res) => {
  try {
    const r = await executeQuery(`
      SELECT s.*,
        COUNT(DISTINCT m.id) as makeup_credits,
        GREATEST(COALESCE(s.missed_sessions, 0), COALESCE((SELECT COUNT(*) FROM sessions WHERE student_id = s.id AND status IN ('Missed', 'Excused', 'Unexcused')), 0)) as missed_sessions,
        (SELECT MAX(created_at) FROM monthly_assessments WHERE student_id = s.id AND assessment_type = 'monthly') as last_assessment_date,
        (SELECT COUNT(*) FROM monthly_assessments WHERE student_id = s.id AND assessment_type = 'monthly') as total_assessments
      FROM students s
      LEFT JOIN makeup_classes m ON s.id = m.student_id AND m.status = 'Available'
      WHERE s.is_active = true
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `);

    // Calculate assessment due status for each student
    // Due for assessment if: completed 7+ sessions since last assessment (or 7+ total if never assessed)
    const studentsWithAssessmentStatus = r.rows.map(student => {
      const completedSessions = student.completed_sessions || 0;
      const totalAssessments = parseInt(student.total_assessments) || 0;

      // Sessions since last assessment = completed - (assessments * 7)
      // This assumes each assessment covers ~7 sessions
      const sessionsAccountedFor = totalAssessments * 7;
      const sessionsSinceAssessment = Math.max(0, completedSessions - sessionsAccountedFor);

      return {
        ...student,
        assessment_due: sessionsSinceAssessment >= 7,
        sessions_since_assessment: sessionsSinceAssessment
      };
    });

    res.json(studentsWithAssessmentStatus);
  } catch (err) {
    console.error('Students list error:', err.message);
    res.status(500).json({ error: 'Database temporarily unavailable. Please refresh.' });
  }
});

// Get students due for monthly assessment (7+ sessions since last assessment)
app.get('/api/students/due-for-assessment', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.id, s.name, s.grade, s.program_name, s.completed_sessions, s.parent_name,
        (SELECT COUNT(*) FROM monthly_assessments WHERE student_id = s.id AND assessment_type = 'monthly') as total_assessments,
        (SELECT MAX(created_at) FROM monthly_assessments WHERE student_id = s.id AND assessment_type = 'monthly') as last_assessment_date
      FROM students s
      WHERE s.is_active = true
      ORDER BY s.completed_sessions DESC
    `);

    // Filter to only students due for assessment
    const dueStudents = r.rows.filter(student => {
      const completedSessions = student.completed_sessions || 0;
      const totalAssessments = parseInt(student.total_assessments) || 0;
      const sessionsAccountedFor = totalAssessments * 7;
      const sessionsSinceAssessment = Math.max(0, completedSessions - sessionsAccountedFor);
      return sessionsSinceAssessment >= 7;
    }).map(student => {
      const completedSessions = student.completed_sessions || 0;
      const totalAssessments = parseInt(student.total_assessments) || 0;
      const sessionsAccountedFor = totalAssessments * 7;
      return {
        ...student,
        sessions_since_assessment: Math.max(0, completedSessions - sessionsAccountedFor)
      };
    });

    res.json(dueStudents);
  } catch (err) {
    console.error('Due for assessment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students', async (req, res) => {
  const { name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, program_name, class_type, duration, currency, per_session_fee, total_sessions, date_of_birth, payment_method, send_email } = req.body;
  try {
    const r = await pool.query(`
      INSERT INTO students (name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, program_name, class_type, duration, currency, per_session_fee, total_sessions, completed_sessions, remaining_sessions, fees_paid, date_of_birth, payment_method, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, $13, 0, $14, $15, true)
      RETURNING id
    `, [name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, program_name, class_type, duration, currency, per_session_fee, total_sessions, date_of_birth, payment_method]);

    let emailSent = false;
    if (send_email !== false) {  // Send email by default unless explicitly set to false
      emailSent = await sendEmail(
        parent_email,
        `🎓 Welcome to Fluent Feathers Academy - ${name}`,
        getWelcomeEmail({ parent_name, student_name: name, program_name, meet_link: DEFAULT_MEET }),
        parent_name,
        'Welcome'
      );
    }

    res.json({ success: true, studentId: r.rows[0].id, emailSent: emailSent });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    const studentId = req.params.id;
    const permanent = req.query.permanent === 'true';

    // Get session IDs for this student (to clean up session_materials)
    const studentSessions = await executeQuery('SELECT id FROM sessions WHERE student_id = $1', [studentId]);
    const sessionIds = studentSessions.rows.map(s => s.id);

    // Delete session_materials for this student's sessions
    if (sessionIds.length > 0) {
      for (const sessionId of sessionIds) {
        try {
          await executeQuery('DELETE FROM session_materials WHERE session_id = $1', [sessionId]);
        } catch (e) {
          console.log('Note: Could not delete session_materials:', e.message);
        }
      }
    }

    // Delete sessions for this student (removes from calendar)
    await executeQuery('DELETE FROM sessions WHERE student_id = $1', [studentId]);

    if (permanent) {
      // Permanently delete student and all related data
      // Delete from all tables that reference student_id (in case CASCADE isn't set)
      const tablesToClean = [
        'demo_assessments',
        'session_attendance',
        'materials',
        'makeup_classes',
        'payment_history',
        'payment_renewals',
        'event_registrations',
        'class_feedback',
        'student_badges',
        'student_certificates',
        'monthly_assessments',
        'student_challenges'
      ];

      for (const table of tablesToClean) {
        try {
          await executeQuery(`DELETE FROM ${table} WHERE student_id = $1`, [studentId]);
        } catch (tableErr) {
          // Table might not exist or column might be different - continue
          console.log(`Note: Could not delete from ${table}: ${tableErr.message}`);
        }
      }

      // Finally delete the student
      await executeQuery('DELETE FROM students WHERE id = $1', [studentId]);

      res.json({ success: true, message: 'Student and all related data permanently deleted' });
    } else {
      // Soft delete - mark as inactive (sessions already deleted above)
      await executeQuery('UPDATE students SET is_active = false WHERE id = $1', [studentId]);
      res.json({ success: true, message: 'Student deactivated and sessions removed from calendar' });
    }
  } catch (err) {
    console.error('Error deleting student:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students/:id/payment', async (req, res) => {
  const { amount, currency, payment_method, receipt_number, sessions_covered, notes, send_email } = req.body;
  try {
    await pool.query(`
      INSERT INTO payment_history (student_id, payment_date, amount, currency, payment_method, receipt_number, sessions_covered, notes, payment_status)
      VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, 'Paid')
    `, [req.params.id, amount, currency, payment_method, receipt_number, sessions_covered, notes]);
    await pool.query('UPDATE students SET fees_paid = fees_paid + $1 WHERE id = $2', [amount, req.params.id]);

    // Send payment confirmation email if requested
    if (send_email) {
      const student = await pool.query('SELECT name, parent_name, parent_email FROM students WHERE id = $1', [req.params.id]);
      if (student.rows[0]) {
        const emailHTML = getPaymentConfirmationEmail({
          parentName: student.rows[0].parent_name,
          studentName: student.rows[0].name,
          amount: amount,
          currency: currency,
          paymentType: 'Initial Payment',
          sessionsAdded: sessions_covered,
          paymentMethod: payment_method,
          receiptNumber: receipt_number
        });
        await sendEmail(
          student.rows[0].parent_email,
          `✅ Payment Confirmation - Fluent Feathers Academy`,
          emailHTML,
          student.rows[0].parent_name,
          'Payment Confirmation'
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/groups', async (req, res) => {
  try {
    const r = await executeQuery(`
      SELECT g.*, COUNT(DISTINCT s.id) as enrolled_students
      FROM groups g
      LEFT JOIN students s ON g.id = s.group_id AND s.is_active = true
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('Groups list error:', err.message);
    res.status(500).json({ error: 'Database temporarily unavailable. Please refresh.' });
  }
});

app.post('/api/groups', async (req, res) => {
  const { group_name, program_name, duration, timezone, max_students } = req.body;
  try {
    const r = await pool.query(`
      INSERT INTO groups (group_name, program_name, duration, timezone, max_students, current_students)
      VALUES ($1, $2, $3, $4, $5, 0)
      RETURNING id
    `, [group_name, program_name, duration, timezone, max_students]);
    res.json({ success: true, groupId: r.rows[0].id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// New endpoint to enroll student in group
app.post('/api/groups/:groupId/enroll', async (req, res) => {
  const { student_id } = req.body;
  const groupId = req.params.groupId;

  try {
    const group = await pool.query('SELECT * FROM groups WHERE id = $1', [groupId]);
    if (group.rows.length === 0) return res.status(404).json({ error: 'Group not found' });

    const currentCount = await pool.query('SELECT COUNT(*) as count FROM students WHERE group_id = $1 AND is_active = true', [groupId]);
    if (parseInt(currentCount.rows[0].count) >= group.rows[0].max_students) {
      return res.status(400).json({ error: 'Group is full' });
    }

    await pool.query('UPDATE students SET group_id = $1, group_name = $2 WHERE id = $3', [groupId, group.rows[0].group_name, student_id]);
    await pool.query('UPDATE groups SET current_students = current_students + 1 WHERE id = $1', [groupId]);

    res.json({ success: true, message: 'Student enrolled successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get students in a group
app.get('/api/groups/:groupId/students', async (req, res) => {
  try {
    const students = await pool.query('SELECT * FROM students WHERE group_id = $1 AND is_active = true ORDER BY name', [req.params.groupId]);
    res.json(students.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/groups/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM session_attendance WHERE session_id IN (SELECT id FROM sessions WHERE group_id = $1)', [req.params.id]);
    await client.query('DELETE FROM sessions WHERE group_id = $1', [req.params.id]);
    await client.query('DELETE FROM groups WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Schedule private classes
app.post('/api/schedule/private-classes', async (req, res) => {
  const client = await pool.connect();
  try {
    const { student_id, classes, send_email } = req.body;
    const student = (await client.query('SELECT * FROM students WHERE id = $1', [student_id])).rows[0];
    if(!student) return res.status(404).json({ error: 'Student not found' });
    if(student.remaining_sessions < classes.length) return res.status(400).json({ error: 'Not enough sessions' });

    const count = (await client.query('SELECT COUNT(*) as count FROM sessions WHERE student_id = $1', [student_id])).rows[0].count;
    let sessionNumber = parseInt(count)+1;

    await client.query('BEGIN');

    const scheduledSessions = [];
    for(const cls of classes) {
      if(!cls.date || !cls.time) continue;
      const utc = istToUTC(cls.date, cls.time);
      await client.query(`
        INSERT INTO sessions (student_id, session_type, session_number, session_date, session_time, meet_link, status)
        VALUES ($1, 'Private', $2, $3::date, $4::time, $5, 'Pending')
      `, [student_id, sessionNumber, utc.date, utc.time, DEFAULT_MEET]);

      // Store for email
      const display = formatUTCToLocal(utc.date, utc.time, student.timezone);
      scheduledSessions.push(`<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:15px; color: #4a5568;">#${sessionNumber}</td><td style="padding:15px; color: #4a5568;">${display.date}</td><td style="padding:15px;"><strong style="color:#667eea;">${display.time}</strong></td></tr>`);

      sessionNumber++;
    }

    await client.query('COMMIT');

    // Send Schedule Email (if enabled)
    if (send_email !== false) {
      const scheduleHTML = getScheduleEmail({
        parent_name: student.parent_name,
        student_name: student.name,
        schedule_rows: scheduledSessions.join('')
      });

      await sendEmail(
        student.parent_email,
        `📅 Class Schedule for ${student.name}`,
        scheduleHTML,
        student.parent_name,
        'Schedule'
      );
    }

    const message = send_email !== false
      ? 'Classes scheduled and email sent!'
      : 'Classes scheduled successfully!';
    res.json({ success: true, message });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Schedule group classes
app.post('/api/schedule/group-classes', async (req, res) => {
  const client = await pool.connect();
  try {
    const { group_id, classes, send_email } = req.body;
    const group = (await client.query('SELECT * FROM groups WHERE id = $1', [group_id])).rows[0];
    if(!group) return res.status(404).json({ error: 'Group not found' });

    const count = (await client.query('SELECT COUNT(*) as count FROM sessions WHERE group_id = $1', [group_id])).rows[0].count;
    let sessionNumber = parseInt(count)+1;

    await client.query('BEGIN');

    const scheduledSessions = [];

    for(const cls of classes) {
      if(!cls.date || !cls.time) continue;
      const utc = istToUTC(cls.date, cls.time);
      const r = await client.query(`
        INSERT INTO sessions (group_id, session_type, session_number, session_date, session_time, meet_link, status)
        VALUES ($1, 'Group', $2, $3::date, $4::time, $5, 'Pending')
        RETURNING id
      `, [group_id, sessionNumber, utc.date, utc.time, DEFAULT_MEET]);

      const sessionId = r.rows[0].id;

      // Add all group students to session_attendance
      const students = await client.query('SELECT id FROM students WHERE group_id = $1 AND is_active = true', [group_id]);
      for(const s of students.rows) {
        await client.query('INSERT INTO session_attendance (session_id, student_id, attendance) VALUES ($1, $2, \'Pending\')', [sessionId, s.id]);
      }

      const display = formatUTCToLocal(utc.date, utc.time, group.timezone);
      scheduledSessions.push(`<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:15px; color: #4a5568;">#${sessionNumber}</td><td style="padding:15px; color: #4a5568;">${display.date}</td><td style="padding:15px;"><strong style="color:#667eea;">${display.time}</strong></td></tr>`);

      sessionNumber++;
    }

    await client.query('COMMIT');

    // Send schedule email to all students in the group (if enabled)
    let emailsSent = 0;
    if (send_email !== false) {
      const students = await client.query('SELECT * FROM students WHERE group_id = $1 AND is_active = true', [group_id]);
      for (const student of students.rows) {
        const scheduleHTML = getScheduleEmail({
          parent_name: student.parent_name,
          student_name: student.name,
          schedule_rows: scheduledSessions.join('')
        });

        await sendEmail(
          student.parent_email,
          `📅 Group Class Schedule for ${student.name}`,
          scheduleHTML,
          student.parent_name,
          'Schedule'
        );
        emailsSent++;
      }
    }

    const message = send_email !== false
      ? `Group classes scheduled and emails sent to ${emailsSent} students!`
      : 'Group classes scheduled successfully!';
    res.json({ success: true, message });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Get all sessions for a student (including group sessions)
app.get('/api/sessions/:studentId', async (req, res) => {
  const id = req.adminStudentId || req.params.studentId;
  if(req.adminStudentId && req.adminStudentId != req.params.studentId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    // Get private sessions with homework info and feedback status - using retry-enabled query
    const privateSessions = await executeQuery(`
      SELECT s.*, 'Private' as source_type,
        m.file_path as homework_submission_path,
        m.feedback_grade as homework_grade,
        m.feedback_comments as homework_feedback,
        CASE WHEN cf.id IS NOT NULL THEN true ELSE false END as has_feedback
      FROM sessions s
      LEFT JOIN materials m ON m.session_id = s.id AND m.student_id = $1 AND m.file_type = 'Homework' AND m.uploaded_by = 'Parent'
      LEFT JOIN class_feedback cf ON cf.session_id = s.id AND cf.student_id = $1
      WHERE s.student_id = $1 AND s.session_type = 'Private'
    `, [id]);

    // Get group sessions for this student
    const student = await executeQuery('SELECT group_id FROM students WHERE id = $1', [id]);
    let groupSessions = [];

    if (student.rows[0] && student.rows[0].group_id) {
      const groupSessionsResult = await executeQuery(`
        SELECT s.*, 'Group' as source_type,
          m.file_path as homework_submission_path,
          m.feedback_grade as homework_grade,
          m.feedback_comments as homework_feedback,
          CASE WHEN cf.id IS NOT NULL THEN true ELSE false END as has_feedback,
          COALESCE(sa.attendance, 'Pending') as student_attendance
        FROM sessions s
        LEFT JOIN materials m ON m.session_id = s.id AND m.student_id = $1 AND m.file_type = 'Homework' AND m.uploaded_by = 'Parent'
        LEFT JOIN class_feedback cf ON cf.session_id = s.id AND cf.student_id = $1
        LEFT JOIN session_attendance sa ON sa.session_id = s.id AND sa.student_id = $1
        WHERE s.group_id = $2 AND s.session_type = 'Group'
      `, [id, student.rows[0].group_id]);
      groupSessions = groupSessionsResult.rows;
    }

    // Combine and sort
    const allSessions = [...privateSessions.rows, ...groupSessions].sort((a, b) => {
      const dateA = new Date(`${a.session_date}T${a.session_time}Z`);
      const dateB = new Date(`${b.session_date}T${b.session_time}Z`);
      return dateA - dateB;
    });

    // Fix file paths for backwards compatibility
    const fixedSessions = allSessions.map(session => {
      // Helper to check if path needs prefix (skip Cloudinary URLs)
      const needsPrefix = (path) => path && !path.startsWith('/uploads/') && !path.startsWith('LINK:') && !path.startsWith('https://') && !path.startsWith('http://');

      // Fix PPT file path
      if (needsPrefix(session.ppt_file_path)) {
        session.ppt_file_path = '/uploads/materials/' + session.ppt_file_path;
      }
      // Fix Recording file path
      if (needsPrefix(session.recording_file_path)) {
        session.recording_file_path = '/uploads/materials/' + session.recording_file_path;
      }
      // Fix Homework file path (teacher uploaded)
      if (needsPrefix(session.homework_file_path)) {
        session.homework_file_path = '/uploads/materials/' + session.homework_file_path;
      }
      // Fix homework submission path (parent uploaded)
      if (needsPrefix(session.homework_submission_path)) {
        session.homework_submission_path = '/uploads/homework/' + session.homework_submission_path;
      }
      return session;
    });

    res.json(fixedSessions);
  } catch (err) {
    console.error('Error fetching sessions:', err);
    res.status(500).json({ error: err.message });
  }
});

// Search sessions by student name (for manual cleanup)
app.get('/api/sessions/search-by-name', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) {
      return res.status(400).json({ error: 'Name parameter required' });
    }

    // Search in sessions table - look for student name in various places
    const result = await pool.query(`
      SELECT s.id, s.session_date, s.session_time, s.session_type, s.student_id,
             COALESCE(st.name, s.student_name, 'Unknown') as student_name
      FROM sessions s
      LEFT JOIN students st ON s.student_id = st.id
      WHERE LOWER(COALESCE(st.name, s.student_name, '')) LIKE LOWER($1)
      ORDER BY s.session_date DESC, s.session_time DESC
      LIMIT 100
    `, [`%${name}%`]);

    res.json({ sessions: result.rows });
  } catch (err) {
    console.error('Search sessions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a session
app.delete('/api/sessions/:sessionId', async (req, res) => {
  try {
    // Also delete related session_materials
    await pool.query('DELETE FROM session_materials WHERE session_id = $1', [req.params.sessionId]);
    await pool.query('DELETE FROM sessions WHERE id = $1', [req.params.sessionId]);
    res.json({ success: true, message: 'Session deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a session
app.put('/api/sessions/:sessionId', async (req, res) => {
  const { date, time } = req.body;
  try {
    const utc = istToUTC(date, time);
    await pool.query('UPDATE sessions SET session_date = $1::date, session_time = $2::time WHERE id = $3', [utc.date, utc.time, req.params.sessionId]);
    res.json({ success: true, message: 'Session updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a session (with reason and optional makeup credit)
app.post('/api/sessions/:sessionId/cancel', async (req, res) => {
  const { reason, notes, grant_makeup_credit, session_type } = req.body;
  try {
    // Get session details first
    const sessionResult = await pool.query('SELECT * FROM sessions WHERE id = $1', [req.params.sessionId]);
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const session = sessionResult.rows[0];

    // Get student details for email
    const studentResult = await pool.query('SELECT * FROM students WHERE id = $1', [session.student_id]);
    const student = studentResult.rows[0];

    // Update session status to Cancelled with cancelled_by = 'Teacher'
    await pool.query(
      'UPDATE sessions SET status = $1, cancelled_by = $2, teacher_notes = COALESCE(teacher_notes, \'\') || $3 WHERE id = $4',
      ['Cancelled', 'Teacher', `\n[Cancelled: ${reason}${notes ? ' - ' + notes : ''}]`, req.params.sessionId]
    );

    // If grant makeup credit is checked, add a makeup credit to the student
    if (grant_makeup_credit) {
      // Add to makeup_classes table
      await pool.query(`
        INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status, added_by, notes)
        VALUES ($1, $2, $3, CURRENT_DATE, 'Available', 'admin', $4)
      `, [session.student_id, session.id, reason || 'Teacher cancelled', notes || '']);
    }

    // Send cancellation email to parent
    if (student && student.parent_email) {
      try {
        // Convert UTC time to student's local timezone
        const studentTimezone = student.timezone || 'Asia/Kolkata';
        const localTime = formatUTCToLocal(session.session_date, session.session_time, studentTimezone);
        const timezoneLabel = getTimezoneLabel(studentTimezone);

        const emailHTML = getClassCancelledEmail({
          parentName: student.parent_name || 'Parent',
          studentName: student.name,
          sessionDate: `${localTime.day}, ${localTime.date}`,
          sessionTime: `${localTime.time} (${timezoneLabel})`,
          cancelledBy: 'Teacher',
          reason: reason,
          hasMakeupCredit: grant_makeup_credit
        });

        await sendEmail(
          student.parent_email,
          `📅 Class Cancelled - ${student.name}`,
          emailHTML,
          student.parent_name,
          'Class-Cancelled'
        );
      } catch (emailErr) {
        console.error('Failed to send cancellation email:', emailErr);
      }
    }

    res.json({
      success: true,
      message: `Class cancelled successfully${grant_makeup_credit ? ' (makeup credit granted)' : ''}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/parent-view-token', async (req, res) => {
  try {
    const { student_id } = req.body;
    const student = await pool.query('SELECT id FROM students WHERE id = $1', [student_id]);
    if (student.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    const token = generateAdminToken(student_id);
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/parent/admin-view', async (req, res) => {
  const studentId = req.adminStudentId;
  if (!studentId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const student = await pool.query(`
      SELECT s.*,
        GREATEST(COALESCE(s.missed_sessions, 0), COALESCE((SELECT COUNT(*) FROM sessions WHERE student_id = s.id AND status IN ('Missed', 'Excused', 'Unexcused')), 0)) as missed_sessions
      FROM students s
      WHERE s.id = $1 AND s.is_active = true
    `, [studentId]);
    res.json({ student: student.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:sessionId/details', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sessions WHERE id = $1', [req.params.sessionId]);
    const session = result.rows[0];

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Fix file paths for backwards compatibility (skip Cloudinary URLs)
    if (session) {
      const needsPrefix = (path) => path && !path.startsWith('/uploads/') && !path.startsWith('LINK:') && !path.startsWith('https://') && !path.startsWith('http://');
      if (needsPrefix(session.ppt_file_path)) {
        session.ppt_file_path = '/uploads/materials/' + session.ppt_file_path;
      }
      if (needsPrefix(session.recording_file_path)) {
        session.recording_file_path = '/uploads/materials/' + session.recording_file_path;
      }
      if (needsPrefix(session.homework_file_path)) {
        session.homework_file_path = '/uploads/materials/' + session.homework_file_path;
      }
    }

    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:sessionId/attendance', async (req, res) => {
  try {
    const { attendance } = req.body;
    const sessionId = req.params.sessionId;

    // Determine session status based on attendance
    let sessionStatus;
    if (attendance === 'Present') {
      sessionStatus = 'Completed';
    } else if (attendance === 'Excused') {
      sessionStatus = 'Excused';
    } else {
      sessionStatus = 'Missed'; // Unexcused or Absent
    }

    await pool.query('UPDATE sessions SET status = $1 WHERE id = $2', [sessionStatus, sessionId]);

    // Get student info for the session
    const session = await pool.query('SELECT student_id FROM sessions WHERE id = $1', [sessionId]);

    if (session.rows[0] && session.rows[0].student_id) {
      const studentId = session.rows[0].student_id;

      if (attendance === 'Present') {
        // Mark as completed and update student stats
        await pool.query('UPDATE students SET completed_sessions = completed_sessions + 1, remaining_sessions = GREATEST(remaining_sessions - 1, 0) WHERE id = $1', [studentId]);

        // Award attendance badges
        const student = await pool.query('SELECT completed_sessions FROM students WHERE id = $1', [studentId]);
        const completedCount = student.rows[0]?.completed_sessions || 0;

        if (completedCount === 1) await awardBadge(studentId, 'first_class', '🌟 First Class Star', 'Attended first class!');
        if (completedCount === 5) await awardBadge(studentId, '5_classes', '🏆 5 Classes Champion', 'Completed 5 classes!');
        if (completedCount === 10) await awardBadge(studentId, '10_classes', '👑 10 Classes Master', 'Completed 10 classes!');
        if (completedCount === 25) await awardBadge(studentId, '25_classes', '🎖️ 25 Classes Legend', 'Completed 25 classes!');
        if (completedCount === 50) await awardBadge(studentId, '50_classes', '💎 50 Classes Diamond', 'Amazing milestone!');
      } else if (attendance === 'Excused') {
        // Excused absence - grant makeup credit
        await pool.query(`
          INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status, added_by)
          VALUES ($1, $2, 'Excused absence', CURRENT_DATE, 'Available', 'admin')
        `, [studentId, sessionId]);

        // Decrement remaining_sessions as the class was used
        await pool.query('UPDATE students SET remaining_sessions = GREATEST(remaining_sessions - 1, 0) WHERE id = $1', [studentId]);
      } else {
        // Unexcused absence - no makeup credit, just decrement remaining sessions
        await pool.query('UPDATE students SET remaining_sessions = GREATEST(remaining_sessions - 1, 0) WHERE id = $1', [studentId]);
      }
    }

    const message = attendance === 'Present' ? 'Marked as Present' :
                    attendance === 'Excused' ? 'Marked as Excused (makeup credit granted)' :
                    'Marked as Unexcused (no makeup credit)';

    res.json({ success: true, message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:sessionId/group-attendance', async (req, res) => {
  try {
    // First try to get from session_attendance table
    let result = await pool.query(`
      SELECT sa.*, s.name as student_name
      FROM session_attendance sa
      JOIN students s ON sa.student_id = s.id
      WHERE sa.session_id = $1
      ORDER BY s.name
    `, [req.params.sessionId]);

    // If no records exist, get the group_id and fetch all enrolled students
    if (result.rows.length === 0) {
      const session = await pool.query('SELECT group_id FROM sessions WHERE id = $1', [req.params.sessionId]);
      if (session.rows[0]?.group_id) {
        const groupId = session.rows[0].group_id;
        // Get enrolled students for this group
        const students = await pool.query(`
          SELECT s.id as student_id, s.name as student_name, 'Pending' as attendance
          FROM students s
          WHERE s.group_id = $1 AND s.is_active = true
          ORDER BY s.name
        `, [groupId]);

        // Create session_attendance records for each student
        for (const student of students.rows) {
          await pool.query(
            'INSERT INTO session_attendance (session_id, student_id, attendance) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [req.params.sessionId, student.student_id, 'Pending']
          );
        }

        // Re-fetch the records
        result = await pool.query(`
          SELECT sa.*, s.name as student_name
          FROM session_attendance sa
          JOIN students s ON sa.student_id = s.id
          WHERE sa.session_id = $1
          ORDER BY s.name
        `, [req.params.sessionId]);
      }
    }

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:sessionId/group-attendance', async (req, res) => {
  const client = await pool.connect();
  try {
    const { attendanceData } = req.body;
    const sessionId = req.params.sessionId;

    await client.query('BEGIN');

    for (const record of attendanceData) {
      const prev = await client.query('SELECT attendance FROM session_attendance WHERE session_id = $1 AND student_id = $2', [sessionId, record.student_id]);
      const prevAttendance = prev.rows[0]?.attendance;

      // Use UPSERT to ensure record exists and is updated
      await client.query(`
        INSERT INTO session_attendance (session_id, student_id, attendance)
        VALUES ($1, $2, $3)
        ON CONFLICT (session_id, student_id)
        DO UPDATE SET attendance = $3
      `, [sessionId, record.student_id, record.attendance]);

      // Handle state transitions
      const wasPresent = prevAttendance === 'Present';
      const wasExcused = prevAttendance === 'Excused';
      const wasUnexcused = prevAttendance === 'Unexcused' || prevAttendance === 'Absent';
      const wasPending = !prevAttendance || prevAttendance === 'Pending';

      if (record.attendance === 'Present') {
        // If changing TO Present from non-Present
        if (!wasPresent) {
          await client.query(`UPDATE students SET completed_sessions = completed_sessions + 1 WHERE id = $1`, [record.student_id]);

          // Only decrement remaining if coming from Pending (not already decremented)
          if (wasPending) {
            await client.query(`UPDATE students SET remaining_sessions = GREATEST(remaining_sessions - 1, 0) WHERE id = $1`, [record.student_id]);
          }

          // Award badges for group class attendance
          const student = await client.query('SELECT completed_sessions FROM students WHERE id = $1', [record.student_id]);
          const completedCount = student.rows[0].completed_sessions;

          if (completedCount === 1) await awardBadge(record.student_id, 'first_class', '🌟 First Class Star', 'Attended first class!');
          if (completedCount === 5) await awardBadge(record.student_id, '5_classes', '🏆 5 Classes Champion', 'Completed 5 classes!');
          if (completedCount === 10) await awardBadge(record.student_id, '10_classes', '👑 10 Classes Master', 'Completed 10 classes!');
          if (completedCount === 25) await awardBadge(record.student_id, '25_classes', '🎖️ 25 Classes Legend', 'Completed 25 classes!');
          if (completedCount === 50) await awardBadge(record.student_id, '50_classes', '💎 50 Classes Diamond', 'Amazing milestone!');
        }
      } else if (record.attendance === 'Excused') {
        // Excused absence - grant makeup credit (only if not already excused)
        if (!wasExcused) {
          await client.query(`
            INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status, added_by)
            VALUES ($1, $2, 'Excused absence (group class)', CURRENT_DATE, 'Available', 'admin')
          `, [record.student_id, sessionId]);

          // Decrement remaining sessions if coming from Pending
          if (wasPending) {
            await client.query(`UPDATE students SET remaining_sessions = GREATEST(remaining_sessions - 1, 0) WHERE id = $1`, [record.student_id]);
          }
        }
      } else if (record.attendance === 'Unexcused' || record.attendance === 'Absent') {
        // Unexcused absence - no makeup credit, just decrement remaining sessions if from Pending
        if (wasPending) {
          await client.query(`UPDATE students SET remaining_sessions = GREATEST(remaining_sessions - 1, 0) WHERE id = $1`, [record.student_id]);
        }
      }
    }

    await client.query('UPDATE sessions SET status = $1 WHERE id = $2', ['Completed', sessionId]);
    await client.query('COMMIT');
    res.json({ message: 'Group attendance marked successfully!' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Reschedule a session (private or group)
app.post('/api/sessions/:sessionId/reschedule', async (req, res) => {
  const { new_date, new_time, reason } = req.body;
  const sessionId = req.params.sessionId;

  if (!new_date || !new_time) {
    return res.status(400).json({ error: 'New date and time are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get current session details
    const sessionRes = await client.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    if (sessionRes.rows.length === 0) {
      throw new Error('Session not found');
    }
    const session = sessionRes.rows[0];
    const oldDate = session.session_date;
    const oldTime = session.session_time;

    // Convert to UTC if needed
    const converted = istToUTC(new_date, new_time);

    // Update the session with new date and time
    await client.query(
      'UPDATE sessions SET session_date = $1, session_time = $2, status = $3 WHERE id = $4',
      [converted.date, converted.time, 'Scheduled', sessionId]
    );

    // Get students to notify
    let studentsToNotify = [];
    if (session.session_type === 'Group' && session.group_id) {
      const groupStudents = await client.query(
        'SELECT s.*, g.name as group_name FROM students s JOIN groups g ON s.group_id = g.id WHERE s.group_id = $1 AND s.is_active = true',
        [session.group_id]
      );
      studentsToNotify = groupStudents.rows;
    } else if (session.student_id) {
      const student = await client.query('SELECT * FROM students WHERE id = $1', [session.student_id]);
      studentsToNotify = student.rows;
    }

    await client.query('COMMIT');

    // Send reschedule notification emails
    for (const student of studentsToNotify) {
      try {
        await sendEmail(student.parent_email, 'Class Rescheduled - Fluent Feathers Academy', getRescheduleEmailTemplate({
          parent_name: student.parent_name,
          student_name: student.name,
          session_number: session.session_number,
          old_date: oldDate,
          old_time: oldTime,
          new_date: converted.date,
          new_time: converted.time,
          reason: reason || 'Schedule adjustment',
          is_group: session.session_type === 'Group',
          group_name: student.group_name || '',
          timezone: student.timezone || 'Asia/Kolkata'
        }));

        await pool.query(
          'INSERT INTO email_log (student_id, recipient_email, recipient_name, email_type, subject, status) VALUES ($1, $2, $3, $4, $5, $6)',
          [student.id, student.parent_email, student.parent_name, 'Reschedule', 'Class Rescheduled', 'Sent']
        );
      } catch (emailErr) {
        console.error('Failed to send reschedule email to', student.parent_email, emailErr.message);
      }
    }

    res.json({
      message: 'Session rescheduled successfully!',
      new_date: converted.date,
      new_time: converted.time,
      students_notified: studentsToNotify.length
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/sessions/:sessionId/upload', handleUpload('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded. If using Cloudinary, check credentials in Render environment variables.' });
  const col = { ppt:'ppt_file_path', recording:'recording_file_path', homework:'homework_file_path' }[req.body.materialType];
  if (!col) return res.status(400).json({ error: 'Invalid type' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Get file path - Cloudinary returns URL in path/secure_url, local storage uses filename
    let filePath;
    if (useCloudinary) {
      // Cloudinary - check multiple possible fields for the URL
      filePath = req.file.path || req.file.secure_url || req.file.url;
      console.log('📁 Cloudinary upload:', { path: req.file.path, secure_url: req.file.secure_url, url: req.file.url, filename: req.file.filename });
      if (!filePath) {
        throw new Error('Cloudinary did not return a file URL. Check your Cloudinary credentials.');
      }
    } else {
      // Local storage - use relative path
      filePath = '/uploads/materials/' + req.file.filename;
    }
    await client.query(`UPDATE sessions SET ${col} = $1 WHERE id = $2`, [filePath, req.params.sessionId]);
    const session = (await client.query('SELECT * FROM sessions WHERE id = $1', [req.params.sessionId])).rows[0];

    // Also add to session_materials table for multiple file support
    await client.query(`
      INSERT INTO session_materials (session_id, material_type, file_name, file_path, file_size)
      VALUES ($1, $2, $3, $4, $5)
    `, [req.params.sessionId, req.body.materialType.toUpperCase(), req.file.originalname, filePath, req.file.size || 0]);

    const studentsQuery = session.session_type === 'Group' ? `SELECT id FROM students WHERE group_id = $1 AND is_active = true` : `SELECT $1 as id`;
    const students = await client.query(studentsQuery, [session.group_id || session.student_id]);
    for(const s of students.rows) {
      await client.query(`
        INSERT INTO materials (student_id, group_id, session_id, session_date, file_type, file_name, file_path, uploaded_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'Teacher')
      `, [s.id, session.group_id, req.params.sessionId, session.session_date, req.body.materialType.toUpperCase(), req.file.originalname, filePath]);
    }
    await client.query('COMMIT');
    res.json({ message: 'Material uploaded successfully!', filename: req.file.filename });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/sessions/:sessionId/notes', async (req, res) => {
  try {
    await pool.query('UPDATE sessions SET teacher_notes = $1 WHERE id = $2', [req.body.teacher_notes, req.params.sessionId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all materials for a session
app.get('/api/sessions/:sessionId/materials', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM session_materials WHERE session_id = $1 ORDER BY material_type, uploaded_at DESC',
      [req.params.sessionId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a specific material
app.delete('/api/session-materials/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM session_materials WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Material deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save material link (for PPT, Recording, Homework links like Google Drive, YouTube, etc.)
app.post('/api/sessions/:sessionId/save-link', async (req, res) => {
  const { materialType, link } = req.body;
  const col = { ppt:'ppt_file_path', recording:'recording_file_path', homework:'homework_file_path' }[materialType];
  if (!col) return res.status(400).json({ error: 'Invalid material type' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Save link with LINK: prefix to identify it as a link
    await client.query(`UPDATE sessions SET ${col} = $1 WHERE id = $2`, ['LINK:' + link, req.params.sessionId]);

    // Also save to materials table for tracking
    const session = (await client.query('SELECT * FROM sessions WHERE id = $1', [req.params.sessionId])).rows[0];
    const studentsQuery = session.session_type === 'Group' ? `SELECT id FROM students WHERE group_id = $1 AND is_active = true` : `SELECT $1 as id`;
    const students = await client.query(studentsQuery, [session.group_id || session.student_id]);

    for(const s of students.rows) {
      await client.query(`
        INSERT INTO materials (student_id, group_id, session_id, session_date, file_type, file_name, file_path, uploaded_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'Teacher')
      `, [s.id, session.group_id, req.params.sessionId, session.session_date, materialType.toUpperCase(), 'External Link', 'LINK:' + link]);
    }

    await client.query('COMMIT');
    res.json({ message: 'Link saved successfully!' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/sessions/:sessionId/grade/:studentId', async (req, res) => {
  const client = await pool.connect();
  try {
    const { grade, comments } = req.body;
    const { sessionId, studentId } = req.params;
    await client.query('BEGIN');
    await client.query('UPDATE session_attendance SET homework_grade = $1, homework_comments = $2 WHERE session_id = $3 AND student_id = $4', [grade, comments, sessionId, studentId]);
    await client.query(`UPDATE materials SET feedback_grade = $1, feedback_comments = $2, feedback_given = 1, feedback_date = CURRENT_TIMESTAMP WHERE session_id = $3 AND student_id = $4 AND file_type = 'Homework'`, [grade, comments, sessionId, studentId]);
    await client.query('COMMIT');
    res.json({ message: 'Homework graded successfully!' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/materials/:studentId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM materials WHERE student_id = $1 ORDER BY uploaded_at DESC', [req.params.studentId]);

    // Ensure file paths have correct prefix for backwards compatibility
    const rows = result.rows.map(row => {
      // Skip if already has correct prefix, is a link, or is a Cloudinary/external URL
      if (row.file_path && !row.file_path.startsWith('/uploads/') && !row.file_path.startsWith('LINK:') && !row.file_path.startsWith('https://') && !row.file_path.startsWith('http://')) {
        // Determine correct folder based on file type
        const folder = row.uploaded_by === 'Parent' ? 'homework' : 'materials';
        row.file_path = `/uploads/${folder}/` + row.file_path;
      }
      return row;
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload/homework/:studentId', handleUpload('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded. If using Cloudinary, check credentials in Render environment variables.' });
  try {
    // Get file path - Cloudinary returns URL in req.file.path, local storage uses filename
    let filePath;
    if (useCloudinary) {
      // Cloudinary: use secure_url if available, otherwise path
      filePath = req.file.secure_url || req.file.path || req.file.url;
      console.log('📁 Cloudinary homework upload:', { path: req.file.path, secure_url: req.file.secure_url, url: req.file.url });
      if (!filePath) {
        return res.status(500).json({ error: 'Cloudinary did not return file URL. Check your CLOUDINARY_URL or CLOUDINARY_API_KEY/SECRET/CLOUD_NAME in Render.' });
      }
    } else {
      // Local storage - use relative path
      filePath = '/uploads/homework/' + req.file.filename;
    }

    await pool.query(`
      INSERT INTO materials (student_id, session_id, session_date, file_type, file_name, file_path, uploaded_by)
      VALUES ($1, $2, CURRENT_DATE, 'Homework', $3, $4, 'Parent')
    `, [req.params.studentId, req.body.sessionId, req.file.originalname, filePath]);

    // Award homework submission badge
    await awardBadge(req.params.studentId, 'hw_submit', '📝 Homework Hero', 'Submitted homework on time');

    // Check total homework submissions for milestone badges
    const hwCount = await pool.query('SELECT COUNT(*) as count FROM materials WHERE student_id = $1 AND file_type = \'Homework\'', [req.params.studentId]);
    const count = parseInt(hwCount.rows[0].count);

    if (count === 5) await awardBadge(req.params.studentId, '5_homework', '📚 5 Homework Superstar', 'Submitted 5 homework assignments!');
    if (count === 10) await awardBadge(req.params.studentId, '10_homework', '🎓 10 Homework Champion', 'Submitted 10 homework assignments!');
    if (count === 25) await awardBadge(req.params.studentId, '25_homework', '🏅 25 Homework Master', 'Submitted 25 homework assignments!');

    res.json({ message: 'Homework uploaded successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/events', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT e.*, COUNT(DISTINCT er.id) as registered_count
      FROM events e
      LEFT JOIN event_registrations er ON e.id = er.event_id
      GROUP BY e.id
      ORDER BY e.event_date DESC
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events', async (req, res) => {
  const { event_name, event_description, event_date, event_time, event_duration, target_audience, specific_grades, meet_link, max_participants, send_email } = req.body;
  try {
    const utc = istToUTC(event_date, event_time);
    const result = await pool.query(`
      INSERT INTO events (event_name, event_description, event_date, event_time, event_duration, target_audience, specific_grades, meet_link, max_participants, status)
      VALUES ($1, $2, $3::date, $4::time, $5, $6, $7, $8, $9, 'Active')
      RETURNING id
    `, [event_name, event_description || '', utc.date, utc.time, event_duration, target_audience || 'All', specific_grades || '', meet_link || DEFAULT_MEET, max_participants || null]);

    const eventId = result.rows[0].id;
    let students = [];

    if (target_audience === 'All' || !target_audience) {
      students = await pool.query('SELECT * FROM students WHERE is_active = true');
    } else if (target_audience === 'Specific Grades' && specific_grades) {
      students = await pool.query('SELECT * FROM students WHERE is_active = true AND grade = ANY($1)', [specific_grades.split(',').map(g=>g.trim())]);
    }

    let emailsSent = 0;
    if (students?.rows?.length > 0 && send_email !== false) {
      for(const student of students.rows) {
        const display = formatUTCToLocal(utc.date, utc.time, student.timezone);
        const registrationLink = `${req.protocol}://${req.get('host')}/parent.html?event=${eventId}&student=${student.id}`;

        const eventEmailHTML = getEventEmail({
          parent_name: student.parent_name,
          event_name,
          event_description: event_description || '',
          event_date: display.date,
          event_time: display.time,
          event_duration,
          meet_link: meet_link || DEFAULT_MEET,
          registration_link: registrationLink
        });

        await sendEmail(
          student.parent_email,
          `🎉 ${event_name} - Registration Open`,
          eventEmailHTML,
          student.parent_name,
          'Event'
        );
        emailsSent++;
      }
    }

    const message = send_email !== false
      ? `Event created and emails sent to ${emailsSent} students!`
      : `Event created successfully!`;
    res.json({ success: true, message, eventId });
  } catch (err) {
    console.error('Event creation error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/events/:eventId/register', async (req, res) => {
  const client = await pool.connect();
  try {
    const { student_id } = req.body;
    const eventId = req.params.eventId;
    const eventResult = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
    const event = eventResult.rows[0];

    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (event.max_participants && event.current_participants >= event.max_participants) {
      return res.status(400).json({ error: 'Event is full' });
    }

    await client.query('BEGIN');
    await client.query(`INSERT INTO event_registrations (event_id, student_id, registration_method) VALUES ($1, $2, 'Parent')`, [eventId, student_id]);
    await client.query('UPDATE events SET current_participants = current_participants + 1 WHERE id = $1', [eventId]);
    await client.query('COMMIT');
    res.json({ message: 'Successfully registered for event!' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.constraint === 'event_registrations_event_id_student_id_key') {
      res.status(400).json({ error: 'Already registered for this event' });
    } else {
      res.status(500).json({ error: err.message });
    }
  } finally {
    client.release();
  }
});

app.post('/api/events/:eventId/register-manual', async (req, res) => {
  try {
    await pool.query(`INSERT INTO event_registrations (event_id, student_id, registration_method) VALUES ($1, $2, 'Manual')`, [req.params.eventId, req.body.student_id]);
    await pool.query('UPDATE events SET current_participants = current_participants + 1 WHERE id = $1', [req.params.eventId]);
    res.json({ message: 'Student registered successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/events/:eventId/registrations', async (req, res) => {
  try {
    res.json((await pool.query(`
      SELECT er.*, s.name as student_name, s.grade, s.parent_name, s.parent_email
      FROM event_registrations er
      JOIN students s ON er.student_id = s.id
      WHERE er.event_id = $1
    `, [req.params.eventId])).rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events/:eventId/attendance', async (req, res) => {
  try {
    for(const record of req.body.attendanceData) {
      await pool.query('UPDATE event_registrations SET attendance = $1 WHERE event_id = $2 AND student_id = $3', [record.attendance, req.params.eventId, record.student_id]);
    }
    res.json({ message: 'Event attendance marked successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/events/:id', async (req, res) => {
  const { event_name, event_description, event_duration, status, max_participants, meet_link } = req.body;
  try {
    await pool.query(`
      UPDATE events SET
        event_name = $1,
        event_description = $2,
        event_duration = $3,
        status = $4,
        max_participants = $5,
        meet_link = $6
      WHERE id = $7
    `, [event_name, event_description, event_duration, status, max_participants, meet_link, req.params.id]);
    res.json({ success: true, message: 'Event updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM event_registrations WHERE event_id = $1', [req.params.id]);
    await pool.query('DELETE FROM events WHERE id = $1', [req.params.id]);
    res.json({ message: 'Event deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/events/student/:studentId', async (req, res) => {
  try {
    const studentResult = await pool.query('SELECT * FROM students WHERE id = $1', [req.params.studentId]);
    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const student = studentResult.rows[0];
    const today = new Date().toISOString().split('T')[0];

    const events = await pool.query(`
      SELECT e.*,
        CASE WHEN er.id IS NOT NULL THEN true ELSE false END as is_registered
      FROM events e
      LEFT JOIN event_registrations er ON e.id = er.event_id AND er.student_id = $1
      WHERE e.status = 'Active'
        AND e.event_date >= $2
        AND (
          e.target_audience = 'All'
          OR (e.target_audience = 'Specific Grades' AND e.specific_grades LIKE '%' || $3 || '%')
        )
      ORDER BY e.event_date ASC
    `, [req.params.studentId, today, student.grade]);

    res.json(events.rows);
  } catch (err) {
    console.error('Error loading events for student:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/events/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/email-logs', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM email_log ORDER BY sent_at DESC LIMIT 100');
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/past/all', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const p = await pool.query(`
      SELECT s.*, st.name as student_name, st.timezone, NULL as group_name
      FROM sessions s
      JOIN students st ON s.student_id = st.id
      WHERE s.session_date <= $1 AND s.session_type = 'Private'
      ORDER BY s.session_date DESC, s.session_time DESC
      LIMIT 50
    `, [today]);

    const g = await pool.query(`
      SELECT s.*, g.group_name as student_name, g.timezone, g.group_name
      FROM sessions s
      JOIN groups g ON s.group_id = g.id
      WHERE s.session_date <= $1 AND s.session_type = 'Group'
      ORDER BY s.session_date DESC, s.session_time DESC
      LIMIT 50
    `, [today]);

    const all = [...p.rows, ...g.rows].sort((a, b) => {
      // Handle date which could be Date object or string
      const getDateStr = (d) => {
        if (!d) return '1970-01-01';
        if (d instanceof Date) return d.toISOString().split('T')[0];
        if (typeof d === 'string' && d.includes('T')) return d.split('T')[0];
        return String(d);
      };
      const dateStrA = getDateStr(a.session_date);
      const dateStrB = getDateStr(b.session_date);
      const timeA = a.session_time || '00:00:00';
      const timeB = b.session_time || '00:00:00';
      const dateA = new Date(`${dateStrA}T${timeA}Z`);
      const dateB = new Date(`${dateStrB}T${timeB}Z`);
      return dateB - dateA; // Descending - most recent first
    }).slice(0, 50);

    // Fix file paths for backwards compatibility (skip Cloudinary URLs)
    const fixed = all.map(session => {
      const needsPrefix = (path) => path && !path.startsWith('/uploads/') && !path.startsWith('LINK:') && !path.startsWith('https://') && !path.startsWith('http://');
      if (needsPrefix(session.ppt_file_path)) {
        session.ppt_file_path = '/uploads/materials/' + session.ppt_file_path;
      }
      if (needsPrefix(session.recording_file_path)) {
        session.recording_file_path = '/uploads/materials/' + session.recording_file_path;
      }
      if (needsPrefix(session.homework_file_path)) {
        session.homework_file_path = '/uploads/materials/' + session.homework_file_path;
      }
      return session;
    });

    res.json(fixed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/parent/cancel-class', async (req, res) => {
  const id = req.adminStudentId || req.body.student_id;
  try {
    const session = (await pool.query('SELECT * FROM sessions WHERE id = $1 AND student_id = $2', [req.body.session_id, id])).rows[0];
    if(!session) return res.status(404).json({ error: 'Session not found' });
    const sessionTime = new Date(`${session.session_date}T${session.session_time}Z`);
    const oneHour = 60 * 60 * 1000;
    if((sessionTime - new Date()) < oneHour) {
      return res.status(400).json({ error: 'Cannot cancel class less than 1 hour before start.' });
    }

    // Get student details for email
    const studentResult = await pool.query('SELECT * FROM students WHERE id = $1', [id]);
    const student = studentResult.rows[0];

    await pool.query('UPDATE sessions SET status = $1, cancelled_by = $2 WHERE id = $3', ['Cancelled by Parent', 'Parent', session.id]);
    await pool.query(`INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status, added_by) VALUES ($1, $2, $3, CURRENT_DATE, 'Available', 'parent')`, [id, session.id, req.body.reason || 'Parent cancelled']);

    // Send cancellation confirmation email to parent
    if (student && student.parent_email) {
      try {
        // Convert UTC time to student's local timezone
        const studentTimezone = student.timezone || 'Asia/Kolkata';
        const localTime = formatUTCToLocal(session.session_date, session.session_time, studentTimezone);
        const timezoneLabel = getTimezoneLabel(studentTimezone);

        const emailHTML = getClassCancelledEmail({
          parentName: student.parent_name || 'Parent',
          studentName: student.name,
          sessionDate: `${localTime.day}, ${localTime.date}`,
          sessionTime: `${localTime.time} (${timezoneLabel})`,
          cancelledBy: 'Parent',
          reason: req.body.reason || 'Parent cancelled',
          hasMakeupCredit: true
        });

        await sendEmail(
          student.parent_email,
          `📅 Class Cancelled - ${student.name}`,
          emailHTML,
          student.parent_name,
          'Class-Cancelled'
        );
      } catch (emailErr) {
        console.error('Failed to send cancellation email:', emailErr);
      }
    }

    res.json({ message: 'Class cancelled! Makeup credit added.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/:studentId/makeup-credits', async (req, res) => {
  const id = req.adminStudentId || req.params.studentId;
  try {
    res.json((await pool.query('SELECT * FROM makeup_classes WHERE student_id = $1 AND status = \'Available\'', [id])).rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get full makeup credit history for a student (including used/scheduled)
app.get('/api/students/:studentId/makeup-history', async (req, res) => {
  const id = req.adminStudentId || req.params.studentId;
  try {
    const result = await pool.query(`
      SELECT m.*, s.session_date as scheduled_session_date, s.session_time as scheduled_session_time
      FROM makeup_classes m
      LEFT JOIN sessions s ON m.scheduled_session_id = s.id
      WHERE m.student_id = $1
      ORDER BY m.created_at DESC
    `, [id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Manually add makeup credit for a student
app.post('/api/students/:studentId/makeup-credits', async (req, res) => {
  try {
    const { reason, notes } = req.body;
    const studentId = req.params.studentId;

    // Get student details for email
    const studentResult = await pool.query('SELECT * FROM students WHERE id = $1', [studentId]);
    const student = studentResult.rows[0];

    await pool.query(`
      INSERT INTO makeup_classes (student_id, reason, credit_date, status, added_by, notes)
      VALUES ($1, $2, CURRENT_DATE, 'Available', 'admin', $3)
    `, [studentId, reason || 'Emergency - added by admin', notes || '']);

    // Send email to parent about makeup credit
    if (student && student.parent_email) {
      try {
        const emailHTML = getMakeupCreditAddedEmail({
          parentName: student.parent_name || 'Parent',
          studentName: student.name,
          reason: reason || 'Emergency - added by admin',
          notes: notes
        });

        await sendEmail(
          student.parent_email,
          `🎁 Makeup Credit Added - ${student.name}`,
          emailHTML,
          student.parent_name,
          'Makeup-Credit'
        );
      } catch (emailErr) {
        console.error('Failed to send makeup credit email:', emailErr);
      }
    }

    res.json({ success: true, message: 'Makeup credit added successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Delete a makeup credit
app.delete('/api/makeup-credits/:creditId', async (req, res) => {
  try {
    const { creditId } = req.params;

    // Check if credit exists and is available (not already used)
    const credit = await pool.query('SELECT * FROM makeup_classes WHERE id = $1', [creditId]);
    if (credit.rows.length === 0) {
      return res.status(404).json({ error: 'Makeup credit not found' });
    }

    if (credit.rows[0].status === 'Scheduled' || credit.rows[0].status === 'Used') {
      return res.status(400).json({ error: 'Cannot delete a makeup credit that has already been scheduled or used' });
    }

    await pool.query('DELETE FROM makeup_classes WHERE id = $1', [creditId]);
    res.json({ success: true, message: 'Makeup credit deleted successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Schedule a makeup class using a credit
app.put('/api/makeup-credits/:creditId/schedule', async (req, res) => {
  const client = await pool.connect();
  try {
    const { creditId } = req.params;
    const { session_date, session_time, student_id } = req.body;

    // Verify credit exists and is available
    const credit = await client.query('SELECT * FROM makeup_classes WHERE id = $1 AND status = $2', [creditId, 'Available']);
    if (credit.rows.length === 0) {
      return res.status(400).json({ error: 'Makeup credit not found or already used' });
    }

    // Get student info for timezone and meet link
    const student = await client.query('SELECT * FROM students WHERE id = $1', [student_id]);
    if (student.rows.length === 0) {
      return res.status(400).json({ error: 'Student not found' });
    }

    await client.query('BEGIN');

    // Convert to UTC
    const utc = istToUTC(session_date, session_time);

    // Get next session number for this student
    const countResult = await client.query('SELECT COUNT(*) as count FROM sessions WHERE student_id = $1', [student_id]);
    const sessionNumber = parseInt(countResult.rows[0].count) + 1;

    // Create the makeup session
    const sessionResult = await client.query(`
      INSERT INTO sessions (student_id, session_type, session_number, session_date, session_time, meet_link, status, notes)
      VALUES ($1, 'Private', $2, $3::date, $4::time, $5, 'Scheduled', 'Makeup Class')
      RETURNING id
    `, [student_id, sessionNumber, utc.date, utc.time, student.rows[0].meet_link || DEFAULT_MEET]);

    const newSessionId = sessionResult.rows[0].id;

    // Mark the credit as used and link to the new session
    await client.query(`
      UPDATE makeup_classes
      SET status = 'Scheduled', used_date = CURRENT_DATE, scheduled_session_id = $1, scheduled_date = $2, scheduled_time = $3
      WHERE id = $4
    `, [newSessionId, session_date, session_time, creditId]);

    await client.query('COMMIT');

    // Send email notification to parent
    const studentData = student.rows[0];
    const localTime = formatUTCToLocal(utc.date, utc.time, studentData.timezone || 'Asia/Kolkata');

    if (studentData.parent_email) {
      const emailHTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', sans-serif; background-color: #f0f4f8;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 30px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 28px;">🎉 Makeup Class Scheduled!</h1>
    </div>
    <div style="padding: 30px;">
      <p style="font-size: 16px; color: #2d3748;">Dear <strong>${studentData.parent_name}</strong>,</p>
      <p style="font-size: 15px; color: #4a5568;">Great news! A makeup class has been scheduled for <strong>${studentData.name}</strong>.</p>

      <div style="background: #f7fafc; border-left: 4px solid #f093fb; padding: 20px; margin: 20px 0; border-radius: 8px;">
        <h3 style="color: #f093fb; margin-top: 0;">📅 Class Details</h3>
        <p style="margin: 5px 0;"><strong>Date:</strong> ${localTime.day}, ${localTime.date}</p>
        <p style="margin: 5px 0;"><strong>Time:</strong> ${localTime.time}</p>
        <p style="margin: 5px 0;"><strong>Session:</strong> #${sessionNumber} (Makeup)</p>
      </div>

      <div style="text-align: center; margin: 25px 0;">
        <a href="${studentData.meet_link || DEFAULT_MEET}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 14px 35px; text-decoration: none; border-radius: 25px; font-weight: bold;">🎥 Join Class on Meet</a>
      </div>

      <p style="font-size: 14px; color: #718096;">We look forward to seeing ${studentData.name} in class!</p>
      <p style="margin-top: 20px; color: #2d3748;">Best regards,<br><strong style="color: #667eea;">Team Fluent Feathers Academy</strong></p>
    </div>
  </div>
</body>
</html>`;

      await sendEmail(studentData.parent_email, `🎉 Makeup Class Scheduled for ${studentData.name}`, emailHTML, studentData.parent_name, 'Makeup-Schedule');
    }

    res.json({
      success: true,
      message: 'Makeup class scheduled successfully!',
      session_id: newSessionId,
      session_number: sessionNumber
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/parent/check-email', async (req, res) => {
  try {
    const s = (await pool.query('SELECT * FROM students WHERE parent_email = $1 AND is_active = true', [req.body.email])).rows;
    if(s.length===0) return res.status(404).json({ error: 'No student found.' });
    const c = (await pool.query('SELECT password FROM parent_credentials WHERE parent_email = $1', [req.body.email])).rows[0];
    // Include students list for session restoration (persistent login)
    res.json({ hasPassword: c && c.password ? true : false, students: s });
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

app.post('/api/parent/setup-password', async (req, res) => {
  try {
    const s = (await pool.query('SELECT * FROM students WHERE parent_email = $1 AND is_active = true', [req.body.email])).rows;
    const h = await bcrypt.hash(req.body.password, 10);
    await pool.query(`INSERT INTO parent_credentials (parent_email, password) VALUES ($1, $2) ON CONFLICT(parent_email) DO UPDATE SET password = $2`, [req.body.email, h]);
    res.json({ students: s });
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

app.post('/api/parent/login-password', async (req, res) => {
  try {
    const c = (await pool.query('SELECT password FROM parent_credentials WHERE parent_email = $1', [req.body.email])).rows[0];
    if(!c || !(await bcrypt.compare(req.body.password, c.password))) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    const s = (await pool.query(`
      SELECT s.*,
        GREATEST(COALESCE(s.missed_sessions, 0), COALESCE((SELECT COUNT(*) FROM sessions WHERE student_id = s.id AND status IN ('Missed', 'Excused', 'Unexcused')), 0)) as missed_sessions
      FROM students s
      WHERE s.parent_email = $1 AND s.is_active = true
    `, [req.body.email])).rows;
    res.json({ students: s });
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

app.post('/api/parent/send-otp', async (req, res) => {
  try {
    const students = (await pool.query('SELECT * FROM students WHERE parent_email = $1 AND is_active = true', [req.body.email])).rows;
    if (students.length === 0) return res.status(404).json({ error: 'No student found' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const exp = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(`INSERT INTO parent_credentials (parent_email, otp, otp_expiry, otp_attempts) VALUES ($1, $2, $3, 0) ON CONFLICT(parent_email) DO UPDATE SET otp = $2, otp_expiry = $3, otp_attempts = 0`, [req.body.email, otp, exp]);

    // Send OTP via email
    const parentName = students[0].parent_name || 'Parent';
    const otpEmailHTML = getOTPEmail({ parentName, otp });
    const emailSent = await sendEmail(
      req.body.email,
      `🔐 Your OTP for Fluent Feathers Academy Login`,
      otpEmailHTML,
      parentName,
      'OTP'
    );

    if (emailSent) {
      res.json({ success: true, message: 'OTP sent to your email!' });
    } else {
      res.json({ success: true, message: 'OTP generated. Check your email.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/parent/verify-otp', async (req, res) => {
  try {
    const c = (await pool.query('SELECT otp, otp_expiry FROM parent_credentials WHERE parent_email = $1', [req.body.email])).rows[0];
    if(!c || c.otp !== req.body.otp || new Date() > new Date(c.otp_expiry)) {
      return res.status(401).json({ error: 'Invalid or Expired OTP' });
    }
    const s = (await pool.query(`
      SELECT s.*,
        GREATEST(COALESCE(s.missed_sessions, 0), COALESCE((SELECT COUNT(*) FROM sessions WHERE student_id = s.id AND status IN ('Missed', 'Excused', 'Unexcused')), 0)) as missed_sessions
      FROM students s
      WHERE s.parent_email = $1 AND s.is_active = true
    `, [req.body.email])).rows;
    await pool.query('UPDATE parent_credentials SET otp = NULL, otp_expiry = NULL, otp_attempts = 0 WHERE parent_email = $1', [req.body.email]);
    res.json({ students: s });
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

// Verify OTP for password reset (doesn't log in, just verifies)
app.post('/api/parent/verify-reset-otp', async (req, res) => {
  try {
    const c = (await pool.query('SELECT otp, otp_expiry FROM parent_credentials WHERE parent_email = $1', [req.body.email])).rows[0];
    if (!c) return res.status(404).json({ error: 'Email not found' });
    if (c.otp !== req.body.otp) return res.status(400).json({ error: 'Invalid OTP' });
    if (new Date() > new Date(c.otp_expiry)) return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
    res.json({ success: true, message: 'OTP verified. You can now set a new password.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset password after OTP verification
app.post('/api/parent/reset-password', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(`
      UPDATE parent_credentials SET password = $1, otp = NULL, otp_expiry = NULL
      WHERE parent_email = $2
    `, [hashedPassword, email]);
    res.json({ success: true, message: 'Password reset successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PAYMENT RENEWALS ====================
app.post('/api/students/:id/renewal', async (req, res) => {
  const { amount, currency, sessions_added, payment_method, notes, send_email } = req.body;
  try {
    await pool.query(`
      INSERT INTO payment_renewals (student_id, renewal_date, amount, currency, sessions_added, payment_method, notes)
      VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)
    `, [req.params.id, amount, currency, sessions_added, payment_method, notes]);

    await pool.query(`
      UPDATE students SET
        total_sessions = total_sessions + $1,
        remaining_sessions = remaining_sessions + $1,
        fees_paid = fees_paid + $2,
        renewal_reminder_sent = false
      WHERE id = $3
    `, [sessions_added, amount, req.params.id]);

    // Send renewal confirmation email if requested
    if (send_email) {
      const student = await pool.query('SELECT name, parent_name, parent_email FROM students WHERE id = $1', [req.params.id]);
      if (student.rows[0]) {
        const emailHTML = getPaymentConfirmationEmail({
          parentName: student.rows[0].parent_name,
          studentName: student.rows[0].name,
          amount: amount,
          currency: currency,
          paymentType: 'Renewal',
          sessionsAdded: sessions_added,
          paymentMethod: payment_method,
          receiptNumber: null
        });
        await sendEmail(
          student.rows[0].parent_email,
          `✅ Renewal Confirmation - Fluent Feathers Academy`,
          emailHTML,
          student.rows[0].parent_name,
          'Renewal Confirmation'
        );
      }
    }

    res.json({ success: true, message: 'Renewal added successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/:id/renewals', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM payment_renewals WHERE student_id = $1 ORDER BY renewal_date DESC', [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/:id/payments', async (req, res) => {
  try {
    const payments = await pool.query('SELECT * FROM payment_history WHERE student_id = $1 ORDER BY payment_date DESC', [req.params.id]);
    const renewals = await pool.query('SELECT * FROM payment_renewals WHERE student_id = $1 ORDER BY renewal_date DESC', [req.params.id]);
    res.json({ payments: payments.rows, renewals: renewals.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update payment details (for corrections)
app.post('/api/students/:id/update-payment', async (req, res) => {
  const { fees_paid, currency, total_sessions, reason } = req.body;
  const studentId = req.params.id;

  try {
    // Get current student data
    const studentResult = await pool.query('SELECT * FROM students WHERE id = $1', [studentId]);
    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const student = studentResult.rows[0];

    // Calculate remaining sessions
    const completedSessions = student.completed_sessions || 0;
    const newRemaining = Math.max(0, total_sessions - completedSessions);

    // Update student payment info
    await pool.query(`
      UPDATE students SET
        fees_paid = $1,
        currency = $2,
        total_sessions = $3,
        remaining_sessions = $4
      WHERE id = $5
    `, [fees_paid, currency, total_sessions, newRemaining, studentId]);

    // Add entry to payment_history
    await pool.query(`
      INSERT INTO payment_history (student_id, payment_date, amount, currency, payment_method, sessions_covered, notes, payment_status)
      VALUES ($1, CURRENT_TIMESTAMP, $2, $3, 'Bank Transfer', $4, $5, 'completed')
    `, [studentId, fees_paid, currency, total_sessions, reason || '']);

    console.log(`Payment updated for student ${studentId}: ${currency} ${fees_paid}, Sessions: ${total_sessions}, Reason: ${reason || 'No reason provided'}`);

    res.json({ success: true, message: 'Payment updated successfully!' });
  } catch (err) {
    console.error('Error updating payment:', err);
    res.status(500).json({ error: err.message });
  }
});

// Fix session counts (for attendance correction)
app.post('/api/students/:id/fix-sessions', async (req, res) => {
  const { total_sessions, completed_sessions, missed_sessions, remaining_sessions, reason } = req.body;
  const studentId = req.params.id;

  try {
    // Get current student data for logging
    const studentResult = await pool.query('SELECT name, total_sessions, completed_sessions, missed_sessions, remaining_sessions FROM students WHERE id = $1', [studentId]);
    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const oldData = studentResult.rows[0];

    // Update session counts including missed_sessions
    await pool.query(`
      UPDATE students SET
        total_sessions = $1,
        completed_sessions = $2,
        missed_sessions = $3,
        remaining_sessions = $4
      WHERE id = $5
    `, [total_sessions, completed_sessions, missed_sessions || 0, remaining_sessions, studentId]);

    console.log(`⚠️ SESSION FIX for ${oldData.name} (ID: ${studentId})`);
    console.log(`   Old: Total=${oldData.total_sessions}, Completed=${oldData.completed_sessions}, Missed=${oldData.missed_sessions || 0}, Remaining=${oldData.remaining_sessions}`);
    console.log(`   New: Total=${total_sessions}, Completed=${completed_sessions}, Missed=${missed_sessions || 0}, Remaining=${remaining_sessions}`);
    console.log(`   Reason: ${reason || 'No reason provided'}`);

    res.json({ success: true, message: 'Session counts updated successfully!' });
  } catch (err) {
    console.error('Error fixing sessions:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== FINANCIAL REPORTS & EXPENSE TRACKER ====================

// Get financial summary (income from payments)
app.get('/api/financial-reports', async (req, res) => {
  try {
    const { startDate, endDate, year } = req.query;

    let dateFilter = '';
    let params = [];

    if (startDate && endDate) {
      dateFilter = 'WHERE payment_date >= $1 AND payment_date <= $2';
      params = [startDate, endDate];
    } else if (year) {
      // Indian Financial Year: April 1 to March 31
      const fyStart = `${year}-04-01`;
      const fyEnd = `${parseInt(year) + 1}-03-31`;
      dateFilter = 'WHERE payment_date >= $1 AND payment_date <= $2';
      params = [fyStart, fyEnd];
    }

    // Get all payments
    const paymentsQuery = `
      SELECT ph.*, s.name as student_name, s.parent_name
      FROM payment_history ph
      LEFT JOIN students s ON ph.student_id = s.id
      ${dateFilter}
      ORDER BY ph.payment_date DESC
    `;
    const payments = await pool.query(paymentsQuery, params);

    // Get monthly summary
    const monthlyQuery = `
      SELECT
        EXTRACT(YEAR FROM payment_date) as year,
        EXTRACT(MONTH FROM payment_date) as month,
        currency,
        SUM(amount) as total_amount,
        COUNT(*) as payment_count
      FROM payment_history
      ${dateFilter}
      GROUP BY EXTRACT(YEAR FROM payment_date), EXTRACT(MONTH FROM payment_date), currency
      ORDER BY year DESC, month DESC
    `;
    const monthlySummary = await pool.query(monthlyQuery, params);

    // Get total by currency
    const totalQuery = `
      SELECT currency, SUM(amount) as total_amount, COUNT(*) as payment_count
      FROM payment_history
      ${dateFilter}
      GROUP BY currency
    `;
    const totals = await pool.query(totalQuery, params);

    // Get session stats
    const sessionStats = await pool.query(`
      SELECT COUNT(*) as total_sessions,
             COUNT(CASE WHEN status = 'Completed' THEN 1 END) as completed_sessions
      FROM sessions
    `);

    // Get active students count
    const studentCount = await pool.query(`SELECT COUNT(*) as count FROM students WHERE is_active = true`);

    res.json({
      payments: payments.rows,
      monthlySummary: monthlySummary.rows,
      totals: totals.rows,
      sessionStats: sessionStats.rows[0],
      activeStudents: parseInt(studentCount.rows[0].count)
    });
  } catch (err) {
    console.error('Error fetching financial reports:', err);
    res.status(500).json({ error: err.message });
  }
});

// Export financial report as CSV
app.get('/api/financial-reports/export', async (req, res) => {
  try {
    const { startDate, endDate, year } = req.query;

    let dateFilter = '';
    let params = [];

    if (startDate && endDate) {
      dateFilter = 'WHERE ph.payment_date >= $1 AND ph.payment_date <= $2';
      params = [startDate, endDate];
    } else if (year) {
      const fyStart = `${year}-04-01`;
      const fyEnd = `${parseInt(year) + 1}-03-31`;
      dateFilter = 'WHERE ph.payment_date >= $1 AND ph.payment_date <= $2';
      params = [fyStart, fyEnd];
    }

    const query = `
      SELECT
        ph.payment_date,
        s.name as student_name,
        s.parent_name,
        ph.amount,
        ph.currency,
        ph.payment_method,
        ph.sessions_covered,
        ph.notes
      FROM payment_history ph
      LEFT JOIN students s ON ph.student_id = s.id
      ${dateFilter}
      ORDER BY ph.payment_date DESC
    `;
    const result = await pool.query(query, params);

    // Create CSV content
    let csv = 'Date,Student Name,Parent Name,Amount,Currency,Payment Method,Sessions,Notes\n';
    result.rows.forEach(row => {
      const date = new Date(row.payment_date).toLocaleDateString('en-IN');
      csv += `"${date}","${row.student_name || ''}","${row.parent_name || ''}","${row.amount}","${row.currency}","${row.payment_method || ''}","${row.sessions_covered || ''}","${(row.notes || '').replace(/"/g, '""')}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=income_report_${new Date().toISOString().split('T')[0]}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('Error exporting financial report:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all expenses
app.get('/api/expenses', async (req, res) => {
  try {
    const { startDate, endDate, year, category } = req.query;

    let whereClause = [];
    let params = [];
    let paramIndex = 1;

    if (startDate && endDate) {
      whereClause.push(`expense_date >= $${paramIndex} AND expense_date <= $${paramIndex + 1}`);
      params.push(startDate, endDate);
      paramIndex += 2;
    } else if (year) {
      const fyStart = `${year}-04-01`;
      const fyEnd = `${parseInt(year) + 1}-03-31`;
      whereClause.push(`expense_date >= $${paramIndex} AND expense_date <= $${paramIndex + 1}`);
      params.push(fyStart, fyEnd);
      paramIndex += 2;
    }

    if (category) {
      whereClause.push(`category = $${paramIndex}`);
      params.push(category);
      paramIndex++;
    }

    const whereSQL = whereClause.length > 0 ? 'WHERE ' + whereClause.join(' AND ') : '';

    const expenses = await pool.query(`
      SELECT * FROM expenses ${whereSQL} ORDER BY expense_date DESC
    `, params);

    // Get totals by category
    const categoryTotals = await pool.query(`
      SELECT category, currency, SUM(amount) as total_amount, COUNT(*) as count
      FROM expenses ${whereSQL}
      GROUP BY category, currency
      ORDER BY category
    `, params);

    // Get grand total
    const grandTotal = await pool.query(`
      SELECT currency, SUM(amount) as total_amount
      FROM expenses ${whereSQL}
      GROUP BY currency
    `, params);

    res.json({
      expenses: expenses.rows,
      categoryTotals: categoryTotals.rows,
      grandTotal: grandTotal.rows
    });
  } catch (err) {
    console.error('Error fetching expenses:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add new expense
app.post('/api/expenses', async (req, res) => {
  try {
    const { expense_date, category, description, amount, currency, payment_method, receipt_url, notes } = req.body;

    const result = await pool.query(`
      INSERT INTO expenses (expense_date, category, description, amount, currency, payment_method, receipt_url, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [expense_date, category, description, amount, currency || 'INR', payment_method, receipt_url, notes]);

    res.json({ success: true, expense: result.rows[0] });
  } catch (err) {
    console.error('Error adding expense:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update expense
app.put('/api/expenses/:id', async (req, res) => {
  try {
    const { expense_date, category, description, amount, currency, payment_method, receipt_url, notes } = req.body;

    await pool.query(`
      UPDATE expenses SET
        expense_date = $1, category = $2, description = $3, amount = $4,
        currency = $5, payment_method = $6, receipt_url = $7, notes = $8
      WHERE id = $9
    `, [expense_date, category, description, amount, currency, payment_method, receipt_url, notes, req.params.id]);

    res.json({ success: true, message: 'Expense updated' });
  } catch (err) {
    console.error('Error updating expense:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete expense
app.delete('/api/expenses/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Expense deleted' });
  } catch (err) {
    console.error('Error deleting expense:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete payment from history (for removing test/trial payments)
app.delete('/api/payment-history/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM payment_history WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Payment deleted from history' });
  } catch (err) {
    console.error('Error deleting payment:', err);
    res.status(500).json({ error: err.message });
  }
});

// Export expenses as CSV
app.get('/api/expenses/export', async (req, res) => {
  try {
    const { startDate, endDate, year } = req.query;

    let whereClause = [];
    let params = [];

    if (startDate && endDate) {
      whereClause.push(`expense_date >= $1 AND expense_date <= $2`);
      params = [startDate, endDate];
    } else if (year) {
      const fyStart = `${year}-04-01`;
      const fyEnd = `${parseInt(year) + 1}-03-31`;
      whereClause.push(`expense_date >= $1 AND expense_date <= $2`);
      params = [fyStart, fyEnd];
    }

    const whereSQL = whereClause.length > 0 ? 'WHERE ' + whereClause.join(' AND ') : '';

    const result = await pool.query(`SELECT * FROM expenses ${whereSQL} ORDER BY expense_date DESC`, params);

    let csv = 'Date,Category,Description,Amount,Currency,Payment Method,Notes\n';
    result.rows.forEach(row => {
      const date = new Date(row.expense_date).toLocaleDateString('en-IN');
      csv += `"${date}","${row.category}","${(row.description || '').replace(/"/g, '""')}","${row.amount}","${row.currency}","${row.payment_method || ''}","${(row.notes || '').replace(/"/g, '""')}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=expenses_report_${new Date().toISOString().split('T')[0]}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('Error exporting expenses:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get profit/loss summary
app.get('/api/financial-reports/summary', async (req, res) => {
  try {
    const { year } = req.query;
    const currentYear = year || new Date().getFullYear();

    const fyStart = `${currentYear}-04-01`;
    const fyEnd = `${parseInt(currentYear) + 1}-03-31`;

    // Get total income
    const incomeResult = await pool.query(`
      SELECT currency, SUM(amount) as total
      FROM payment_history
      WHERE payment_date >= $1 AND payment_date <= $2
      GROUP BY currency
    `, [fyStart, fyEnd]);

    // Get total expenses
    const expenseResult = await pool.query(`
      SELECT currency, SUM(amount) as total
      FROM expenses
      WHERE expense_date >= $1 AND expense_date <= $2
      GROUP BY currency
    `, [fyStart, fyEnd]);

    res.json({
      financialYear: `${currentYear}-${parseInt(currentYear) + 1}`,
      income: incomeResult.rows,
      expenses: expenseResult.rows
    });
  } catch (err) {
    console.error('Error fetching summary:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== CLEANUP ORPHANED DATA ====================

// Clean up orphaned sessions (sessions where student no longer exists)
app.delete('/api/cleanup/orphaned-sessions', async (req, res) => {
  try {
    // Find ALL sessions where student_id doesn't exist in students table
    const orphanedSessions = await pool.query(`
      SELECT s.id FROM sessions s
      LEFT JOIN students st ON s.student_id = st.id
      WHERE s.student_id IS NOT NULL AND st.id IS NULL
    `);

    // Delete session_materials for orphaned sessions
    for (const session of orphanedSessions.rows) {
      await pool.query('DELETE FROM session_materials WHERE session_id = $1', [session.id]);
    }

    // Delete orphaned sessions (any session where student doesn't exist)
    const result = await pool.query(`
      DELETE FROM sessions s
      WHERE s.student_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM students st WHERE st.id = s.student_id)
      RETURNING id
    `);

    console.log(`🧹 Cleaned up ${result.rowCount} orphaned sessions`);
    res.json({
      success: true,
      message: `Cleaned up ${result.rowCount} orphaned sessions`,
      deletedCount: result.rowCount
    });
  } catch (err) {
    console.error('Error cleaning orphaned sessions:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get count of orphaned data
app.get('/api/cleanup/orphaned-count', async (req, res) => {
  try {
    const orphanedSessions = await pool.query(`
      SELECT COUNT(*) as count FROM sessions s
      LEFT JOIN students st ON s.student_id = st.id
      WHERE s.student_id IS NOT NULL AND st.id IS NULL
    `);

    res.json({
      orphanedSessions: parseInt(orphanedSessions.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== EDIT & DELETE STUDENT ====================
app.put('/api/students/:id', async (req, res) => {
  const { name, grade, parent_name, parent_email, primary_contact, timezone, program_name, duration, per_session_fee, currency, date_of_birth, meet_link } = req.body;
  try {
    await pool.query(`
      UPDATE students SET
        name = $1, grade = $2, parent_name = $3, parent_email = $4,
        primary_contact = $5, timezone = $6, program_name = $7,
        duration = $8, per_session_fee = $9, currency = $10,
        date_of_birth = $11, meet_link = $12
      WHERE id = $13
    `, [name, grade, parent_name, parent_email, primary_contact, timezone, program_name, duration, per_session_fee, currency, date_of_birth || null, meet_link || null, req.params.id]);
    res.json({ success: true, message: 'Student updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/:id/full', async (req, res) => {
  try {
    const student = await pool.query('SELECT * FROM students WHERE id = $1', [req.params.id]);
    if (student.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    res.json(student.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Parent profile update (limited fields for parent self-edit)
app.put('/api/students/:id/profile', async (req, res) => {
  const { parent_name, parent_email, primary_contact, alternate_contact, date_of_birth } = req.body;
  try {
    await pool.query(`
      UPDATE students SET
        parent_name = $1, parent_email = $2, primary_contact = $3,
        alternate_contact = $4, date_of_birth = $5
      WHERE id = $6
    `, [parent_name, parent_email, primary_contact, alternate_contact || null, date_of_birth || null, req.params.id]);
    res.json({ success: true, message: 'Profile updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== EDIT & DELETE GROUP ====================
app.put('/api/groups/:id', async (req, res) => {
  const { group_name, program_name, duration, timezone, max_students } = req.body;
  try {
    await pool.query(`
      UPDATE groups SET
        group_name = $1, program_name = $2, duration = $3, timezone = $4, max_students = $5
      WHERE id = $6
    `, [group_name, program_name, duration, timezone, max_students, req.params.id]);
    res.json({ success: true, message: 'Group updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/groups/:id/full', async (req, res) => {
  try {
    const group = await pool.query('SELECT * FROM groups WHERE id = $1', [req.params.id]);
    if (group.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
    res.json(group.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== CLASS FEEDBACK ====================
app.post('/api/sessions/:sessionId/feedback', async (req, res) => {
  const { student_id, rating, feedback_text } = req.body;
  try {
    // Check if feedback already exists
    const existing = await pool.query(
      'SELECT id FROM class_feedback WHERE session_id = $1 AND student_id = $2',
      [req.params.sessionId, student_id]
    );

    if (existing.rows.length > 0) {
      // Update existing feedback
      await pool.query(
        'UPDATE class_feedback SET rating = $1, feedback_text = $2 WHERE session_id = $3 AND student_id = $4',
        [rating, feedback_text, req.params.sessionId, student_id]
      );
    } else {
      // Insert new feedback
      await pool.query(
        'INSERT INTO class_feedback (session_id, student_id, rating, feedback_text) VALUES ($1, $2, $3, $4)',
        [req.params.sessionId, student_id, rating, feedback_text]
      );
    }

    await awardBadge(student_id, 'feedback', '⭐ Feedback Star', 'Shared valuable feedback');

    res.json({ success: true, message: 'Thank you for your feedback!' });
  } catch (err) {
    console.error('Feedback error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:sessionId/feedbacks', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cf.*, s.name as student_name
      FROM class_feedback cf
      JOIN students s ON cf.student_id = s.id
      WHERE cf.session_id = $1
      ORDER BY cf.created_at DESC
    `, [req.params.sessionId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:sessionId/has-feedback/:studentId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id FROM class_feedback WHERE session_id = $1 AND student_id = $2',
      [req.params.sessionId, req.params.studentId]
    );
    res.json({ hasFeedback: result.rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== BADGES SYSTEM ====================
async function awardBadge(studentId, badgeType, badgeName, badgeDescription) {
  try {
    const existing = await pool.query(
      'SELECT id FROM student_badges WHERE student_id = $1 AND badge_type = $2',
      [studentId, badgeType]
    );

    if (existing.rows.length === 0) {
      await pool.query(`
        INSERT INTO student_badges (student_id, badge_type, badge_name, badge_description)
        VALUES ($1, $2, $3, $4)
      `, [studentId, badgeType, badgeName, badgeDescription]);
      return true;
    }
    return false;
  } catch (err) {
    console.error('Badge award error:', err);
    return false;
  }
}

app.get('/api/students/:id/badges', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM student_badges WHERE student_id = $1 ORDER BY earned_date DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students/:id/badges', async (req, res) => {
  const { badge_type, badge_name, badge_description } = req.body;
  try {
    await pool.query(`
      INSERT INTO student_badges (student_id, badge_type, badge_name, badge_description)
      VALUES ($1, $2, $3, $4)
    `, [req.params.id, badge_type, badge_name, badge_description]);
    res.json({ success: true, message: 'Badge awarded!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual badge assignment by admin (allows duplicates for class achievements)
app.post('/api/students/:id/badges/assign', async (req, res) => {
  const { badge_type, badge_name, badge_description } = req.body;
  try {
    await pool.query(`
      INSERT INTO student_badges (student_id, badge_type, badge_name, badge_description)
      VALUES ($1, $2, $3, $4)
    `, [req.params.id, badge_type, badge_name, badge_description]);
    res.json({ success: true, message: 'Badge assigned successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leaderboard - Get all students ranked by badges
app.get('/api/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        s.id,
        s.name,
        s.program_name,
        COUNT(b.id) as total_badges,
        COUNT(CASE WHEN b.badge_type NOT IN ('first_class', '5_classes', '10_classes', '25_classes', '50_classes', 'hw_submit', '5_homework', '10_homework', '25_homework') THEN 1 END) as manual_badges,
        COUNT(CASE WHEN b.badge_type IN ('first_class', '5_classes', '10_classes', '25_classes', '50_classes', 'hw_submit', '5_homework', '10_homework', '25_homework') THEN 1 END) as auto_badges,
        (SELECT badge_name FROM student_badges WHERE student_id = s.id ORDER BY earned_date DESC LIMIT 1) as latest_badge
      FROM students s
      LEFT JOIN student_badges b ON s.id = b.student_id
      WHERE s.is_active = true
      GROUP BY s.id, s.name, s.program_name
      HAVING COUNT(b.id) > 0
      ORDER BY total_badges DESC, manual_badges DESC, s.name ASC
    `);
    res.json({ leaderboard: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sync badges for all students based on their completed sessions (run once to fix missing badges)
app.post('/api/badges/sync-all', async (req, res) => {
  try {
    const students = await pool.query('SELECT id, completed_sessions FROM students WHERE is_active = true');
    let awarded = 0;

    for (const student of students.rows) {
      const count = student.completed_sessions || 0;

      if (count >= 1) {
        const result = await awardBadge(student.id, 'first_class', '🌟 First Class Star', 'Attended first class!');
        if (result) awarded++;
      }
      if (count >= 5) {
        const result = await awardBadge(student.id, '5_classes', '🏆 5 Classes Champion', 'Completed 5 classes!');
        if (result) awarded++;
      }
      if (count >= 10) {
        const result = await awardBadge(student.id, '10_classes', '👑 10 Classes Master', 'Completed 10 classes!');
        if (result) awarded++;
      }
      if (count >= 25) {
        const result = await awardBadge(student.id, '25_classes', '🎖️ 25 Classes Legend', 'Completed 25 classes!');
        if (result) awarded++;
      }
      if (count >= 50) {
        const result = await awardBadge(student.id, '50_classes', '💎 50 Classes Diamond', 'Amazing milestone!');
        if (result) awarded++;
      }
    }

    res.json({ success: true, message: `Synced badges! ${awarded} new badges awarded.` });
  } catch (err) {
    console.error('Badge sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/badges/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM student_badges WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== CLASS FEEDBACK/RATINGS ====================
app.get('/api/class-feedback/all', async (req, res) => {
  try {
    const { student_id, rating } = req.query;

    let query = `
      SELECT cf.*, s.session_number, st.name as student_name
      FROM class_feedback cf
      LEFT JOIN sessions s ON cf.session_id = s.id
      LEFT JOIN students st ON cf.student_id = st.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (student_id) {
      query += ` AND cf.student_id = $${paramIndex}`;
      params.push(student_id);
      paramIndex++;
    }
    if (rating) {
      query += ` AND cf.rating = $${paramIndex}`;
      params.push(rating);
      paramIndex++;
    }

    query += ` ORDER BY cf.created_at DESC`;

    const feedbacks = await pool.query(query, params);

    // Get stats
    const statsQuery = await pool.query(`
      SELECT
        COUNT(*) as total,
        AVG(rating) as avg_rating,
        COUNT(CASE WHEN rating = 5 THEN 1 END) as five_star_count
      FROM class_feedback
    `);

    // Get all students for filter dropdown
    const students = await pool.query('SELECT id, name FROM students WHERE is_active = true ORDER BY name');

    res.json({
      feedbacks: feedbacks.rows,
      total: parseInt(statsQuery.rows[0].total) || 0,
      avgRating: parseFloat(statsQuery.rows[0].avg_rating) || 0,
      fiveStarCount: parseInt(statsQuery.rows[0].five_star_count) || 0,
      students: students.rows
    });
  } catch (err) {
    console.error('Error loading class feedback:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== HOMEWORK GRADING ====================
app.post('/api/materials/:id/grade', async (req, res) => {
  const { grade, comments } = req.body;
  try {
    await pool.query(`
      UPDATE materials SET
        feedback_grade = $1,
        feedback_comments = $2,
        feedback_given = 1,
        feedback_date = CURRENT_TIMESTAMP
      WHERE id = $3
    `, [grade, comments, req.params.id]);

    // Get material details with student info for email
    const materialResult = await pool.query(`
      SELECT m.*, s.session_number, st.name as student_name, st.parent_email, st.parent_name
      FROM materials m
      LEFT JOIN sessions s ON m.session_id = s.id
      LEFT JOIN students st ON m.student_id = st.id
      WHERE m.id = $1
    `, [req.params.id]);

    if (materialResult.rows[0]) {
      const material = materialResult.rows[0];

      // Award badge
      await awardBadge(material.student_id, 'graded_hw', '📚 Homework Hero', 'Received homework feedback');

      // Send email notification to parent
      if (material.parent_email) {
        try {
          const feedbackEmailHTML = getHomeworkFeedbackEmail({
            studentName: material.student_name,
            sessionNumber: material.session_number || 'N/A',
            grade: grade,
            comments: comments,
            fileName: material.file_name
          });

          await sendEmail(
            material.parent_email,
            `📝 Homework Feedback - ${material.student_name}'s Session #${material.session_number || 'N/A'}`,
            feedbackEmailHTML,
            material.parent_name,
            'Homework-Feedback'
          );
          console.log(`✅ Sent homework feedback email to ${material.parent_email} for ${material.student_name}`);
        } catch (emailErr) {
          console.error('Error sending homework feedback email:', emailErr);
          // Don't fail the request if email fails
        }
      }
    }

    res.json({ success: true, message: 'Homework graded successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/:id/homework', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, s.session_number
      FROM materials m
      LEFT JOIN sessions s ON m.session_id = s.id
      WHERE m.student_id = $1 AND m.file_type = 'Homework'
      ORDER BY m.uploaded_at DESC
    `, [req.params.id]);

    // Ensure file paths have correct prefix for backwards compatibility
    const rows = result.rows.map(row => {
      // Skip if already has correct prefix, is a link, or is a Cloudinary/external URL
      if (row.file_path && !row.file_path.startsWith('/uploads/') && !row.file_path.startsWith('LINK:') && !row.file_path.startsWith('https://') && !row.file_path.startsWith('http://')) {
        row.file_path = '/uploads/homework/' + row.file_path;
      }
      return row;
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all homework submissions (for admin panel)
app.get('/api/homework/all', async (req, res) => {
  try {
    const studentId = req.query.student_id;
    let query = `
      SELECT m.*, s.session_number, st.name as student_name
      FROM materials m
      LEFT JOIN sessions s ON m.session_id = s.id
      LEFT JOIN students st ON m.student_id = st.id
      WHERE m.file_type = 'Homework' AND m.uploaded_by = 'Parent'
    `;

    const params = [];
    if (studentId) {
      query += ` AND m.student_id = $1`;
      params.push(studentId);
    }

    query += ` ORDER BY m.uploaded_at DESC`;

    const result = await pool.query(query, params);

    // Ensure file paths have correct prefix for backwards compatibility
    const rows = result.rows.map(row => {
      // Skip if already has correct prefix, is a link, or is a Cloudinary/external URL
      if (row.file_path && !row.file_path.startsWith('/uploads/') && !row.file_path.startsWith('LINK:') && !row.file_path.startsWith('https://') && !row.file_path.startsWith('http://')) {
        row.file_path = '/uploads/homework/' + row.file_path;
      }
      return row;
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete homework submission
app.delete('/api/homework/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get the file path before deleting (for Cloudinary cleanup if needed)
    const existing = await pool.query('SELECT file_path FROM materials WHERE id = $1', [id]);

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Homework not found' });
    }

    // Delete from database
    await pool.query('DELETE FROM materials WHERE id = $1', [id]);

    // If using Cloudinary and file was uploaded there, we could delete from Cloudinary too
    // For now just delete from DB - Cloudinary files can be cleaned up manually if needed

    res.json({ message: 'Homework deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== WEEKLY CHALLENGES API ====================
// Get all challenges (admin)
app.get('/api/challenges', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM student_challenges sc WHERE sc.challenge_id = c.id) as assigned_count,
        (SELECT COUNT(*) FROM student_challenges sc WHERE sc.challenge_id = c.id AND sc.status = 'Completed') as completed_count,
        (SELECT COUNT(*) FROM student_challenges sc WHERE sc.challenge_id = c.id AND sc.status = 'Submitted') as submitted_count
      FROM weekly_challenges c
      ORDER BY c.week_start DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new challenge
app.post('/api/challenges', async (req, res) => {
  const { title, description, challenge_type, badge_reward, week_start, week_end, assign_to_all } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO weekly_challenges (title, description, challenge_type, badge_reward, week_start, week_end)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [title, description, challenge_type || 'General', badge_reward || '🎯 Challenge Champion', week_start, week_end]);

    const challenge = result.rows[0];

    // If assign_to_all, create student_challenges for all active students
    if (assign_to_all) {
      const students = await pool.query('SELECT id FROM students WHERE is_active = true');
      for (const student of students.rows) {
        await pool.query(`
          INSERT INTO student_challenges (student_id, challenge_id, status)
          VALUES ($1, $2, 'Assigned')
        `, [student.id, challenge.id]);
      }
    }

    res.json({ success: true, challenge });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assign challenge to specific students
app.post('/api/challenges/:id/assign', async (req, res) => {
  const { student_ids } = req.body;
  try {
    for (const studentId of student_ids) {
      await pool.query(`
        INSERT INTO student_challenges (student_id, challenge_id, status)
        VALUES ($1, $2, 'Assigned')
        ON CONFLICT DO NOTHING
      `, [studentId, req.params.id]);
    }
    res.json({ success: true, message: 'Challenge assigned' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get students assigned to a specific challenge (for tracking)
app.get('/api/challenges/:id/students', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sc.*, s.name as student_name, s.program_name
      FROM student_challenges sc
      JOIN students s ON sc.student_id = s.id
      WHERE sc.challenge_id = $1
      ORDER BY sc.status DESC, s.name
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Parent submits challenge as done (awaiting teacher approval)
app.put('/api/challenges/:challengeId/student/:studentId/submit', async (req, res) => {
  try {
    await pool.query(`
      UPDATE student_challenges
      SET status = 'Submitted', notes = 'Submitted by parent on ' || CURRENT_DATE
      WHERE challenge_id = $1 AND student_id = $2
    `, [req.params.challengeId, req.params.studentId]);

    res.json({ success: true, message: 'Challenge submitted for review!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark student challenge as completed (teacher approval)
app.put('/api/challenges/:challengeId/student/:studentId/complete', async (req, res) => {
  const { badge_reward } = req.body;
  try {
    await pool.query(`
      UPDATE student_challenges
      SET status = 'Completed', completed_at = CURRENT_TIMESTAMP
      WHERE challenge_id = $1 AND student_id = $2
    `, [req.params.challengeId, req.params.studentId]);

    // Award badge for completing challenge
    const challenge = await pool.query('SELECT * FROM weekly_challenges WHERE id = $1', [req.params.challengeId]);
    if (challenge.rows.length > 0) {
      const badgeName = badge_reward || challenge.rows[0].badge_reward || '🎯 Challenge Champion';
      await pool.query(`
        INSERT INTO student_badges (student_id, badge_type, badge_name, badge_description)
        VALUES ($1, $2, $3, $4)
      `, [req.params.studentId, 'challenge_' + req.params.challengeId, badgeName, 'Completed: ' + challenge.rows[0].title]);
    }

    res.json({ success: true, message: 'Challenge completed!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get challenges for a student (parent portal)
app.get('/api/students/:id/challenges', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, sc.status, sc.completed_at, sc.notes as completion_notes
      FROM weekly_challenges c
      JOIN student_challenges sc ON c.id = sc.challenge_id
      WHERE sc.student_id = $1 AND c.is_active = true
      ORDER BY c.week_start DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete challenge
app.delete('/api/challenges/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM weekly_challenges WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Challenge deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PARENT EXPECTATIONS API ====================
// Get student expectations
app.get('/api/students/:id/expectations', async (req, res) => {
  try {
    const result = await pool.query('SELECT parent_expectations FROM students WHERE id = $1', [req.params.id]);
    res.json({ expectations: result.rows[0]?.parent_expectations || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update student expectations (parent or admin)
app.put('/api/students/:id/expectations', async (req, res) => {
  const { expectations } = req.body;
  try {
    await pool.query('UPDATE students SET parent_expectations = $1 WHERE id = $2', [expectations, req.params.id]);
    res.json({ success: true, message: 'Expectations updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== ANNOUNCEMENTS API ====================
app.get('/api/announcements', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM announcements WHERE is_active = true ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/announcements', upload.single('image'), async (req, res) => {
  const { title, content, announcement_type, priority, send_email } = req.body;
  try {
    let imageUrl = null;

    // Handle image upload if present
    if (req.file) {
      // When using CloudinaryStorage, file is already uploaded and path contains the URL
      if (req.file.path) {
        imageUrl = req.file.path;
      } else if (req.file.buffer) {
        // Fallback for memory storage - upload to Cloudinary manually
        if (cloudinary) {
          const result = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream(
              { folder: 'fluentfeathers/announcements', resource_type: 'image' },
              (error, result) => {
                if (error) reject(error);
                else resolve(result);
              }
            ).end(req.file.buffer);
          });
          imageUrl = result.secure_url;
        } else {
          // Save locally
          const fileName = Date.now() + '-' + req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
          const filePath = path.join(__dirname, 'public/uploads/announcements', fileName);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, req.file.buffer);
          imageUrl = '/uploads/announcements/' + fileName;
        }
      }
    }

    const result = await pool.query(`
      INSERT INTO announcements (title, content, announcement_type, priority, is_active, image_url)
      VALUES ($1, $2, $3, $4, true, $5)
      RETURNING *
    `, [title, content, announcement_type || 'General', priority || 'Normal', imageUrl]);

    const announcement = result.rows[0];
    let emailsSent = 0;

    // Send emails if requested
    if (send_email === 'true' || send_email === true) {
      const students = await pool.query(`
        SELECT DISTINCT parent_email, parent_name, name as student_name
        FROM students
        WHERE is_active = true AND parent_email IS NOT NULL
      `);

      for (const student of students.rows) {
        const emailHtml = getAnnouncementEmail({
          title,
          content,
          type: announcement_type || 'General',
          priority: priority || 'Normal',
          parentName: student.parent_name || 'Parent',
          imageUrl: imageUrl
        });

        const sent = await sendEmail(
          student.parent_email,
          `📢 ${title} - Fluent Feathers Academy`,
          emailHtml,
          student.parent_name,
          'Announcement'
        );
        if (sent) emailsSent++;
      }
    }

    res.json({
      ...announcement,
      message: (send_email === 'true' || send_email === true)
        ? `✅ Announcement created and ${emailsSent} email(s) sent!`
        : '✅ Announcement created!'
    });
  } catch (err) {
    console.error('Announcement error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Send announcement email to all active students
app.post('/api/announcements/:id/send-email', async (req, res) => {
  try {
    const announcement = await pool.query('SELECT * FROM announcements WHERE id = $1', [req.params.id]);
    if (announcement.rows.length === 0) {
      return res.status(404).json({ error: 'Announcement not found' });
    }

    const { title, content, announcement_type, priority } = announcement.rows[0];

    const students = await pool.query(`
      SELECT DISTINCT parent_email, parent_name, name as student_name
      FROM students
      WHERE is_active = true AND parent_email IS NOT NULL
    `);

    let emailsSent = 0;
    for (const student of students.rows) {
      const emailHtml = getAnnouncementEmail({
        title,
        content,
        type: announcement_type,
        priority,
        parentName: student.parent_name || 'Parent'
      });

      const sent = await sendEmail(
        student.parent_email,
        `📢 ${title} - Fluent Feathers Academy`,
        emailHtml,
        student.parent_name,
        'Announcement'
      );
      if (sent) emailsSent++;
    }

    res.json({ message: `✅ ${emailsSent} email(s) sent successfully!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/announcements/:id', upload.single('image'), async (req, res) => {
  const { title, content, announcement_type, priority, remove_image } = req.body;
  try {
    let imageUrl = undefined; // undefined means don't update

    // Handle image upload if present
    if (req.file) {
      // When using CloudinaryStorage, file is already uploaded and path contains the URL
      if (req.file.path) {
        imageUrl = req.file.path;
      } else if (req.file.buffer) {
        // Fallback for memory storage
        if (cloudinary) {
          const result = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream(
              { folder: 'fluentfeathers/announcements', resource_type: 'image' },
              (error, result) => {
                if (error) reject(error);
                else resolve(result);
              }
            ).end(req.file.buffer);
          });
          imageUrl = result.secure_url;
        } else {
          const fileName = Date.now() + '-' + req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
          const filePath = path.join(__dirname, 'public/uploads/announcements', fileName);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, req.file.buffer);
          imageUrl = '/uploads/announcements/' + fileName;
        }
      }
    } else if (remove_image === 'true') {
      imageUrl = null; // Remove existing image
    }

    let query, params;
    if (imageUrl !== undefined) {
      query = `UPDATE announcements SET title = $1, content = $2, announcement_type = $3, priority = $4, image_url = $5 WHERE id = $6 RETURNING *`;
      params = [title, content, announcement_type, priority, imageUrl, req.params.id];
    } else {
      query = `UPDATE announcements SET title = $1, content = $2, announcement_type = $3, priority = $4 WHERE id = $5 RETURNING *`;
      params = [title, content, announcement_type, priority, req.params.id];
    }

    const result = await pool.query(query, params);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update announcement error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/announcements/:id', async (req, res) => {
  try {
    await pool.query('UPDATE announcements SET is_active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== CERTIFICATES API ====================
app.get('/api/certificates', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, s.name as student_name, s.parent_email, s.parent_name
      FROM student_certificates c
      JOIN students s ON c.student_id = s.id
      ORDER BY c.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/:id/certificates', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM student_certificates
      WHERE student_id = $1
      ORDER BY year DESC, month DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/certificates', async (req, res) => {
  const { student_id, certificate_type, award_title, month, year, description, send_email } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO student_certificates (student_id, certificate_type, award_title, month, year, description)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [student_id, certificate_type, award_title, month, year, description]);

    // Send email if requested
    if (send_email) {
      const student = await pool.query('SELECT name, parent_email, parent_name FROM students WHERE id = $1', [student_id]);
      if (student.rows[0]) {
        const certificateEmailHTML = getCertificateEmail({
          studentName: student.rows[0].name,
          awardTitle: award_title,
          month: month,
          year: year,
          description: description
        });

        await sendEmail(
          student.rows[0].parent_email,
          `🏆 Certificate of Achievement - ${award_title}`,
          certificateEmailHTML,
          student.rows[0].parent_name,
          'Certificate'
        );
      }
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/certificates/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM student_certificates WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== MONTHLY ASSESSMENTS API ====================
app.get('/api/assessments', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*,
             s.name as student_name,
             d.child_name as demo_child_name,
             d.demo_date as demo_date,
             d.parent_email as demo_parent_email
      FROM monthly_assessments a
      LEFT JOIN students s ON a.student_id = s.id
      LEFT JOIN demo_leads d ON a.demo_lead_id = d.id
      ORDER BY a.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/assessments/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*,
             s.name as student_name,
             d.child_name as demo_child_name,
             d.demo_date as demo_date,
             d.parent_email as demo_parent_email,
             d.parent_name as demo_parent_name
      FROM monthly_assessments a
      LEFT JOIN students s ON a.student_id = s.id
      LEFT JOIN demo_leads d ON a.demo_lead_id = d.id
      WHERE a.id = $1
    `, [req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public endpoint for viewing demo assessment certificates (no auth required)
app.get('/api/demo-assessment/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.id, a.assessment_type, a.skills, a.certificate_title,
             a.performance_summary, a.areas_of_improvement, a.teacher_comments, a.created_at,
             d.child_name as demo_child_name,
             d.demo_date as demo_date
      FROM monthly_assessments a
      LEFT JOIN demo_leads d ON a.demo_lead_id = d.id
      WHERE a.id = $1 AND a.assessment_type = 'demo'
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Demo assessment not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public endpoint for viewing monthly assessment certificates (no auth required)
app.get('/api/monthly-assessment/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.id, a.assessment_type, a.month, a.year, a.skills, a.certificate_title,
             a.performance_summary, a.areas_of_improvement, a.teacher_comments, a.created_at,
             s.name as student_name
      FROM monthly_assessments a
      LEFT JOIN students s ON a.student_id = s.id
      WHERE a.id = $1 AND a.assessment_type = 'monthly'
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Monthly assessment not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/:id/assessments', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM monthly_assessments
      WHERE student_id = $1
      ORDER BY year DESC, month DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/assessments', async (req, res) => {
  const { assessment_type, student_id, demo_lead_id, month, year, skills, certificate_title, performance_summary, areas_of_improvement, teacher_comments, send_email } = req.body;

  try {
    const isDemo = assessment_type === 'demo';
    let result;

    if (isDemo) {
      // Demo assessment - linked to demo_lead
      result = await pool.query(`
        INSERT INTO monthly_assessments (demo_lead_id, assessment_type, skills, certificate_title, performance_summary, areas_of_improvement, teacher_comments)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [demo_lead_id, 'demo', skills, certificate_title, performance_summary, areas_of_improvement, teacher_comments]);

      // Send demo assessment email if requested
      if (send_email) {
        const lead = await pool.query('SELECT child_name, child_grade, parent_email, parent_name, demo_date FROM demo_leads WHERE id = $1', [demo_lead_id]);
        if (lead.rows[0] && lead.rows[0].parent_email) {
          const skillsArray = skills ? JSON.parse(skills) : [];
          const demoEmailHTML = getDemoAssessmentEmail({
            assessmentId: result.rows[0].id,
            childName: lead.rows[0].child_name,
            childGrade: lead.rows[0].child_grade,
            demoDate: lead.rows[0].demo_date,
            skills: skillsArray,
            certificateTitle: certificate_title,
            performanceSummary: performance_summary,
            areasOfImprovement: areas_of_improvement,
            teacherComments: teacher_comments
          });

          await sendEmail(
            lead.rows[0].parent_email,
            `🎯 Demo Class Assessment Report - ${lead.rows[0].child_name}`,
            demoEmailHTML,
            lead.rows[0].parent_name,
            'Demo Assessment'
          );
        }
      }
    } else {
      // Monthly assessment - linked to student
      result = await pool.query(`
        INSERT INTO monthly_assessments (student_id, assessment_type, month, year, skills, certificate_title, performance_summary, areas_of_improvement, teacher_comments)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `, [student_id, 'monthly', month, year, skills, certificate_title, performance_summary, areas_of_improvement, teacher_comments]);

      // Send email if requested
      if (send_email) {
        const student = await pool.query('SELECT name, parent_email, parent_name FROM students WHERE id = $1', [student_id]);
        if (student.rows[0]) {
          const skillsArray = skills ? JSON.parse(skills) : [];
          const reportCardEmailHTML = getMonthlyReportCardEmail({
            assessmentId: result.rows[0].id,
            studentName: student.rows[0].name,
            month: month,
            year: year,
            skills: skillsArray,
            certificateTitle: certificate_title,
            performanceSummary: performance_summary,
            areasOfImprovement: areas_of_improvement,
            teacherComments: teacher_comments
          });

          const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
          await sendEmail(
            student.rows[0].parent_email,
            `📊 Monthly Progress Report - ${monthNames[month - 1]} ${year}`,
            reportCardEmailHTML,
            student.rows[0].parent_name,
            'Report Card'
          );
        }
      }
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Assessment creation error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/assessments/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM monthly_assessments WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== RESOURCE LIBRARY ====================

// Get all resources (admin)
app.get('/api/resources', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM resource_library ORDER BY is_featured DESC, created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get active resources for parents (filtered by category/grade)
app.get('/api/resources/library', async (req, res) => {
  try {
    const { category, grade } = req.query;
    let query = 'SELECT * FROM resource_library WHERE is_active = true';
    const params = [];

    if (category && category !== 'all') {
      params.push(category);
      query += ` AND category = $${params.length}`;
    }
    if (grade && grade !== 'all') {
      params.push(grade);
      query += ` AND (grade_level = $${params.length} OR grade_level = 'All Grades' OR grade_level IS NULL)`;
    }

    query += ' ORDER BY is_featured DESC, created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get resource categories
app.get('/api/resources/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT DISTINCT category FROM resource_library WHERE is_active = true ORDER BY category');
    res.json(result.rows.map(r => r.category));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new resource
app.post('/api/resources', async (req, res) => {
  const { title, description, category, resource_type, file_path, external_link, thumbnail_url, grade_level, tags, is_featured } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO resource_library (title, description, category, resource_type, file_path, external_link, thumbnail_url, grade_level, tags, is_featured)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [title, description, category, resource_type, file_path || null, external_link || null, thumbnail_url || null, grade_level || 'All Grades', tags || null, is_featured || false]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a resource
app.put('/api/resources/:id', async (req, res) => {
  const { title, description, category, resource_type, file_path, external_link, thumbnail_url, grade_level, tags, is_featured, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE resource_library SET
        title = $1, description = $2, category = $3, resource_type = $4,
        file_path = $5, external_link = $6, thumbnail_url = $7,
        grade_level = $8, tags = $9, is_featured = $10, is_active = $11, updated_at = CURRENT_TIMESTAMP
       WHERE id = $12 RETURNING *`,
      [title, description, category, resource_type, file_path || null, external_link || null, thumbnail_url || null, grade_level, tags || null, is_featured || false, is_active !== false, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Increment view count
app.post('/api/resources/:id/view', async (req, res) => {
  try {
    await pool.query('UPDATE resource_library SET view_count = view_count + 1 WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a resource
app.delete('/api/resources/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM resource_library WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload resource file
app.post('/api/resources/upload', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('Upload error:', err);
      return res.status(400).json({ error: err.message || 'File upload failed' });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    let filePath;
    if (req.file.path && (req.file.path.includes('cloudinary') || req.file.path.includes('res.cloudinary.com'))) {
      filePath = req.file.path;
    } else if (req.file.filename) {
      filePath = '/uploads/materials/' + req.file.filename;
    } else {
      filePath = req.file.path;
    }
    console.log('Resource uploaded:', filePath);
    res.json({ filePath, fileName: req.file.originalname });
  } catch (err) {
    console.error('Resource upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== MANUAL REMINDER TRIGGER ====================
// Endpoint to manually trigger reminder check (useful for testing or if cron misses)
app.post('/api/admin/trigger-reminders', async (req, res) => {
  try {
    console.log('🔔 Manual reminder check triggered');
    await checkAndSendReminders();
    res.json({ success: true, message: 'Reminder check completed. Check server logs for details.' });
  } catch (err) {
    console.error('Error in manual reminder trigger:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to manually reconnect database (useful after cold starts)
app.post('/api/admin/reconnect-db', async (req, res) => {
  try {
    console.log('🔄 Manual database reconnection triggered');
    dbReady = false;

    // Try to establish a fresh connection
    const testResult = await executeQuery('SELECT NOW() as current_time');

    res.json({
      success: true,
      message: 'Database reconnected successfully',
      server_time: testResult.rows[0].current_time,
      pool_stats: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount
      }
    });
  } catch (err) {
    console.error('Database reconnection failed:', err);
    res.status(500).json({
      success: false,
      error: err.message,
      hint: 'Database may be starting up. Try again in a few seconds.'
    });
  }
});

// Endpoint to check server health and upcoming reminders
app.get('/api/health', async (req, res) => {
  try {
    const now = new Date();
    let dbStatus = 'unknown';
    let dbLatency = null;
    let poolStats = null;

    // Test database connection with timing
    const dbStart = Date.now();
    try {
      await executeQuery('SELECT 1');
      dbLatency = Date.now() - dbStart;
      dbStatus = 'connected';
    } catch (dbErr) {
      dbStatus = 'disconnected';
      console.error('Health check DB error:', dbErr.message);
    }

    // Get pool statistics
    poolStats = {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount
    };

    // Get upcoming sessions (only if DB is connected)
    let sessionsWithTimes = [];
    if (dbStatus === 'connected') {
      try {
        const upcoming = await executeQuery(`
          SELECT s.id, s.session_number, s.session_date, s.session_time, s.session_type,
                 COALESCE(st.name, 'Group') as student_name,
                 CONCAT(s.session_date, 'T', s.session_time, 'Z') as full_datetime
          FROM sessions s
          LEFT JOIN students st ON s.student_id = st.id
          WHERE s.status IN ('Pending', 'Scheduled')
            AND s.session_date >= CURRENT_DATE - INTERVAL '1 day'
          ORDER BY s.session_date, s.session_time
          LIMIT 10
        `);

        sessionsWithTimes = upcoming.rows.map(s => {
          const sessionDateTime = new Date(s.full_datetime);
          const hoursDiff = (sessionDateTime - now) / (1000 * 60 * 60);
          return {
            id: s.id,
            session_number: s.session_number,
            student: s.student_name,
            type: s.session_type,
            datetime_utc: s.full_datetime,
            hours_until: hoursDiff.toFixed(2)
          };
        });
      } catch (err) {
        console.error('Error fetching sessions for health check:', err.message);
      }
    }

    const overallStatus = dbStatus === 'connected' ? 'healthy' : 'degraded';

    res.json({
      status: overallStatus,
      server_time_utc: now.toISOString(),
      database: {
        status: dbStatus,
        latency_ms: dbLatency,
        pool: poolStats,
        ready: dbReady
      },
      upcoming_sessions: sessionsWithTimes,
      reminder_windows: {
        '5_hour': '4.5 to 5.5 hours before class',
        '1_hour': '0.5 to 1.5 hours before class'
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: err.message,
      database: { status: 'error', ready: dbReady }
    });
  }
});

// ==================== KEEPALIVE PING ====================
// Self-ping every 14 minutes to prevent server sleep on free tier platforms
const SELF_PING_INTERVAL = 14 * 60 * 1000; // 14 minutes
const DB_CHECK_INTERVAL = 5 * 60 * 1000;   // Check DB every 5 minutes
let selfPingUrl = null;

// Database health check - tries to reconnect if disconnected
async function checkDatabaseHealth() {
  try {
    if (!dbReady) {
      console.log('🔄 Database not ready, attempting to reconnect...');
      await executeQuery('SELECT 1');
      console.log('✅ Database reconnected successfully');
    }
  } catch (err) {
    console.error('❌ Database health check failed:', err.message);
    dbReady = false;
  }
}

function startKeepAlive() {
  // Database health check - runs every 5 minutes
  setInterval(async () => {
    await checkDatabaseHealth();
  }, DB_CHECK_INTERVAL);

  // Only start external keepalive in production
  if (process.env.NODE_ENV === 'production' && process.env.RENDER_EXTERNAL_URL) {
    selfPingUrl = process.env.RENDER_EXTERNAL_URL;
    console.log(`🏓 Keepalive ping enabled for: ${selfPingUrl}`);

    setInterval(async () => {
      try {
        const response = await axios.get(`${selfPingUrl}/api/health`, { timeout: 15000 });
        const data = response.data;
        const dbStatus = data.database?.status || 'unknown';
        console.log(`🏓 Keepalive: ${data.status}, DB: ${dbStatus}, Pool: ${JSON.stringify(data.database?.pool || {})} at ${new Date().toISOString()}`);

        // If database is disconnected, try to reconnect
        if (dbStatus !== 'connected') {
          console.log('🔄 Database disconnected, triggering reconnect...');
          await checkDatabaseHealth();
        }
      } catch (err) {
        console.log(`🏓 Keepalive ping failed: ${err.message}`);
      }
    }, SELF_PING_INTERVAL);
  }
}

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, closing database pool...');
  try {
    await pool.end();
    console.log('✅ Database pool closed');
  } catch (err) {
    console.error('Error closing pool:', err.message);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT received, closing database pool...');
  try {
    await pool.end();
    console.log('✅ Database pool closed');
  } catch (err) {
    console.error('Error closing pool:', err.message);
  }
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🚀 LMS Running on port ${PORT}`);
  startKeepAlive();
});