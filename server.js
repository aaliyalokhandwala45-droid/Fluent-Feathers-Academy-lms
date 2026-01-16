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
    const dateStr = utcDateStr.includes('T') ? utcDateStr.split('T')[0] : utcDateStr;
    const timeStr = utcTimeStr.length === 5 ? utcTimeStr + ':00' : utcTimeStr.substring(0, 8);
    const isoString = `${dateStr}T${timeStr}Z`;
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return { date: 'Invalid', time: 'Invalid' };
    return {
      date: date.toLocaleDateString('en-US', { timeZone: timezone, month: 'short', day: 'numeric', year: 'numeric' }),
      time: date.toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true }),
      day: date.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'short' })
    };
  } catch (e) { return { date: utcDateStr, time: utcTimeStr }; }
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
  } catch (e) { console.error('Email Error:', e.message); return false; }
}

function getWelcomeEmail(data) { return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family: Arial, sans-serif; background: #f4f7fa; padding: 20px;"><div style="max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px;"><h1 style="color: #667eea; text-align: center;">🎓 Welcome!</h1><p>Dear ${data.parent_name},<br>Welcome <strong>${data.student_name}</strong> to ${data.program_name}!</p><a href="${DEFAULT_ZOOM}" style="display:block; text-align:center; margin:20px 0; background:#667eea; color:white; padding:15px; text-decoration:none; border-radius:25px;">Join Zoom</a></div></body></html>`; }
function getScheduleEmail(data) { return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family: Arial, sans-serif; background: #f4f7fa; padding: 20px;"><div style="max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px;"><h1 style="color: #667eea;">📅 Schedule</h1><p>Hi ${data.parent_name}, here is the schedule for ${data.student_name}:</p><table style="width:100%; border-collapse:collapse; margin-top:20px;">${data.schedule_rows}</table></div></body></html>`; }
function getEventEmail(data) { return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family: Arial, sans-serif; background: #f4f7fa; padding: 20px;"><div style="max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px;"><h1 style="color: #667eea;">🎉 ${data.event_name}</h1><p>${data.event_description}</p><p><strong>Date:</strong> ${data.event_date} <br><strong>Time:</strong> ${data.event_time}</p><a href="${data.registration_link}" style="display:inline-block; background:#38a169; color:white; padding:10px 20px; text-decoration:none; border-radius:5px; margin-top:10px;">Register</a></div></body></html>`; }

// ==================== API ROUTES ====================
app.get('/api/dashboard/stats', async (req, res) => { try { const s = await pool.query('SELECT COUNT(*) as total, SUM(fees_paid) as revenue FROM students WHERE is_active = true'); const sess = await pool.query(`SELECT COUNT(*) as upcoming FROM sessions WHERE status IN ('Pending', 'Scheduled') AND session_date >= CURRENT_DATE`); const g = await pool.query('SELECT COUNT(*) as total FROM groups'); const e = await pool.query('SELECT COUNT(*) as total FROM events WHERE status = \'Active\''); res.json({ totalStudents: parseInt(s.rows[0].total)||0, totalRevenue: parseFloat(s.rows[0].revenue)||0, upcomingSessions: parseInt(sess.rows[0].upcoming)||0, totalGroups: parseInt(g.rows[0].total)||0, activeEvents: parseInt(e.rows[0].total)||0 }); } catch (err) { res.status(500).json({ error: err.message }); } });

app.get('/api/dashboard/upcoming-classes', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const priv = await pool.query(`SELECT s.*, st.name as student_name, st.timezone, s.session_number, CONCAT(st.program_name, ' - ', st.duration) as class_info FROM sessions s JOIN students st ON s.student_id = st.id WHERE s.session_date >= $1 AND s.status IN ('Pending', 'Scheduled') AND s.session_type = 'Private' ORDER BY s.session_date ASC, s.session_time ASC LIMIT 10`, [today]);
    const grp = await pool.query(`SELECT s.*, g.group_name as student_name, g.timezone, s.session_number, CONCAT(g.program_name, ' - ', g.duration) as class_info FROM sessions s JOIN groups g ON s.group_id = g.id WHERE s.session_date >= $1 AND s.status IN ('Pending', 'Scheduled') AND s.session_type = 'Group' ORDER BY s.session_date ASC, s.session_time ASC LIMIT 10`, [today]);
    const all = [...priv.rows, ...grp.rows].sort((a, b) => new Date(`${a.session_date}T${a.session_time}Z`) - new Date(`${b.session_date}T${b.session_time}Z`)).slice(0, 10);
    res.json(all);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/students', async (req, res) => { try { const r = await pool.query(`SELECT s.*, COUNT(m.id) as makeup_credits FROM students s LEFT JOIN makeup_classes m ON s.id = m.student_id AND m.status = 'Available' WHERE s.is_active = true GROUP BY s.id ORDER BY s.created_at DESC`); res.json(r.rows); } catch (err) { res.status(500).json({ error: err.message }); } });

app.post('/api/students', async (req, res) => { 
  const { name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, program_name, class_type, duration, currency, per_session_fee, total_sessions } = req.body; 
  try { 
    const r = await pool.query(`INSERT INTO students (name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, program_name, class_type, duration, currency, per_session_fee, total_sessions, completed_sessions, remaining_sessions, fees_paid, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, $13, 0, true) RETURNING id`, [name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, program_name, class_type, duration, currency, per_session_fee, total_sessions]); 
    
    const emailSent = await sendEmail(parent_email, `Welcome - ${name}`, getWelcomeEmail({ parent_name, student_name: name, program_name, zoom_link: DEFAULT_ZOOM }), parent_name, 'Welcome'); 
    
    res.json({ success: true, studentId: r.rows[0].id, emailSent: emailSent }); 
  } catch (err) { res.status(500).json({ success: false, error: err.message }); } });

app.delete('/api/students/:id', async (req, res) => { try { await pool.query('UPDATE students SET is_active = false WHERE id = $1', [req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); } });

app.post('/api/students/:id/payment', async (req, res) => { const { amount, currency, payment_method, receipt_number, sessions_covered, notes } = req.body; try { await pool.query(`INSERT INTO payment_history (student_id, payment_date, amount, currency, payment_method, receipt_number, sessions_covered, notes, payment_status) VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, 'Paid')`, [req.params.id, amount, currency, payment_method, receipt_number, sessions_covered, notes]); await pool.query('UPDATE students SET fees_paid = fees_paid + $1 WHERE id = $2', [amount, req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ success: false, error: err.message }); } });

app.get('/api/groups', async (req, res) => { try { const r = await pool.query(`SELECT g.*, COUNT(DISTINCT s.id) as enrolled_students FROM groups g LEFT JOIN students s ON g.id = s.group_id AND s.is_active = true GROUP BY g.id ORDER BY g.created_at DESC`); res.json(r.rows); } catch (err) { res.status(500).json({ error: err.message }); } });

app.post('/api/groups', async (req, res) => { const { group_name, program_name, duration, timezone, max_students } = req.body; try { const r = await pool.query(`INSERT INTO groups (group_name, program_name, duration, timezone, max_students, current_students) VALUES ($1, $2, $3, $4, $5, 0) RETURNING id`, [group_name, program_name, duration, timezone, max_students]); res.json({ success: true, groupId: r.rows[0].id }); } catch (err) { res.status(500).json({ success: false, error: err.message }); } });

app.delete('/api/groups/:id', async (req, res) => { const client = await pool.connect(); try { await client.query('BEGIN'); await client.query('DELETE FROM session_attendance WHERE session_id IN (SELECT id FROM sessions WHERE group_id = $1)', [req.params.id]); await client.query('DELETE FROM sessions WHERE group_id = $1', [req.params.id]); await client.query('DELETE FROM groups WHERE id = $1', [req.params.id]); await client.query('COMMIT'); res.json({ success: true }); } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); } });

// Replace the existing /api/schedule/private-classes endpoint with this:
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
      await client.query(`INSERT INTO sessions (student_id, session_type, session_number, session_date, session_time, zoom_link, status) VALUES ($1, 'Private', $2, $3::date, $4::time, $5, 'Pending')`, [student_id, sessionNumber, utc.date, utc.time, DEFAULT_ZOOM]); 
      
      // Store for email
      const display = formatUTCToLocal(utc.date, utc.time, student.timezone);
      scheduledSessions.push(`<tr style="border-bottom:1px solid #ddd;"><td style="padding:10px;">#${sessionNumber}</td><td style="padding:10px;">${display.date}</td><td style="padding:10px;"><strong style="color:#667eea;">${display.time}</strong></td></tr>`);
      
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
      `📅 Schedule for ${student.name}`, 
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
app.post('/api/schedule/group-classes', async (req, res) => { const client = await pool.connect(); try { const { group_id, classes } = req.body; const group = (await client.query('SELECT * FROM groups WHERE id = $1', [group_id])).rows[0]; if(!group) return res.status(404).json({ error: 'Group not found' }); if(group.current_students >= group.max_students) return res.status(400).json({ error: 'Group full' }); const count = (await client.query('SELECT COUNT(*) as count FROM sessions WHERE group_id = $1', [group_id])).rows[0].count; let sessionNumber = parseInt(count)+1; await client.query('BEGIN'); for(const cls of classes) { if(!cls.date || !cls.time) continue; const utc = istToUTC(cls.date, cls.time); const r = await client.query(`INSERT INTO sessions (group_id, session_type, session_number, session_date, session_time, zoom_link, status) VALUES ($1, 'Group', $2, $3::date, $4::time, $5, 'Pending') RETURNING id`, [group_id, sessionNumber, utc.date, utc.time, DEFAULT_ZOOM]); const sessionId = r.rows[0].id; const students = await client.query('SELECT id FROM students WHERE group_id = $1 AND is_active = true', [group_id]); for(const s of students.rows) await client.query('INSERT INTO session_attendance (session_id, student_id, attendance) VALUES ($1, $2, \'Pending\')', [sessionId, s.id]); sessionNumber++; } await client.query('COMMIT'); res.json({ success: true }); } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); } });

app.post('/api/admin/parent-view-token', async (req, res) => {
  try { const { student_id } = req.body; const student = await pool.query('SELECT id FROM students WHERE id = $1', [student_id]); if (student.rows.length === 0) return res.status(404).json({ error: 'Student not found' }); const token = generateAdminToken(student_id); res.json({ token }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/parent/admin-view', async (req, res) => {
  const studentId = req.adminStudentId; if (!studentId) return res.status(401).json({ error: 'Unauthorized' });
  try { const student = await pool.query('SELECT * FROM students WHERE id = $1 AND is_active = true', [studentId]); res.json({ student: student.rows[0] }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/sessions/:sessionId/details', async (req, res) => {
  try { const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [req.params.sessionId]); res.json(session.rows[0]); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sessions/:sessionId/attendance', async (req, res) => {
  try {
    const { attendance } = req.body;
    await pool.query('UPDATE sessions SET status = $1 WHERE id = $2', [attendance === 'Present' ? 'Completed' : 'Missed', req.params.sessionId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/sessions/:sessionId/group-attendance', async (req, res) => {
  try { const result = await pool.query(`SELECT sa.*, s.name as student_name FROM session_attendance sa JOIN students s ON sa.student_id = s.id WHERE sa.session_id = $1 ORDER BY s.name`, [req.params.sessionId]); res.json(result.rows); } catch (err) { res.status(500).json({ error: err.message }); } });

app.post('/api/sessions/:sessionId/group-attendance', async (req, res) => {
  const client = await pool.connect();
  try { const { attendanceData } = req.body; const sessionId = req.params.sessionId;
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
  } finally { client.release(); }
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
    for(const s of students.rows) await client.query(`INSERT INTO materials (student_id, group_id, session_id, session_date, file_type, file_name, file_path, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Teacher')`, [s.id, session.group_id, req.params.sessionId, session.session_date, req.body.materialType.toUpperCase(), req.file.originalname, req.file.filename]);
    await client.query('COMMIT');
    res.json({ message: 'Material uploaded successfully!', filename: req.file.filename });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.put('/api/sessions/:sessionId/notes', async (req, res) => { try { await pool.query('UPDATE sessions SET teacher_notes = $1 WHERE id = $2', [req.body.teacher_notes, req.params.sessionId]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); } });

app.post('/api/sessions/:sessionId/grade/:studentId', async (req, res) => {
  const client = await pool.connect();
  try {
    const { grade, comments } = req.body; const { sessionId, studentId } = req.params;
    await client.query('BEGIN');
    await client.query('UPDATE session_attendance SET homework_grade = $1, homework_comments = $2 WHERE session_id = $3 AND student_id = $4', [grade, comments, sessionId, studentId]);
    await client.query(`UPDATE materials SET feedback_grade = $1, feedback_comments = $2, feedback_given = 1, feedback_date = CURRENT_TIMESTAMP WHERE session_id = $3 AND student_id = $4 AND file_type = 'Homework'`, [grade, comments, sessionId, studentId]);
    await client.query('COMMIT');
    res.json({ message: 'Homework graded successfully!' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.get('/api/materials/:studentId', async (req, res) => { try { res.json((await pool.query('SELECT * FROM materials WHERE student_id = $1 ORDER BY uploaded_at DESC', [req.params.studentId])).rows); } catch (err) { res.status(500).json({ error: err.message }); } });

app.post('/api/upload/homework/:studentId', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try { await pool.query(`INSERT INTO materials (student_id, session_id, session_date, file_type, file_name, file_path, uploaded_by) VALUES ($1, $2, CURRENT_DATE, 'Homework', $3, $4, 'Parent')`, [req.params.studentId, req.body.sessionId, req.file.originalname, req.file.filename]); res.json({ message: 'Homework uploaded successfully!' }); } catch (err) { res.status(500).json({ error: err.message }); } });

app.get('/api/events', async (req, res) => { try { const r = await pool.query(`SELECT e.*, COUNT(DISTINCT er.id) as registered_count FROM events e LEFT JOIN event_registrations er ON e.id = er.event_id GROUP BY e.id ORDER BY e.event_date DESC`); res.json(r.rows); } catch (err) { res.status(500).json({ error: err.message }); } });

app.post('/api/events', async (req, res) => {
  const { event_name, event_description, event_date, event_time, event_duration, target_audience, specific_grades, zoom_link, max_participants } = req.body;
  try {
    const utc = istToUTC(event_date, event_time);
    const result = await pool.query(`INSERT INTO events (event_name, event_description, event_date, event_time, event_duration, target_audience, specific_grades, zoom_link, max_participants, status) VALUES ($1, $2, $3::date, $4::time, $5, $6, $7, $8, $9, 'Active') RETURNING id`, [event_name, event_description, utc.date, utc.time, event_duration, target_audience, specific_grades, zoom_link, max_participants]);
    const eventId = result.rows[0].id;
    let students = [];
    if (target_audience === 'All') students = await pool.query('SELECT * FROM students WHERE is_active = true');
    else if (target_audience === 'Specific Grades' && specific_grades) students = await pool.query('SELECT * FROM students WHERE is_active = true AND grade = ANY($1)', [specific_grades.split(',').map(g=>g.trim())]);
    if (students?.rows.length > 0) {
      for(const student of students.rows) {
        const display = formatUTCToLocal(utc.date, utc.time, student.timezone);
        const registrationLink = `${req.protocol}://${req.get('host')}/parent.html?event=${eventId}&student=${student.id}`;
        await sendEmail(student.parent_email, `🎉 ${event_name} - Registration Open`, getEventEmail({ parent_name: student.parent_name, event_name, event_description, event_date: display.date, event_time: display.time, event_duration, zoom_link, registration_link }), student.parent_name, 'Event');
      }
    }
    res.json({ success: true, message: `Event created!`, eventId });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); } });

app.post('/api/events/:eventId/register', async (req, res) => {
  const client = await pool.connect();
  try {
    const { student_id } = req.body; const eventId = req.params.eventId;
    const eventResult = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
    const event = eventResult.rows[0];
    if (event.max_participants && event.current_participants >= event.max_participants) return res.status(400).json({ error: 'Event is full' });
    await client.query('BEGIN');
    await client.query(`INSERT INTO event_registrations (event_id, student_id, registration_method) VALUES ($1, $2, 'Parent')`, [eventId, student_id]);
    await client.query('UPDATE events SET current_participants = current_participants + 1 WHERE id = $1', [eventId]);
    await client.query('COMMIT');
    res.json({ message: 'Successfully registered for event!' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/api/events/:eventId/register-manual', async (req, res) => { try { await pool.query(`INSERT INTO event_registrations (event_id, student_id, registration_method) VALUES ($1, $2, 'Manual')`, [req.params.eventId, req.body.student_id]); await pool.query('UPDATE events SET current_participants = current_participants + 1 WHERE id = $1', [req.params.eventId]); res.json({ message: 'Student registered successfully!' }); } catch (err) { res.status(500).json({ error: err.message }); } });

app.get('/api/events/:eventId/registrations', async (req, res) => { try { res.json((await pool.query(`SELECT er.*, s.name as student_name, s.grade, s.parent_name, s.parent_email FROM event_registrations er JOIN students s ON er.student_id = s.id WHERE er.event_id = $1`, [req.params.eventId])).rows); } catch (err) { res.status(500).json({ error: err.message }); } });

app.post('/api/events/:eventId/attendance', async (req, res) => { try { for(const record of req.body.attendanceData) await pool.query('UPDATE event_registrations SET attendance = $1 WHERE event_id = $2 AND student_id = $3', [record.attendance, req.params.eventId, record.student_id]); res.json({ message: 'Event attendance marked successfully!' }); } catch (err) { res.status(500).json({ error: err.message }); } });

app.delete('/api/events/:id', async (req, res) => { try { await pool.query('DELETE FROM events WHERE id = $1', [req.params.id]); res.json({ message: 'Event deleted successfully' }); } catch (err) { res.status(500).json({ error: err.message }); } });

app.get('/api/events/student/:studentId', async (req, res) => {
  try {
    const student = await pool.query('SELECT * FROM students WHERE id = $1', [req.params.studentId]).rows[0];
    const today = new Date().toISOString().split('T')[0];
    const events = await pool.query(`SELECT e.*, CASE WHEN er.id IS NOT NULL THEN true ELSE false END as is_registered FROM events e LEFT JOIN event_registrations er ON e.id = er.event_id AND er.student_id = $1 WHERE e.status = 'Active' AND e.event_date >= $2 AND (e.target_audience = 'All' OR (e.target_audience = 'Specific Grades' AND e.specific_grades LIKE '%' || $3 || '%')) ORDER BY e.event_date ASC`, [req.params.studentId, today, student.grade]);
    res.json(events.rows);
  } catch (err) { res.status(500).json({ error: err.message }); } });

app.get('/api/events/:id', async (req, res) => { try { const result = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]); if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' }); res.json(result.rows[0]); } catch (err) { res.status(500).json({ error: err.message }); } });

app.get('/api/email-logs', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM email_log ORDER BY sent_at DESC LIMIT 100'); res.json(r.rows); } catch (err) { res.status(500).json({ error: err.message }); } });

app.get('/api/sessions/:studentId', async (req, res) => {
  const id = req.adminStudentId || req.params.studentId;
  if(req.adminStudentId && req.adminStudentId != req.params.studentId) return res.status(403).json({ error: 'Access denied' });
  try { res.json((await pool.query('SELECT * FROM sessions WHERE student_id = $1 ORDER BY session_date ASC', [id])).rows); } catch (err) { res.status(500).json({ error: err.message }); } });

app.get('/api/sessions/past/all', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const p = await pool.query(`SELECT s.*, st.name as student_name, st.timezone, NULL as group_name FROM sessions s JOIN students st ON s.student_id = st.id WHERE s.session_date <= $1 AND s.session_type = 'Private' ORDER BY s.session_date DESC, s.session_time DESC LIMIT 50`, [today]);
    const g = await pool.query(`SELECT s.*, g.group_name as student_name, g.timezone, g.group_name FROM sessions s JOIN groups g ON s.group_id = g.id WHERE s.session_date <= $1 AND s.session_type = 'Group' ORDER BY s.session_date DESC, s.session_time DESC LIMIT 50`, [today]);
    const all = [...p.rows, ...g.rows].sort((a, b) => new Date(`${b.session_date}T${b.session_time}Z`) - new Date(`${a.session_date}T${a.session_time}Z`)).slice(0, 50);
    res.json(all);
  } catch (err) { res.status(500).json({ error: err.message }); } });

app.post('/api/parent/cancel-class', async (req, res) => {
  const id = req.adminStudentId || req.body.student_id;
  try {
    const session = (await pool.query('SELECT * FROM sessions WHERE id = $1 AND student_id = $2', [req.body.session_id, id])).rows[0];
    if(!session) return res.status(404).json({ error: 'Session not found' });
    const sessionTime = new Date(`${session.session_date}T${session.session_time}Z`);
    if((sessionTime - new Date()) < 2 * 60 * 60 * 1000) return res.status(400).json({ error: 'Cannot cancel class less than 2 hours before start.' });
    await pool.query('UPDATE sessions SET status = $1, cancelled_by = $2 WHERE id = $3', ['Cancelled by Parent', 'Parent', session.id]);
    await pool.query(`INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status) VALUES ($1, $2, $3, CURRENT_DATE, 'Available')`, [id, session.id, req.body.reason || 'Parent cancelled']);
    res.json({ message: 'Class cancelled! Makeup credit added.' });
  } catch (err) { res.status(500).json({ error: err.message }); } });

app.get('/api/students/:studentId/makeup-credits', async (req, res) => {
  const id = req.adminStudentId || req.params.studentId;
  try { res.json((await pool.query('SELECT * FROM makeup_classes WHERE student_id = $1 AND status = \'Available\'', [id])).rows); } catch (err) { res.status(500).json({ error: err.message }); } });

app.post('/api/parent/check-email', async (req, res) => { try { const s = (await pool.query('SELECT * FROM students WHERE parent_email = $1 AND is_active = true', [req.body.email])).rows; if(s.length===0) return res.status(404).json({ error: 'No student found.' }); const c = (await pool.query('SELECT password FROM parent_credentials WHERE parent_email = $1', [req.body.email])).rows[0]; res.json({ hasPassword: c && c.password ? true : false }); } catch(e) { res.status(500).json({error:e.message})} });

app.post('/api/parent/setup-password', async (req, res) => { try { const s = (await pool.query('SELECT * FROM students WHERE parent_email = $1 AND is_active = true', [req.body.email])).rows; const h = await bcrypt.hash(req.body.password, 10); await pool.query(`INSERT INTO parent_credentials (parent_email, password) VALUES ($1, $2) ON CONFLICT(parent_email) DO UPDATE SET password = $2`, [req.body.email, h]); res.json({ students: s }); } catch(e) { res.status(500).json({error:e.message})} });

app.post('/api/parent/login-password', async (req, res) => { try { const c = (await pool.query('SELECT password FROM parent_credentials WHERE parent_email = $1', [req.body.email])).rows[0]; if(!c || !(await bcrypt.compare(req.body.password, c.password))) return res.status(401).json({ error: 'Incorrect password' }); const s = (await pool.query('SELECT * FROM students WHERE parent_email = $1 AND is_active = true', [req.body.email])).rows; res.json({ students: s }); } catch(e) { res.status(500).json({error:e.message})} });

app.post('/api/parent/send-otp', async (req, res) => {
  try {
    const students = (await pool.query('SELECT * FROM students WHERE parent_email = $1 AND is_active = true', [req.body.email])).rows;
    if (students.length === 0) return res.status(404).json({ error: 'No student found' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const exp = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(`INSERT INTO parent_credentials (parent_email, otp, otp_expiry, otp_attempts) VALUES ($1, $2, $3, 0) ON CONFLICT(parent_email) DO UPDATE SET otp = $2, otp_expiry = $3, otp_attempts = 0`, [req.body.email, otp, exp]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/parent/verify-otp', async (req, res) => { try { const c = (await pool.query('SELECT otp, otp_expiry FROM parent_credentials WHERE parent_email = $1', [req.body.email])).rows[0]; if(!c || c.otp !== req.body.otp || new Date() > new Date(c.otp_expiry)) return res.status(401).json({ error: 'Invalid or Expired OTP' }); const s = (await pool.query('SELECT * FROM students WHERE parent_email = $1 AND is_active = true', [req.body.email])).rows; await pool.query('UPDATE parent_credentials SET otp = NULL, otp_expiry = NULL, otp_attempts = 0 WHERE parent_email = $1', [req.body.email]); res.json({ students: s }); } catch(e) { res.status(500).json({error:e.message})} });

app.listen(PORT, () => console.log(`🚀 LMS Running on port ${PORT}`));