// force rebuild - smtp switch - PostgreSQL Version
const moment = require('moment-timezone');
console.log("🚀 SERVER FILE STARTED");
const { Pool } = require('pg');
require('dotenv').config(); 
const axios = require('axios');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
console.log('🔍 EMAIL_USER:', process.env.EMAIL_USER);
console.log('🔍 BREVO_API_KEY loaded:', !!process.env.BREVO_API_KEY);
console.log('🌐 BASE_URL:', process.env.BASE_URL);

if (!process.env.BASE_URL) {
  console.error('❌ CRITICAL: BASE_URL is missing!');
  console.error('⚠️  Add BASE_URL in Render Environment Variables');
}

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const VERIFIED_SENDER_EMAIL = process.env.EMAIL_USER || 'fluentfeathersbyaaliya@gmail.com';
const VERIFIED_SENDER_NAME = 'Fluent Feathers Academy';

if (!BREVO_API_KEY) {
  console.error('❌ CRITICAL: BREVO_API_KEY is missing!');
}
if (!VERIFIED_SENDER_EMAIL) {
  console.error('❌ CRITICAL: EMAIL_USER (sender email) is missing!');
}

// PostgreSQL Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection error:', err);
  } else {
    console.log('✅ Connected to PostgreSQL database');
    release();
    initializeDatabase();
  }
});

// Helper function to convert ? to $1, $2, etc.
function convertQuery(sql, params) {
  let paramIndex = 1;
  const converted = sql.replace(/\?/g, () => `$${paramIndex++}`);
  return { sql: converted, params };
}

async function sendEmail(to, subject, html, recipientName, emailType) {
  try {
    console.log(`📧 [${emailType}] Sending to: ${to}`);

    await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: {
          name: VERIFIED_SENDER_NAME,
          email: VERIFIED_SENDER_EMAIL
        },
        to: [{ email: to, name: recipientName || to }],
        subject: subject,
        htmlContent: html
      },
      {
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Email sent via Brevo API');

    const { sql, params } = convertQuery(
      `INSERT INTO email_log (recipient_name, recipient_email, email_type, subject, status)
       VALUES (?, ?, ?, ?, 'Sent')`,
      [recipientName || '', to, emailType, subject]
    );
    
    pool.query(sql, params);

    return true;
  } catch (error) {
    console.error('❌ Brevo Email Error:', error.response?.data || error.message);
    return false;
  }
}

// ==================== TIMEZONE HELPER ====================
function convertToIST(dateString) {
  const date = new Date(dateString);
  return date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/uploads/homework/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'uploads', 'homework', req.params.filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    console.log('File not found:', filePath);
    res.status(404).send('File not found');
  }
});

// Create directories
const directories = ['uploads', 'uploads/materials', 'uploads/homework', 'uploads/settings'];
directories.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Initialize database
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS students (
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL,
      session_number INTEGER NOT NULL,
      session_date DATE NOT NULL,
      session_time TIME NOT NULL,
      session_start_utc TIMESTAMP,
      status TEXT DEFAULT 'Pending',
      attendance TEXT,
      cancelled_by TEXT,
      zoom_link TEXT,
      teacher_notes TEXT,
      parent_feedback TEXT,
      ppt_file_path TEXT,
      recording_file_path TEXT,
      homework_file_path TEXT,
      homework_grade TEXT,
      homework_comments TEXT,
      feedback_requested BOOLEAN DEFAULT FALSE,
      student_rating INTEGER,
      student_feedback TEXT,
      student_feedback_date TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    )`);

    // Ensure session_start_utc exists
    try {
      await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_start_utc TIMESTAMP`);
      await pool.query(`ALTER TABLE batch_sessions ADD COLUMN IF NOT EXISTS session_start_utc TIMESTAMP`);
    } catch (e) {}

    await pool.query(`CREATE TABLE IF NOT EXISTS materials (
      id SERIAL PRIMARY KEY,
      student_id INTEGER,
      batch_name TEXT,
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
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS makeup_classes (
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
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS payment_history (
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
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      event_name TEXT NOT NULL,
      event_description TEXT,
      event_date DATE NOT NULL,
      event_time TIME NOT NULL,
      duration TEXT NOT NULL,
      zoom_link TEXT NOT NULL,
      max_participants INTEGER DEFAULT 0,
      registration_deadline TIMESTAMP,
      event_status TEXT DEFAULT 'Upcoming',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS event_registrations (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      parent_name TEXT NOT NULL,
      parent_email TEXT NOT NULL,
      registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      attendance_status TEXT DEFAULT 'Registered',
      feedback_rating INTEGER,
      feedback_comments TEXT,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS email_log (
      id SERIAL PRIMARY KEY,
      recipient_name TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      email_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL,
      sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS batches (
      id SERIAL PRIMARY KEY,
      batch_name TEXT UNIQUE NOT NULL,
      batch_code TEXT UNIQUE NOT NULL,
      program_name TEXT NOT NULL,
      grade_level TEXT NOT NULL,
      class_type TEXT DEFAULT 'Group',
      duration TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      max_students INTEGER DEFAULT 10,
      current_students INTEGER DEFAULT 0,
      per_session_fee DECIMAL(10,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT '₹',
      zoom_link TEXT,
      status TEXT DEFAULT 'Active',
      start_date DATE,
      end_date DATE,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS admin_settings (
      id SERIAL PRIMARY KEY,
      admin_timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`INSERT INTO admin_settings (admin_timezone) SELECT 'Asia/Kolkata' WHERE NOT EXISTS (SELECT 1 FROM admin_settings LIMIT 1)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS batch_enrollments (
      id SERIAL PRIMARY KEY,
      batch_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      enrollment_date DATE NOT NULL,
      status TEXT DEFAULT 'Active',
      notes TEXT,
      FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      UNIQUE(batch_id, student_id)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS batch_sessions (
      id SERIAL PRIMARY KEY,
      batch_id INTEGER NOT NULL,
      session_number INTEGER NOT NULL,
      session_date DATE NOT NULL,
      session_time TIME NOT NULL,
      session_start_utc TIMESTAMP,
      status TEXT DEFAULT 'Pending',
      zoom_link TEXT,
      teacher_notes TEXT,
      ppt_file_path TEXT,
      recording_file_path TEXT,
      homework_file_path TEXT,
      homework_grade TEXT,
      homework_comments TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS batch_attendance (
      id SERIAL PRIMARY KEY,
      batch_session_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      attendance TEXT DEFAULT 'Pending',
      notes TEXT,
      homework_grade TEXT,
      homework_comments TEXT,
      marked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (batch_session_id) REFERENCES batch_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      UNIQUE(batch_session_id, student_id)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS parent_credentials (
      id SERIAL PRIMARY KEY,
      parent_email TEXT UNIQUE NOT NULL,
      password TEXT,
      otp TEXT,
      otp_expiry TIMESTAMP,
      otp_attempts INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP
    )`);

    // ✅ FIXED MIGRATION LOGIC (PREVENTS CRASHES)
    try {
      const privateSessions = await pool.query(`SELECT id, session_date, session_time FROM sessions WHERE session_start_utc IS NULL`);
      for (const s of privateSessions.rows) {
        // Fix: Explicitly format date as string to avoid Date object issues
        const dateStr = moment(s.session_date).format('YYYY-MM-DD');
        const utc = moment.tz(`${dateStr} ${s.session_time}`, 'YYYY-MM-DD HH:mm', 'Asia/Kolkata').utc().format();
        if (utc !== 'Invalid date') {
          await pool.query(`UPDATE sessions SET session_start_utc = $1 WHERE id = $2`, [utc, s.id]);
        }
      }
      
      const batchSessions = await pool.query(`SELECT id, session_date, session_time FROM batch_sessions WHERE session_start_utc IS NULL`);
      for (const s of batchSessions.rows) {
        // Fix: Explicitly format date as string
        const dateStr = moment(s.session_date).format('YYYY-MM-DD');
        const utc = moment.tz(`${dateStr} ${s.session_time}`, 'YYYY-MM-DD HH:mm', 'Asia/Kolkata').utc().format();
        if (utc !== 'Invalid date') {
          await pool.query(`UPDATE batch_sessions SET session_start_utc = $1 WHERE id = $2`, [utc, s.id]);
        }
      }
      console.log('✅ UTC Migration complete!');
    } catch (err) {
      console.error('⚠️ Migration warning (safe to ignore):', err.message);
    }

    console.log('✅ Enhanced database tables initialized');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  }
}

// Generate 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Simple hash
function hashPassword(password) {
  return Buffer.from(password).toString('base64');
}

function verifyPassword(inputPassword, storedHash) {
  const inputHash = Buffer.from(inputPassword).toString('base64');
  return inputHash === storedHash;
}

// Enhanced file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/homework/');
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ==================== DASHBOARD & STUDENT APIS ====================

app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const studentStats = await pool.query(`SELECT COUNT(*) as totalstudents, SUM(fees_paid) as totalrevenue FROM students`);
    const today = new Date().toISOString().split('T')[0];
    const sessionStats = await pool.query(`SELECT COUNT(*) as upcomingsessions FROM sessions WHERE status IN ('Pending', 'Scheduled') AND session_date >= $1`, [today]);
    const todayStats = await pool.query(`SELECT COUNT(*) as todaysessions FROM sessions WHERE session_date = $1`, [today]);
    const eventStats = await pool.query(`SELECT COUNT(*) as totalevents FROM events WHERE event_status = 'Upcoming'`);
    
    res.json({
      totalStudents: parseInt(studentStats.rows[0].totalstudents) || 0,
      totalRevenue: parseFloat(studentStats.rows[0].totalrevenue) || 0,
      upcomingSessions: parseInt(sessionStats.rows[0].upcomingsessions) || 0,
      todaySessions: parseInt(todayStats.rows[0].todaysessions) || 0,
      upcomingEvents: parseInt(eventStats.rows[0].totalevents) || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students', async (req, res) => {
  const { 
    name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, program_name, 
    class_type, duration, currency, per_session_fee, total_sessions 
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO students (
        name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, program_name, 
        class_type, duration, currency, per_session_fee, total_sessions, 
        completed_sessions, remaining_sessions, fees_paid
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, $13, 0) RETURNING id`,
      [name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, program_name, 
       class_type, duration, currency, per_session_fee, total_sessions]
    );

    const studentId = result.rows[0].id;

    // Send welcome email (Simplified for brevity)
    await sendEmail(parent_email, `Welcome to Fluent Feathers Academy - ${name}`, `<p>Welcome ${name}!</p>`, parent_name, 'Welcome');

    res.json({ success: true, message: `Student ${name} added successfully!`, studentId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/students/:id', async (req, res) => {
  const studentId = req.params.id;
  const { 
    name, grade, parent_name, parent_email, primary_contact, alternate_contact,
    timezone, program_name, class_type, duration, currency, 
    per_session_fee, total_sessions 
  } = req.body;

  try {
    await pool.query(
      `UPDATE students SET 
        name = $1, grade = $2, parent_name = $3, parent_email = $4,
        primary_contact = $5, alternate_contact = $6, timezone = $7,
        program_name = $8, class_type = $9, duration = $10, currency = $11,
        per_session_fee = $12, total_sessions = $13
        WHERE id = $14`,
      [name, grade, parent_name, parent_email, primary_contact, alternate_contact,
       timezone, program_name, class_type, duration, currency,
       per_session_fee, total_sessions, studentId]
    );
    res.json({ message: 'Student updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.* FROM students s ORDER BY s.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/:id/details', async (req, res) => {
  const studentId = req.params.id;
  try {
    const studentResult = await pool.query(`SELECT * FROM students WHERE id = $1`, [studentId]);
    if (studentResult.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    
    const paymentsResult = await pool.query(`SELECT * FROM payment_history WHERE student_id = $1 ORDER BY payment_date DESC`, [studentId]);
    const makeupResult = await pool.query(`SELECT * FROM makeup_classes WHERE student_id = $1 ORDER BY credit_date DESC`, [studentId]);
    const sessionsResult = await pool.query(`SELECT * FROM sessions WHERE student_id = $1 ORDER BY session_date DESC`, [studentId]);

    res.json({
      student: studentResult.rows[0],
      paymentHistory: paymentsResult.rows,
      makeupClasses: makeupResult.rows,
      sessions: sessionsResult.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM students WHERE id = $1`, [req.params.id]);
    res.json({ message: 'Student deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students/:id/payment', async (req, res) => {
  const { amount, currency, payment_method, receipt_number, sessions_covered, notes } = req.body;
  const studentId = req.params.id;
  const payment_date = new Date().toISOString().split('T')[0];

  try {
    await pool.query(
      `INSERT INTO payment_history (
        student_id, payment_date, amount, currency, payment_method, 
        receipt_number, sessions_covered, notes, payment_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Paid')`,
      [studentId, payment_date, amount, currency, payment_method, 
       receipt_number, sessions_covered, notes]
    );

    await pool.query(`UPDATE students SET fees_paid = fees_paid + $1 WHERE id = $2`, [amount, studentId]);
    res.json({ success: true, message: 'Payment recorded successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== PARENT PORTAL APIS (UPDATED) ====================

// ✅ FIX 1: Upcoming Classes (Date-based filter + Merged Results)
app.get('/api/parent/upcoming/:studentId', async (req, res) => {
  const { studentId } = req.params;
  const today = new Date().toISOString().split('T')[0];

  try {
    const privateResult = await pool.query(`
      SELECT id, session_number, session_date, session_time, session_start_utc, status, zoom_link, duration, 'Private' AS type, NULL AS batch_name
      FROM sessions
      WHERE student_id = $1 AND session_date >= $2 AND status IN ('Pending', 'Scheduled')
    `, [studentId, today]);

    const batchResult = await pool.query(`
      SELECT bs.id, bs.session_number, bs.session_date, bs.session_time, bs.session_start_utc, bs.status, bs.zoom_link, bs.duration, 'Batch' AS type, b.batch_name
      FROM batch_sessions bs
      JOIN batches b ON b.id = bs.batch_id
      JOIN batch_enrollments be ON be.batch_id = b.id
      WHERE be.student_id = $1 AND be.status = 'Active' AND bs.session_date >= $2 AND bs.status IN ('Pending', 'Scheduled')
    `, [studentId, today]);

    const combined = [...privateResult.rows, ...batchResult.rows]
      .sort((a, b) => new Date(a.session_start_utc) - new Date(b.session_start_utc));

    res.json(combined);
  } catch (err) {
    console.error('Upcoming classes error:', err);
    res.status(500).json([]);
  }
});

// ✅ FIX 2: Cancellation (Handles Private & Batch)
app.post('/api/parent/cancel-upcoming-class', async (req, res) => {
  const { student_id, session_id, type, reason } = req.body;

  try {
    const studentResult = await pool.query(`SELECT * FROM students WHERE id = $1`, [student_id]);
    if (studentResult.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    const student = studentResult.rows[0];

    if (type === 'Private') {
      // Private Class Cancellation
      const sessionResult = await pool.query(
        `SELECT * FROM sessions WHERE id = $1 AND student_id = $2 AND status IN ('Pending', 'Scheduled')`,
        [session_id, student_id]
      );

      if (sessionResult.rows.length === 0) return res.status(404).json({ error: 'Session not found or already cancelled' });
      const session = sessionResult.rows[0];

      await pool.query(`UPDATE sessions SET status = 'Cancelled by Parent', cancelled_by = 'Parent' WHERE id = $1`, [session.id]);
      await pool.query(
        `INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status, notes)
         VALUES ($1, $2, $3, $4, 'Available', 'Private Cancellation')`,
        [student_id, session.id, reason || 'Parent Cancelled', session.session_date]
      );
      
    } else {
      // Batch Class Cancellation
      const batchSessionResult = await pool.query(`SELECT * FROM batch_sessions WHERE id = $1`, [session_id]);
      if (batchSessionResult.rows.length === 0) return res.status(404).json({ error: 'Batch Session not found' });
      const session = batchSessionResult.rows[0];

      await pool.query(
        `INSERT INTO batch_attendance (batch_session_id, student_id, attendance, notes)
         VALUES ($1, $2, 'Cancelled by Parent', 'Makeup Credit Issued')
         ON CONFLICT (batch_session_id, student_id) DO UPDATE SET attendance = 'Cancelled by Parent'`,
        [session_id, student_id]
      );

      await pool.query(
        `INSERT INTO makeup_classes (student_id, reason, credit_date, status, notes)
         VALUES ($1, $2, $3, 'Available', 'Batch Class Cancelled')`,
        [student_id, reason || 'Batch Cancelled', session.session_date]
      );
    }

    // Refund credit
    await pool.query(`UPDATE students SET remaining_sessions = remaining_sessions + 1 WHERE id = $1`, [student_id]);

    await sendEmail(
      student.parent_email,
      `✅ Class Cancelled - ${new Date().toISOString().split('T')[0]}`,
      `<p>Your class has been cancelled. A makeup credit has been added.</p>`,
      student.parent_name,
      'Parent Cancellation'
    );

    res.json({ message: 'Class cancelled successfully! Makeup credit added.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ FIX 3: Parent Authentication
app.post('/api/parent/check-email', async (req, res) => {
  const { email } = req.body;
  try {
    const studentResult = await pool.query(`SELECT * FROM students WHERE parent_email = $1`, [email]);
    if (studentResult.rows.length === 0) return res.status(404).json({ error: 'No student found' });
    
    const credResult = await pool.query(`SELECT * FROM parent_credentials WHERE parent_email = $1`, [email]);
    res.json({ exists: true, hasPassword: credResult.rows.length > 0 && credResult.rows[0].password ? true : false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/parent/login-password', async (req, res) => {
  const { email, password } = req.body;
  try {
    const credResult = await pool.query(`SELECT * FROM parent_credentials WHERE parent_email = $1`, [email]);
    if (credResult.rows.length === 0 || !credResult.rows[0].password) return res.status(404).json({ error: 'Password not set' });
    if (!verifyPassword(password, credResult.rows[0].password)) return res.status(401).json({ error: 'Incorrect password' });
    
    const studentResult = await pool.query(`SELECT * FROM students WHERE parent_email = $1`, [email]);
    res.json({ message: 'Login successful', student: studentResult.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/parent/setup-password', async (req, res) => {
  const { email, password } = req.body;
  try {
    const studentResult = await pool.query(`SELECT * FROM students WHERE parent_email = $1`, [email]);
    if (studentResult.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    
    await pool.query(
      `INSERT INTO parent_credentials (parent_email, password) VALUES ($1, $2) 
       ON CONFLICT(parent_email) DO UPDATE SET password = $2`,
      [email, hashPassword(password)]
    );
    res.json({ message: 'Password set', student: studentResult.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/parent/send-otp', async (req, res) => {
  const { email } = req.body;
  try {
    const studentResult = await pool.query(`SELECT * FROM students WHERE parent_email = $1`, [email]);
    if (studentResult.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    
    const otp = generateOTP();
    const expiry = new Date(Date.now() + 10 * 60 * 1000);
    
    await pool.query(
      `INSERT INTO parent_credentials (parent_email, otp, otp_expiry) VALUES ($1, $2, $3) 
       ON CONFLICT(parent_email) DO UPDATE SET otp = $2, otp_expiry = $3`,
      [email, otp, expiry]
    );
    
    await sendEmail(email, '🔐 Login OTP', `<p>Your OTP is: <strong>${otp}</strong></p>`, studentResult.rows[0].parent_name, 'OTP');
    res.json({ message: 'OTP sent' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/parent/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  try {
    const credResult = await pool.query(`SELECT * FROM parent_credentials WHERE parent_email = $1`, [email]);
    if (credResult.rows.length === 0 || credResult.rows[0].otp !== otp) return res.status(401).json({ error: 'Invalid OTP' });
    
    const studentResult = await pool.query(`SELECT * FROM students WHERE parent_email = $1`, [email]);
    res.json({ message: 'Login successful', student: studentResult.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== BATCH MANAGEMENT ====================

app.post('/api/batches', async (req, res) => {
  const { batch_name, batch_code, program_name, grade_level, duration, timezone, max_students, currency, per_session_fee, zoom_link, start_date, end_date, description } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO batches (batch_name, batch_code, program_name, grade_level, duration, timezone, max_students, currency, per_session_fee, zoom_link, start_date, end_date, description, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'Active') RETURNING id`,
      [batch_name, batch_code, program_name, grade_level, duration, timezone, max_students, currency, per_session_fee, zoom_link, start_date, end_date, description]
    );
    res.json({ message: 'Batch created!', batchId: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/batches', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, COUNT(DISTINCT be.student_id) as enrolled_students FROM batches b 
       LEFT JOIN batch_enrollments be ON b.id = be.batch_id AND be.status = 'Active' 
       GROUP BY b.id ORDER BY b.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/batches/:id/details', async (req, res) => {
  const batchId = req.params.id;
  try {
    const batchResult = await pool.query(
      `SELECT b.*, COUNT(DISTINCT be.student_id) as enrolled_students FROM batches b 
       LEFT JOIN batch_enrollments be ON b.id = be.batch_id AND be.status = 'Active' 
       WHERE b.id = $1 GROUP BY b.id`, [batchId]
    );
    if (batchResult.rows.length === 0) return res.status(404).json({ error: 'Batch not found' });
    
    const enrollments = await pool.query(
      `SELECT be.*, s.name, s.grade, s.parent_name, s.parent_email, s.timezone FROM batch_enrollments be 
       JOIN students s ON be.student_id = s.id WHERE be.batch_id = $1`, [batchId]
    );
    
    const sessions = await pool.query(`SELECT * FROM batch_sessions WHERE batch_id = $1 ORDER BY session_date ASC`, [batchId]);
    res.json({ batch: batchResult.rows[0], enrollments: enrollments.rows, sessions: sessions.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/batches/:batchId/enroll', async (req, res) => {
  const { batchId } = req.params;
  const { student_id, notes } = req.body;
  const enrollment_date = new Date().toISOString().split('T')[0];
  try {
    await pool.query(
      `INSERT INTO batch_enrollments (batch_id, student_id, enrollment_date, notes, status) VALUES ($1, $2, $3, $4, 'Active')`,
      [batchId, student_id, enrollment_date, notes]
    );
    res.json({ message: 'Enrolled successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ✅ FIX 4: Batch Scheduling (Added delay loop)
app.post('/api/batches/:batchId/schedule', async (req, res) => {
  const { batchId } = req.params;
  const { sessions } = req.body;
  try {
    const batchResult = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = batchResult.rows[0];
    const countResult = await pool.query('SELECT COUNT(*) as count FROM batch_sessions WHERE batch_id = $1', [batchId]);
    let sessionNumber = parseInt(countResult.rows[0].count) + 1;

    for (const session of sessions) {
      const sessionStartUTC = moment.tz(`${session.date} ${session.time}`, 'YYYY-MM-DD HH:mm', 'Asia/Kolkata').utc().format();
      await pool.query(
        `INSERT INTO batch_sessions (batch_id, session_number, session_date, session_time, session_start_utc, zoom_link, status) VALUES ($1, $2, $3, $4, $5, $6, 'Pending')`,
        [batchId, sessionNumber, session.date, session.time, sessionStartUTC, batch.zoom_link]
      );
      sessionNumber++;
    }

    // Notify Students (with delay)
    const students = await pool.query(`SELECT s.* FROM students s JOIN batch_enrollments be ON s.id = be.student_id WHERE be.batch_id = $1`, [batchId]);
    for (const student of students.rows) {
      await sendEmail(student.parent_email, `New Schedule - ${batch.batch_name}`, `<p>New classes scheduled.</p>`, student.parent_name, 'Schedule');
      await new Promise(r => setTimeout(r, 500)); // Delay
    }

    res.json({ success: true, message: 'Batch sessions scheduled!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== SESSION MANAGEMENT ====================

app.post('/api/schedule/classes', async (req, res) => {
  const { student_id, classes } = req.body;
  const ZOOM_LINK = 'https://us04web.zoom.us/j/7288533155?pwd=Nng5N2l0aU12L0FQK245c0VVVHJBUT09';
  try {
    const countResult = await pool.query(`SELECT COUNT(*) as count FROM sessions WHERE student_id = $1`, [student_id]);
    let sessionNumber = parseInt(countResult.rows[0].count) + 1;

    for (const cls of classes) {
      const sessionStartUTC = moment.tz(`${cls.date} ${cls.time}`, 'YYYY-MM-DD HH:mm', 'Asia/Kolkata').utc().format();
      await pool.query(
        `INSERT INTO sessions (student_id, session_number, session_date, session_time, session_start_utc, zoom_link, status) VALUES ($1, $2, $3, $4, $5, $6, 'Pending')`,
        [student_id, sessionNumber, cls.date, cls.time, sessionStartUTC, ZOOM_LINK]
      );
      sessionNumber++;
    }

    const studentResult = await pool.query(`SELECT * FROM students WHERE id = $1`, [student_id]);
    const student = studentResult.rows[0];
    await sendEmail(student.parent_email, 'New Class Schedule', '<p>New classes have been added.</p>', student.parent_name, 'Schedule');

    res.json({ message: 'Classes scheduled successfully!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete private session
app.delete('/api/sessions/:sessionId', async (req, res) => {
  try {
    await pool.query('DELETE FROM sessions WHERE id = $1', [req.params.sessionId]);
    res.json({ message: 'Session deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete batch session
app.delete('/api/batches/sessions/:sessionId', async (req, res) => {
  try {
    await pool.query('DELETE FROM batch_sessions WHERE id = $1', [req.params.sessionId]);
    res.json({ message: 'Batch session deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get sessions for admin
app.get('/api/sessions/:studentId', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM sessions WHERE student_id = $1 ORDER BY session_number ASC`, [req.params.studentId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== MATERIAL & HOMEWORK ====================

app.post('/api/upload/material/:studentId', upload.single('file'), async (req, res) => {
  const { fileType, sessionDate, uploadType } = req.body;
  const studentId = req.params.studentId;
  if (!req.file) return res.status(400).json({ error: 'No file' });

  try {
    await pool.query(
      `INSERT INTO materials (student_id, session_date, file_type, file_name, file_path, uploaded_by) VALUES ($1, $2, $3, $4, $5, 'Teacher')`,
      [studentId, sessionDate, fileType, req.file.originalname, req.file.filename]
    );
    res.json({ message: 'Material uploaded' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/upload/homework/:studentId', upload.single('file'), async (req, res) => {
  const { sessionDate } = req.body;
  const studentId = req.params.studentId;
  try {
    await pool.query(
      `INSERT INTO materials (student_id, session_date, file_type, file_name, file_path, uploaded_by) VALUES ($1, $2, 'Homework', $3, $4, 'Parent')`,
      [studentId, sessionDate, req.file.originalname, req.file.filename]
    );
    res.json({ message: 'Homework uploaded' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/materials/:studentId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.* FROM materials m 
       WHERE m.student_id = $1 
       OR m.batch_name IN (SELECT b.batch_name FROM batches b JOIN batch_enrollments be ON b.id = be.batch_id WHERE be.student_id = $1 AND be.status = 'Active') 
       ORDER BY m.uploaded_at DESC`,
      [req.params.studentId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/materials/all/admin', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM materials ORDER BY uploaded_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/materials/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM materials WHERE id = $1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== FEEDBACK ====================

app.get('/api/students/:studentId/pending-feedback', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id FROM sessions WHERE student_id = $1 AND feedback_requested = TRUE AND student_rating IS NULL LIMIT 1`,
      [req.params.studentId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sessions/:sessionId/feedback', async (req, res) => {
  const { rating, comment } = req.body;
  try {
    await pool.query(
      `UPDATE sessions SET student_rating = $1, student_feedback = $2, student_feedback_date = CURRENT_TIMESTAMP WHERE id = $3`,
      [rating, comment, req.params.sessionId]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/ratings', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, st.name as student_name FROM sessions s JOIN students st ON s.student_id = st.id WHERE s.student_rating IS NOT NULL`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== EVENTS ====================

app.post('/api/events', async (req, res) => {
  const { event_type, event_name, event_description, event_date, event_time, duration, zoom_link, max_participants } = req.body;
  try {
    await pool.query(
      `INSERT INTO events (event_type, event_name, event_description, event_date, event_time, duration, zoom_link, max_participants) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [event_type, event_name, event_description, event_date, event_time, duration, zoom_link, max_participants]
    );
    // Send emails logic (omitted for brevity)
    res.json({ message: 'Event created' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/events', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.*, COUNT(er.id) as registered_count FROM events e LEFT JOIN event_registrations er ON e.id = er.event_id GROUP BY e.id`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM events WHERE id = $1', [req.params.id]);
    res.json({ message: 'Event deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/emails/log', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM email_log ORDER BY sent_at DESC LIMIT 100`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== AUTOMATED REMINDERS (UPDATED WITH DELAY) ====================

// 24 Hour Reminder
cron.schedule('0 9 * * *', async () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = tomorrow.toISOString().split('T')[0];
  try {
    const result = await pool.query(
      `SELECT s.*, st.parent_email, st.parent_name FROM sessions s JOIN students st ON s.student_id = st.id WHERE s.session_date = $1 AND s.status IN ('Pending', 'Scheduled')`,
      [tomorrowDate]
    );
    for (const session of result.rows) {
      await sendEmail(session.parent_email, 'Class Tomorrow', `<p>Reminder for class tomorrow.</p>`, session.parent_name, '24h Reminder');
      await new Promise(r => setTimeout(r, 1000)); // Delay
    }
  } catch (err) { console.error(err); }
});

// 1 Hour Reminder
cron.schedule('0 * * * *', async () => {
  const istNow = moment().tz('Asia/Kolkata');
  const istOneHourLater = istNow.clone().add(1, 'hour');
  const currentDate = istOneHourLater.format('YYYY-MM-DD');
  const targetTime = istOneHourLater.format('HH:mm');

  try {
    const result = await pool.query(
      `SELECT s.*, st.parent_email, st.parent_name FROM sessions s JOIN students st ON s.student_id = st.id WHERE s.session_date = $1 AND s.session_time = $2 AND s.status IN ('Pending', 'Scheduled')`,
      [currentDate, targetTime]
    );
    for (const session of result.rows) {
      await sendEmail(session.parent_email, 'Class in 1 Hour', `<p>Class starting soon.</p>`, session.parent_name, '1h Reminder');
      await new Promise(r => setTimeout(r, 1000)); // Delay
    }
  } catch (err) { console.error(err); }
});

app.get('*', (req, res) => {
  if (req.originalUrl.startsWith('/api/')) return res.status(404).json([]);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ SERVER RUNNING ON PORT ${PORT}`);
});