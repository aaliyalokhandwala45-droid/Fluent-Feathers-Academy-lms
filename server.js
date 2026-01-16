// ==================== ADVANCED LMS - SERVER.JS (PRODUCTION READY) ====================
console.log("🚀 Starting Advanced LMS Server...");

const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
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

pool.connect((err, client, release) => {
  if (err) { console.error('❌ Database connection error:', err); }
  else { console.log('✅ Connected to PostgreSQL'); release(); initializeDatabase(); }
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
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const forbidden = ['.exe', '.sh', '.bat', '.js', '.cmd'];
    if (forbidden.includes(ext)) return cb(new Error('Executable files not allowed'));
    if (file.originalname.includes('..')) return cb(new Error('Invalid filename'));
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|ppt|pptx|mp4|mp3|zip|rar/;
    if (allowedTypes.test(ext)) return cb(null, true);
    cb(new Error('Invalid file type'));
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

    console.log('🔧 Dropping existing tables for clean setup...');
    // Drop tables in correct order (reverse of creation due to foreign keys)
    await client.query('DROP TABLE IF EXISTS email_log CASCADE');
    await client.query('DROP TABLE IF EXISTS event_registrations CASCADE');
    await client.query('DROP TABLE IF EXISTS events CASCADE');
    await client.query('DROP TABLE IF EXISTS payment_history CASCADE');
    await client.query('DROP TABLE IF EXISTS makeup_classes CASCADE');
    await client.query('DROP TABLE IF EXISTS materials CASCADE');
    await client.query('DROP TABLE IF EXISTS session_attendance CASCADE');
    await client.query('DROP TABLE IF EXISTS sessions CASCADE');
    await client.query('DROP TABLE IF EXISTS groups CASCADE');
    await client.query('DROP TABLE IF EXISTS students CASCADE');
    await client.query('DROP TABLE IF EXISTS parent_credentials CASCADE');

    console.log('✅ Old tables dropped');

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

    // Create indexes
    console.log('🔧 Creating indexes...');
    await client.query('CREATE INDEX IF NOT EXISTS idx_students_email ON students(parent_email)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_id)');

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
        © ${new Date().getFullYear()} Fluent Feathers Academy. All rights reserved.
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
        © ${new Date().getFullYear()} Fluent Feathers Academy. All rights reserved.
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
        © ${new Date().getFullYear()} Fluent Feathers Academy. All rights reserved.
      </p>
    </div>
  </div>
</body>
</html>`;
}

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
    const today = new Date().toISOString().split('T')[0];
    const priv = await pool.query(`
      SELECT s.*, st.name as student_name, st.timezone, s.session_number,
      CONCAT(st.program_name, ' - ', st.duration) as class_info
      FROM sessions s
      JOIN students st ON s.student_id = st.id
      WHERE s.session_date >= $1 AND s.status IN ('Pending', 'Scheduled') AND s.session_type = 'Private'
      ORDER BY s.session_date ASC, s.session_time ASC LIMIT 10
    `, [today]);

    const grp = await pool.query(`
      SELECT s.*, g.group_name as student_name, g.timezone, s.session_number,
      CONCAT(g.program_name, ' - ', g.duration) as class_info
      FROM sessions s
      JOIN groups g ON s.group_id = g.id
      WHERE s.session_date >= $1 AND s.status IN ('Pending', 'Scheduled') AND s.session_type = 'Group'
      ORDER BY s.session_date ASC, s.session_time ASC LIMIT 10
    `, [today]);

    const all = [...priv.rows, ...grp.rows].sort((a, b) => {
      const dateA = new Date(`${a.session_date}T${a.session_time}Z`);
      const dateB = new Date(`${b.session_date}T${b.session_time}Z`);
      return dateA - dateB;
    }).slice(0, 10);

    res.json(all);
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
  const { name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, program_name, class_type, duration, currency, per_session_fee, total_sessions } = req.body;
  try {
    const r = await pool.query(`
      INSERT INTO students (name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, program_name, class_type, duration, currency, per_session_fee, total_sessions, completed_sessions, remaining_sessions, fees_paid, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, $13, 0, true)
      RETURNING id
    `, [name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, program_name, class_type, duration, currency, per_session_fee, total_sessions]);

    const emailSent = await sendEmail(
      parent_email,
      `🎓 Welcome to Fluent Feathers Academy - ${name}`,
      getWelcomeEmail({ parent_name, student_name: name, program_name, zoom_link: DEFAULT_ZOOM }),
      parent_name,
      'Welcome'
    );

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
  const { amount, currency, payment_method, receipt_number, sessions_covered, notes } = req.body;
  try {
    await pool.query(`
      INSERT INTO payment_history (student_id, payment_date, amount, currency, payment_method, receipt_number, sessions_covered, notes, payment_status)
      VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, 'Paid')
    `, [req.params.id, amount, currency, payment_method, receipt_number, sessions_covered, notes]);
    await pool.query('UPDATE students SET fees_paid = fees_paid + $1 WHERE id = $2', [amount, req.params.id]);
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
    const { student_id, classes } = req.body;
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

    // Send Schedule Email
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

    res.json({ success: true, message: 'Classes scheduled and email sent!' });
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
    const { group_id, classes } = req.body;
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

    // Send schedule email to all students in the group
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
    }

    res.json({ success: true, message: 'Group classes scheduled and emails sent!' });
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
    // Get private sessions
    const privateSessions = await pool.query(`
      SELECT s.*, 'Private' as source_type
      FROM sessions s
      WHERE s.student_id = $1 AND s.session_type = 'Private'
    `, [id]);

    // Get group sessions for this student
    const student = await pool.query('SELECT group_id FROM students WHERE id = $1', [id]);
    let groupSessions = [];

    if (student.rows[0] && student.rows[0].group_id) {
      const groupSessionsResult = await pool.query(`
        SELECT s.*, 'Group' as source_type
        FROM sessions s
        WHERE s.group_id = $1 AND s.session_type = 'Group'
      `, [student.rows[0].group_id]);
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
        await pool.query('UPDATE students SET completed_sessions = completed_sessions + 1, remaining_sessions = GREATEST(remaining_sessions - 1, 0) WHERE id = $1', [session.rows[0].student_id]);
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:sessionId/group-attendance', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sa.*, s.name as student_name
      FROM session_attendance sa
      JOIN students s ON sa.student_id = s.id
      WHERE sa.session_id = $1
      ORDER BY s.name
    `, [req.params.sessionId]);
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
  const { event_name, event_description, event_date, event_time, event_duration, target_audience, specific_grades, zoom_link, max_participants } = req.body;
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

    if (students?.rows?.length > 0) {
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
      }
    }

    res.json({ success: true, message: `Event created and emails sent to ${students?.rows?.length || 0} students!`, eventId });
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

app.delete('/api/events/:id', async (req, res) => {
  try {
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
    if((sessionTime - new Date()) < 2 * 60 * 60 * 1000) {
      return res.status(400).json({ error: 'Cannot cancel class less than 2 hours before start.' });
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
    res.json({ success: true });
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

app.listen(PORT, () => console.log(`🚀 LMS Running on port ${PORT}`));
