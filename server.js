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
require('dotenv').config();

const app = express();

const PORT = process.env.PORT || 3000;

// ==================== CONFIG ====================
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'super_secret_change_this_in_production';
const DEFAULT_ZOOM = process.env.DEFAULT_ZOOM_LINK || 'https://us04web.zoom.us/j/7288533155?pwd=Nng5N2l0aU12L0FQK245c0VVVHJBUT09';

// ==================== DATABASE CONNECTION ====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.connect(async (err, client, release) => {
  if (err) { 
    console.error('❌ Database connection error:', err); 
  } else { 
    console.log('✅ Connected to PostgreSQL'); 
    release(); 
    
    // Run initialization first (creates tables if they don't exist)
    await initializeDatabase();
    
    // Then run migrations (adds missing columns to existing tables)
    await runMigrations();
  }
});

// ==================== MIDDLEWARE ====================
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Create upload directories
['uploads', 'uploads/materials', 'uploads/homework'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ==================== FILE UPLOAD SETUP ====================
const storage = multer.diskStorage({
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

const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max for videos
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // Only block executable/script files for security
    const forbidden = ['.exe', '.sh', '.bat', '.cmd', '.php', '.py', '.rb', '.dll', '.msi', '.com', '.scr'];
    if (forbidden.includes(ext)) return cb(new Error('Executable files not allowed'));
    if (file.originalname.includes('..')) return cb(new Error('Invalid filename'));
    // Allow ALL other file types
    cb(null, true);
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
        zoom_link TEXT,
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
        zoom_link TEXT,
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
      console.log('✅ Class feedback table checked/created');
    } catch (err) {
      console.error('❌ Error with class_feedback table:', err.message);
    }

    console.log('✅ All database migrations completed successfully!');
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

    const dateStr = utcDateStr.includes('T') ? utcDateStr.split('T')[0] : utcDateStr;
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
          <li>Join classes using the Zoom link provided</li>
          <li>Upload homework and track progress</li>
        </ul>
      </div>

      <div style="text-align: center; margin: 35px 0;">
        <a href="${data.zoom_link}" style="display: inline-block; background: linear-gradient(135deg, #38b2ac 0%, #2c7a7b 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 30px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 15px rgba(56, 178, 172, 0.4);">
          🎥 Join Your First Class
        </a>
      </div>

      <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 20px; border-radius: 8px; margin-top: 25px;">
        <p style="margin: 0; color: #856404; font-size: 14px;">
          <strong>💡 Pro Tip:</strong> Save the Zoom link for easy access to all your classes. We recommend testing your camera and microphone before the first session.
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
          All classes will use the same Zoom link. We recommend joining 5 minutes early to ensure a smooth start.
          The link will also be available in your parent portal next to each class.
        </p>
      </div>

      <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 20px; border-radius: 8px; margin-top: 25px;">
        <p style="margin: 0; color: #856404; font-size: 14px;">
          <strong>📌 Important:</strong> If you need to cancel a class, please do so at least 2 hours before the scheduled time to receive a makeup credit.
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

      ${data.zoom_link ? `
      <div style="background: #e6fffa; border-left: 4px solid #38b2ac; padding: 20px; margin: 25px 0; border-radius: 8px;">
        <h3 style="color: #2c7a7b; margin-top: 0; margin-bottom: 15px;">🎥 Join Information</h3>
        <p style="color: #234e52; margin: 0 0 15px 0; font-size: 14px;">
          After registering, you'll receive the Zoom link to join the event. We recommend joining 5 minutes early!
        </p>
        <a href="${data.zoom_link}" style="display: inline-block; background: #38b2ac; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-size: 14px;">
          🔗 Event Zoom Link
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
  const { studentName, sessionNumber, localDate, localTime, localDay, zoomLink, hoursBeforeClass } = data;

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
            <td style="padding: 8px 0; color: #667eea; font-size: 16px; font-weight: bold; text-align: right;">${localTime}</td>
          </tr>
        </table>
      </div>

      <div style="text-align: center; margin: 30px 0;">
        <a href="${zoomLink}" style="display: inline-block; background: linear-gradient(135deg, #38b2ac 0%, #2c7a7b 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 8px; font-size: 18px; font-weight: bold; box-shadow: 0 4px 15px rgba(56, 178, 172, 0.3);">
          🎥 Join Zoom Class
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
        joy, and wonderful memories! 🎈
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
  const { studentName, month, year, skills, certificateTitle, performanceSummary, areasOfImprovement, teacherComments } = data;
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const skillsList = skills && skills.length > 0 ? skills : [];

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
      <!-- Certificate Award -->
      <div style="background: linear-gradient(135deg, #FFD700 0%, #FFA500 100%); padding: 25px; border-radius: 12px; text-align: center; margin-bottom: 30px; box-shadow: 0 8px 20px rgba(255, 215, 0, 0.4);">
        <div style="font-size: 40px; margin-bottom: 10px;">🏆</div>
        <p style="margin: 0 0 8px; color: #2d3748; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Achievement Award</p>
        <h3 style="margin: 0; color: #2d3748; font-size: 26px; font-weight: bold; text-shadow: 1px 1px 2px rgba(255,255,255,0.5);">🌟 ${certificateTitle} 🌟</h3>
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

// ==================== CLASS REMINDER CRON JOB ====================
// Runs every 15 minutes to check for upcoming classes
cron.schedule('*/15 * * * *', async () => {
  try {
    console.log('🔔 Checking for upcoming classes to send reminders...');

    const now = new Date();
    const fiveHoursLater = new Date(now.getTime() + (5 * 60 * 60 * 1000));
    const oneHourLater = new Date(now.getTime() + (1 * 60 * 60 * 1000));

    // Find all upcoming sessions in the next 5 hours and 1 hour
    const upcomingSessions = await pool.query(`
      SELECT s.*, st.name as student_name, st.parent_email, st.parent_name, st.timezone,
             CONCAT(s.session_date, 'T', s.session_time, 'Z') as full_datetime
      FROM sessions s
      JOIN students st ON s.student_id = st.id
      WHERE s.status IN ('Pending', 'Scheduled')
        AND s.session_date >= CURRENT_DATE
        AND st.is_active = true
        AND st.parent_email IS NOT NULL
    `);

    for (const session of upcomingSessions.rows) {
      try {
        const sessionDateTime = new Date(session.full_datetime);
        const timeDiff = sessionDateTime - now;
        const hoursDiff = timeDiff / (1000 * 60 * 60);

        // Check if we need to send 5-hour reminder
        if (hoursDiff > 4.75 && hoursDiff <= 5.25) {
          // Check if 5-hour reminder already sent for this specific session
          const sentCheck = await pool.query(
            `SELECT id FROM email_log
             WHERE recipient_email = $1
               AND email_type = 'Reminder-5hrs'
               AND subject = $2`,
            [session.parent_email, `⏰ Class Reminder - Session #${session.session_number} in 5 hours`]
          );

          if (sentCheck.rows.length === 0) {
            const localTime = formatUTCToLocal(session.session_date, session.session_time, session.timezone);
            const reminderEmailHTML = getClassReminderEmail({
              studentName: session.student_name,
              sessionNumber: session.session_number,
              localDate: localTime.date,
              localTime: localTime.time,
              localDay: localTime.day,
              zoomLink: session.zoom_link || DEFAULT_ZOOM,
              hoursBeforeClass: 5
            });

            await sendEmail(
              session.parent_email,
              `⏰ Class Reminder - Session #${session.session_number} in 5 hours`,
              reminderEmailHTML,
              session.parent_name,
              'Reminder-5hrs'
            );
            console.log(`✅ Sent 5-hour reminder to ${session.parent_email} for Session #${session.session_number}`);
          }
        }

        // Check if we need to send 1-hour reminder
        if (hoursDiff > 0.75 && hoursDiff <= 1.25) {
          // Check if 1-hour reminder already sent for this specific session
          const sentCheck = await pool.query(
            `SELECT id FROM email_log
             WHERE recipient_email = $1
               AND email_type = 'Reminder-1hr'
               AND subject = $2`,
            [session.parent_email, `⏰ Class Reminder - Session #${session.session_number} in 1 hour`]
          );

          if (sentCheck.rows.length === 0) {
            const localTime = formatUTCToLocal(session.session_date, session.session_time, session.timezone);
            const reminderEmailHTML = getClassReminderEmail({
              studentName: session.student_name,
              sessionNumber: session.session_number,
              localDate: localTime.date,
              localTime: localTime.time,
              localDay: localTime.day,
              zoomLink: session.zoom_link || DEFAULT_ZOOM,
              hoursBeforeClass: 1
            });

            await sendEmail(
              session.parent_email,
              `⏰ Class Reminder - Session #${session.session_number} in 1 hour`,
              reminderEmailHTML,
              session.parent_name,
              'Reminder-1hr'
            );
            console.log(`✅ Sent 1-hour reminder to ${session.parent_email} for Session #${session.session_number}`);
          }
        }
      } catch (sessionErr) {
        console.error(`Error processing session ${session.id}:`, sessionErr);
      }
    }
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

// ==================== API ROUTES ====================
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const s = await pool.query('SELECT COUNT(*) as total, SUM(fees_paid) as revenue FROM students WHERE is_active = true');
    const sess = await pool.query(`SELECT COUNT(*) as upcoming FROM sessions WHERE status IN ('Pending', 'Scheduled') AND session_date >= CURRENT_DATE`);
    const g = await pool.query('SELECT COUNT(*) as total FROM groups');
    const e = await pool.query('SELECT COUNT(*) as total FROM events WHERE status = \'Active\'');
    res.json({
      totalStudents: parseInt(s.rows[0].total)||0,
      totalRevenue: parseFloat(s.rows[0].revenue)||0,
      upcomingSessions: parseInt(sess.rows[0].upcoming)||0,
      totalGroups: parseInt(g.rows[0].total)||0,
      activeEvents: parseInt(e.rows[0].total)||0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/upcoming-classes', async (req, res) => {
  try {
    // Get private sessions
    const priv = await pool.query(`
      SELECT s.*, st.name as student_name, st.timezone, s.session_number,
      CONCAT(st.program_name, ' - ', st.duration) as class_info,
      'Private' as display_type
      FROM sessions s
      JOIN students st ON s.student_id = st.id
      WHERE s.status IN ('Pending', 'Scheduled') AND s.session_type = 'Private'
      ORDER BY s.session_date ASC, s.session_time ASC
    `);

    // Get group sessions
    const grp = await pool.query(`
      SELECT s.*, g.group_name as student_name, g.timezone, s.session_number,
      CONCAT(g.program_name, ' - ', g.duration) as class_info,
      'Group' as display_type
      FROM sessions s
      JOIN groups g ON s.group_id = g.id
      WHERE s.status IN ('Pending', 'Scheduled') AND s.session_type = 'Group'
      ORDER BY s.session_date ASC, s.session_time ASC
    `);

    // Get upcoming events as well
    const events = await pool.query(`
      SELECT id, event_name as student_name, event_date as session_date, event_time as session_time,
      event_duration as class_info, 'Asia/Kolkata' as timezone, 0 as session_number,
      'Event' as display_type, 'Event' as session_type, zoom_link
      FROM events
      WHERE status = 'Active'
      ORDER BY event_date ASC, event_time ASC
    `);

    // Combine all
    const all = [...priv.rows, ...grp.rows, ...events.rows];

    // Filter and sort by UTC datetime (since database stores UTC)
    const now = new Date();
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
        return sessionDateTime >= now;
      } catch (e) {
        return false;
      }
    }).sort((a, b) => {
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
    }).slice(0, 10); // Show 10 upcoming classes

    res.json(upcoming);
  } catch (err) {
    console.error('Error loading upcoming classes:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*, COUNT(m.id) as makeup_credits
      FROM students s
      LEFT JOIN makeup_classes m ON s.id = m.student_id AND m.status = 'Available'
      WHERE s.is_active = true
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `);
    res.json(r.rows);
  } catch (err) {
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
        getWelcomeEmail({ parent_name, student_name: name, program_name, zoom_link: DEFAULT_ZOOM }),
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
    await pool.query('UPDATE students SET is_active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
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
    const r = await pool.query(`
      SELECT g.*, COUNT(DISTINCT s.id) as enrolled_students
      FROM groups g
      LEFT JOIN students s ON g.id = s.group_id AND s.is_active = true
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
        INSERT INTO sessions (student_id, session_type, session_number, session_date, session_time, zoom_link, status)
        VALUES ($1, 'Private', $2, $3::date, $4::time, $5, 'Pending')
      `, [student_id, sessionNumber, utc.date, utc.time, DEFAULT_ZOOM]);

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
        INSERT INTO sessions (group_id, session_type, session_number, session_date, session_time, zoom_link, status)
        VALUES ($1, 'Group', $2, $3::date, $4::time, $5, 'Pending')
        RETURNING id
      `, [group_id, sessionNumber, utc.date, utc.time, DEFAULT_ZOOM]);

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
    // Get private sessions with homework info and feedback status
    const privateSessions = await pool.query(`
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
    const student = await pool.query('SELECT group_id FROM students WHERE id = $1', [id]);
    let groupSessions = [];

    if (student.rows[0] && student.rows[0].group_id) {
      const groupSessionsResult = await pool.query(`
        SELECT s.*, 'Group' as source_type,
          m.file_path as homework_submission_path,
          m.feedback_grade as homework_grade,
          m.feedback_comments as homework_feedback,
          CASE WHEN cf.id IS NOT NULL THEN true ELSE false END as has_feedback
        FROM sessions s
        LEFT JOIN materials m ON m.session_id = s.id AND m.student_id = $1 AND m.file_type = 'Homework' AND m.uploaded_by = 'Parent'
        LEFT JOIN class_feedback cf ON cf.session_id = s.id AND cf.student_id = $1
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

    res.json(allSessions);
  } catch (err) {
    console.error('Error fetching sessions:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a session
app.delete('/api/sessions/:sessionId', async (req, res) => {
  try {
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
    const student = await pool.query('SELECT * FROM students WHERE id = $1 AND is_active = true', [studentId]);
    res.json({ student: student.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:sessionId/details', async (req, res) => {
  try {
    const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [req.params.sessionId]);
    res.json(session.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:sessionId/attendance', async (req, res) => {
  try {
    const { attendance } = req.body;
    await pool.query('UPDATE sessions SET status = $1 WHERE id = $2', [attendance === 'Present' ? 'Completed' : 'Missed', req.params.sessionId]);

    if (attendance === 'Present') {
      const session = await pool.query('SELECT student_id FROM sessions WHERE id = $1', [req.params.sessionId]);
      if (session.rows[0] && session.rows[0].student_id) {
        const studentId = session.rows[0].student_id;
        await pool.query('UPDATE students SET completed_sessions = completed_sessions + 1, remaining_sessions = GREATEST(remaining_sessions - 1, 0) WHERE id = $1', [studentId]);

        // Award attendance badges
        const student = await pool.query('SELECT completed_sessions FROM students WHERE id = $1', [studentId]);
        const completedCount = student.rows[0].completed_sessions;

        if (completedCount === 1) await awardBadge(studentId, 'first_class', '🌟 First Class Star', 'Attended first class!');
        if (completedCount === 5) await awardBadge(studentId, '5_classes', '🏆 5 Classes Champion', 'Completed 5 classes!');
        if (completedCount === 10) await awardBadge(studentId, '10_classes', '👑 10 Classes Master', 'Completed 10 classes!');
        if (completedCount === 25) await awardBadge(studentId, '25_classes', '🎖️ 25 Classes Legend', 'Completed 25 classes!');
        if (completedCount === 50) await awardBadge(studentId, '50_classes', '💎 50 Classes Diamond', 'Amazing milestone!');
      }
    }

    res.json({ success: true });
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
      await client.query('UPDATE session_attendance SET attendance = $1 WHERE session_id = $2 AND student_id = $3', [record.attendance, sessionId, record.student_id]);

      if (prev.rows[0]?.attendance !== 'Present' && record.attendance === 'Present') {
        await client.query(`UPDATE students SET completed_sessions = completed_sessions + 1, remaining_sessions = GREATEST(remaining_sessions - 1, 0) WHERE id = $1`, [record.student_id]);

        // Award badges for group class attendance
        const student = await client.query('SELECT completed_sessions FROM students WHERE id = $1', [record.student_id]);
        const completedCount = student.rows[0].completed_sessions;

        if (completedCount === 1) await awardBadge(record.student_id, 'first_class', '🌟 First Class Star', 'Attended first class!');
        if (completedCount === 5) await awardBadge(record.student_id, '5_classes', '🏆 5 Classes Champion', 'Completed 5 classes!');
        if (completedCount === 10) await awardBadge(record.student_id, '10_classes', '👑 10 Classes Master', 'Completed 10 classes!');
        if (completedCount === 25) await awardBadge(record.student_id, '25_classes', '🎖️ 25 Classes Legend', 'Completed 25 classes!');
        if (completedCount === 50) await awardBadge(record.student_id, '50_classes', '💎 50 Classes Diamond', 'Amazing milestone!');
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

app.post('/api/sessions/:sessionId/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const col = { ppt:'ppt_file_path', recording:'recording_file_path', homework:'homework_file_path' }[req.body.materialType];
  if (!col) return res.status(400).json({ error: 'Invalid type' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE sessions SET ${col} = $1 WHERE id = $2`, [req.file.filename, req.params.sessionId]);
    const session = (await client.query('SELECT * FROM sessions WHERE id = $1', [req.params.sessionId])).rows[0];
    const studentsQuery = session.session_type === 'Group' ? `SELECT id FROM students WHERE group_id = $1 AND is_active = true` : `SELECT $1 as id`;
    const students = await client.query(studentsQuery, [session.group_id || session.student_id]);
    for(const s of students.rows) {
      await client.query(`
        INSERT INTO materials (student_id, group_id, session_id, session_date, file_type, file_name, file_path, uploaded_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'Teacher')
      `, [s.id, session.group_id, req.params.sessionId, session.session_date, req.body.materialType.toUpperCase(), req.file.originalname, req.file.filename]);
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
    res.json((await pool.query('SELECT * FROM materials WHERE student_id = $1 ORDER BY uploaded_at DESC', [req.params.studentId])).rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload/homework/:studentId', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    await pool.query(`
      INSERT INTO materials (student_id, session_id, session_date, file_type, file_name, file_path, uploaded_by)
      VALUES ($1, $2, CURRENT_DATE, 'Homework', $3, $4, 'Parent')
    `, [req.params.studentId, req.body.sessionId, req.file.originalname, req.file.filename]);

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
  const { event_name, event_description, event_date, event_time, event_duration, target_audience, specific_grades, zoom_link, max_participants, send_email } = req.body;
  try {
    const utc = istToUTC(event_date, event_time);
    const result = await pool.query(`
      INSERT INTO events (event_name, event_description, event_date, event_time, event_duration, target_audience, specific_grades, zoom_link, max_participants, status)
      VALUES ($1, $2, $3::date, $4::time, $5, $6, $7, $8, $9, 'Active')
      RETURNING id
    `, [event_name, event_description || '', utc.date, utc.time, event_duration, target_audience || 'All', specific_grades || '', zoom_link || DEFAULT_ZOOM, max_participants || null]);

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
          zoom_link: zoom_link || DEFAULT_ZOOM,
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
  const { event_name, event_description, event_duration, status, max_participants, zoom_link } = req.body;
  try {
    await pool.query(`
      UPDATE events SET
        event_name = $1,
        event_description = $2,
        event_duration = $3,
        status = $4,
        max_participants = $5,
        zoom_link = $6
      WHERE id = $7
    `, [event_name, event_description, event_duration, status, max_participants, zoom_link, req.params.id]);
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
      const dateA = new Date(`${a.session_date}T${a.session_time}Z`);
      const dateB = new Date(`${b.session_date}T${b.session_time}Z`);
      return dateB - dateA;
    }).slice(0, 50);

    res.json(all);
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
    await pool.query('UPDATE sessions SET status = $1, cancelled_by = $2 WHERE id = $3', ['Cancelled by Parent', 'Parent', session.id]);
    await pool.query(`INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status) VALUES ($1, $2, $3, CURRENT_DATE, 'Available')`, [id, session.id, req.body.reason || 'Parent cancelled']);
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

app.post('/api/parent/check-email', async (req, res) => {
  try {
    const s = (await pool.query('SELECT * FROM students WHERE parent_email = $1 AND is_active = true', [req.body.email])).rows;
    if(s.length===0) return res.status(404).json({ error: 'No student found.' });
    const c = (await pool.query('SELECT password FROM parent_credentials WHERE parent_email = $1', [req.body.email])).rows[0];
    res.json({ hasPassword: c && c.password ? true : false });
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
    const s = (await pool.query('SELECT * FROM students WHERE parent_email = $1 AND is_active = true', [req.body.email])).rows;
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
    const s = (await pool.query('SELECT * FROM students WHERE parent_email = $1 AND is_active = true', [req.body.email])).rows;
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
        fees_paid = fees_paid + $2
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

// ==================== EDIT & DELETE STUDENT ====================
app.put('/api/students/:id', async (req, res) => {
  const { name, grade, parent_name, parent_email, primary_contact, timezone, program_name, duration, per_session_fee, currency } = req.body;
  try {
    await pool.query(`
      UPDATE students SET
        name = $1, grade = $2, parent_name = $3, parent_email = $4,
        primary_contact = $5, timezone = $6, program_name = $7,
        duration = $8, per_session_fee = $9, currency = $10
      WHERE id = $11
    `, [name, grade, parent_name, parent_email, primary_contact, timezone, program_name, duration, per_session_fee, currency, req.params.id]);
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
    await pool.query(`
      INSERT INTO class_feedback (session_id, student_id, rating, feedback_text)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (session_id, student_id) DO UPDATE
      SET rating = $3, feedback_text = $4
    `, [req.params.sessionId, student_id, rating, feedback_text]);

    await awardBadge(student_id, 'feedback', '⭐ Feedback Star', 'Shared valuable feedback');

    res.json({ success: true, message: 'Thank you for your feedback!' });
  } catch (err) {
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

    const material = await pool.query('SELECT student_id FROM materials WHERE id = $1', [req.params.id]);
    if (material.rows[0]) {
      await awardBadge(material.rows[0].student_id, 'graded_hw', '📚 Homework Hero', 'Received homework feedback');
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
    res.json(result.rows);
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
    res.json(result.rows);
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

app.post('/api/announcements', async (req, res) => {
  const { title, content, announcement_type, priority } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO announcements (title, content, announcement_type, priority, is_active)
      VALUES ($1, $2, $3, $4, true)
      RETURNING *
    `, [title, content, announcement_type || 'General', priority || 'Normal']);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/announcements/:id', async (req, res) => {
  const { title, content, announcement_type, priority } = req.body;
  try {
    const result = await pool.query(`
      UPDATE announcements
      SET title = $1, content = $2, announcement_type = $3, priority = $4
      WHERE id = $5
      RETURNING *
    `, [title, content, announcement_type, priority, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
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
      SELECT a.*, s.name as student_name
      FROM monthly_assessments a
      JOIN students s ON a.student_id = s.id
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
      SELECT a.*, s.name as student_name
      FROM monthly_assessments a
      JOIN students s ON a.student_id = s.id
      WHERE a.id = $1
    `, [req.params.id]);
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
  const { student_id, month, year, skills, certificate_title, performance_summary, areas_of_improvement, teacher_comments, send_email } = req.body;
  try {
    // Insert assessment into database
    const result = await pool.query(`
      INSERT INTO monthly_assessments (student_id, month, year, skills, certificate_title, performance_summary, areas_of_improvement, teacher_comments)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [student_id, month, year, skills, certificate_title, performance_summary, areas_of_improvement, teacher_comments]);

    // Send email if requested
    if (send_email) {
      const student = await pool.query('SELECT name, parent_email, parent_name FROM students WHERE id = $1', [student_id]);
      if (student.rows[0]) {
        const skillsArray = skills ? JSON.parse(skills) : [];
        const reportCardEmailHTML = getMonthlyReportCardEmail({
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

    res.json(result.rows[0]);
  } catch (err) {
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

app.listen(PORT, () => console.log(`🚀 LMS Running on port ${PORT}`));
