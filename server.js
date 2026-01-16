// ==================== SIMPLIFIED LMS - SERVER.JS ====================
console.log("🚀 Starting Simplified LMS Server...");

const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== DATABASE CONNECTION ====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection error:', err);
  } else {
    console.log('✅ Connected to PostgreSQL');
    release();
    initializeDatabase();
  }
});

// ==================== MIDDLEWARE ====================
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Create upload directories
['uploads', 'uploads/materials', 'uploads/homework'].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ==================== FILE UPLOAD SETUP ====================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dest = req.body.uploadType === 'homework' ? 'uploads/homework/' : 'uploads/materials/';
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|ppt|pptx|mp4|mp3|zip|rar/;
    const extName = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimeType = allowedTypes.test(file.mimetype);
    if (mimeType && extName) {
      return cb(null, true);
    }
    cb(new Error('Invalid file type'));
  }
});

// ==================== DATABASE INITIALIZATION ====================
async function initializeDatabase() {
  try {
    // Students table
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
      )
    `);
await pool.query(`
  ALTER TABLE students 
  ADD COLUMN IF NOT EXISTS group_name TEXT
`);
    // Sessions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
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
        homework_grade TEXT,
        homework_comments TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    // Materials table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS materials (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
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
      )
    `);

    // Makeup classes table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS makeup_classes (
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

    // Payment history table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_history (
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

    // Email log table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_log (
        id SERIAL PRIMARY KEY,
        recipient_name TEXT NOT NULL,
        recipient_email TEXT NOT NULL,
        email_type TEXT NOT NULL,
        subject TEXT NOT NULL,
        status TEXT NOT NULL,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Parent credentials table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS parent_credentials (
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

    console.log('✅ Database tables initialized');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  }
}
// ==================== SESSION VALIDATION ====================
function validateParentSession(req, res, next) {
  // Basic email validation - in production use JWT
  const email = req.headers['x-parent-email'];
  if (!email) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// For development - bypass validation
function bypassValidation(req, res, next) {
  next();
}
// ==================== TIMEZONE HELPERS ====================
// Convert IST (admin input) to UTC (database storage)
function istToUTC(dateStr, timeStr) {
  try {
    // ✅ Validate inputs
    if (!dateStr || !timeStr) {
      throw new Error('Date or time is missing');
    }
    
    // ✅ Clean date format (remove any time component)
    const cleanDate = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
    
    // ✅ Clean time format (ensure HH:MM or HH:MM:SS)
    let cleanTime = timeStr.trim();
    if (cleanTime.length === 5) cleanTime += ':00'; // Add seconds if missing
    
    const isoString = `${cleanDate}T${cleanTime}+05:30`;
    const date = new Date(isoString);
    
    // ✅ Check if date is valid
    if (isNaN(date.getTime())) {
      console.error('❌ Invalid IST datetime:', dateStr, timeStr);
      return { date: cleanDate, time: cleanTime.substring(0, 5) };
    }
    
    const utcDate = date.toISOString().split('T')[0];
    const utcTime = date.toISOString().split('T')[1].substring(0, 8); // HH:MM:SS
    
    console.log(`🌍 IST->UTC: ${cleanDate} ${cleanTime} -> ${utcDate} ${utcTime}`);
    
    return { date: utcDate, time: utcTime };
  } catch (error) {
    console.error('❌ IST to UTC conversion error:', error);
    const cleanDate = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
    return { date: cleanDate, time: timeStr };
  }
}

function utcToTimezone(utcDate, utcTime, timezone) {
  try {
    // ✅ Validate inputs
    if (!utcDate || !utcTime || !timezone) {
      throw new Error('Missing UTC date, time, or timezone');
    }
    
    // ✅ Clean date (remove time component if present)
    const cleanDate = utcDate.includes('T') ? utcDate.split('T')[0] : utcDate;
    
    // ✅ Clean time (ensure proper format)
    const cleanTime = utcTime.length === 5 ? utcTime + ':00' : utcTime.substring(0, 8);
    
    const isoString = `${cleanDate}T${cleanTime}Z`;
    const date = new Date(isoString);
    
    // ✅ Check if date is valid
    if (isNaN(date.getTime())) {
      console.error('❌ Invalid UTC datetime:', utcDate, utcTime);
      return { time: utcTime, date: utcDate, day: '' };
    }
    
    const time = date.toLocaleTimeString('en-US', {
      timeZone: timezone,
      hour12: true,
      hour: '2-digit',
      minute: '2-digit'
    });
    
    const dateStr = date.toLocaleDateString('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
    
    const day = date.toLocaleDateString('en-US', {
      timeZone: timezone,
      weekday: 'short'
    });
    
    console.log(`🌍 UTC->TZ: ${utcDate} ${utcTime} -> ${dateStr} ${time} (${timezone})`);
    
    return { time, date: dateStr, day };
  } catch (error) {
    console.error('❌ UTC to timezone conversion error:', error);
    return { time: utcTime, date: utcDate, day: '' };
  }
}

// ==================== EMAIL SYSTEM ====================
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const VERIFIED_SENDER_EMAIL = process.env.EMAIL_USER || 'your-email@gmail.com';
const VERIFIED_SENDER_NAME = 'Fluent Feathers Academy';

async function sendEmail(to, subject, html, recipientName, emailType) {
  try {
    console.log(`📧 Sending ${emailType} to: ${to}`);

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
          'api-key': BREVO_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Email sent successfully');

    // Log email
    await pool.query(
      `INSERT INTO email_log (recipient_name, recipient_email, email_type, subject, status)
       VALUES ($1, $2, $3, $4, 'Sent')`,
      [recipientName || '', to, emailType, subject]
    );

    return true;
  } catch (error) {
    console.error('❌ Email Error:', error.response?.data || error.message);
    return false;
  }
}

// Email templates
function getWelcomeEmail(data) {
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="font-family: Arial, sans-serif; background: #f4f7fa; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px;">
        <h1 style="color: #667eea; text-align: center;">🎓 Welcome to Fluent Feathers Academy!</h1>
        <p>Dear ${data.parent_name},</p>
        <p>We're excited to welcome <strong>${data.student_name}</strong> to our ${data.program_name} program!</p>
        
        <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="color: #667eea;">📋 Enrollment Details</h3>
          <p><strong>Student:</strong> ${data.student_name}</p>
          <p><strong>Grade:</strong> ${data.grade}</p>
          <p><strong>Program:</strong> ${data.program_name}</p>
          <p><strong>Class Type:</strong> ${data.class_type}</p>
          <p><strong>Duration:</strong> ${data.duration}</p>
          <p><strong>Total Sessions:</strong> ${data.total_sessions}</p>
          <p><strong>Your Timezone:</strong> ${data.timezone}</p>
        </div>

        <div style="text-align: center; margin: 30px 0;">
          <a href="${data.zoom_link}" style="display: inline-block; background: #667eea; color: white; padding: 15px 40px; text-decoration: none; border-radius: 25px; font-weight: bold;">🎥 Join Zoom Class</a>
        </div>

        <p style="color: #667eea; font-weight: bold; text-align: center;">Best regards,<br>Fluent Feathers Academy Team</p>
      </div>
    </body>
    </html>
  `;
}

function getScheduleEmail(data) {
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="font-family: Arial, sans-serif; background: #f4f7fa; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px;">
        <h1 style="color: #667eea; text-align: center;">📅 Class Schedule</h1>
        <p>Dear ${data.parent_name},</p>
        <p>Here's the schedule for <strong>${data.student_name}</strong>:</p>
        
        <div style="background: #d1ecf1; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 5px solid #17a2b8;">
          <p style="margin: 0; color: #0c5460;">
            <strong>🌍 Timezone:</strong> All times shown are in <strong>${data.timezone}</strong>
          </p>
        </div>
        
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr style="background: #667eea; color: white;">
            <th style="padding: 10px; border: 1px solid #ddd;">Session #</th>
            <th style="padding: 10px; border: 1px solid #ddd;">Date</th>
            <th style="padding: 10px; border: 1px solid #ddd;">Time</th>
          </tr>
          ${data.schedule_rows}
        </table>

        <p style="color: #667eea; font-weight: bold; text-align: center;">Best regards,<br>Fluent Feathers Academy Team</p>
      </div>
    </body>
    </html>
  `;
}

// ==================== API ROUTES ====================

// Dashboard stats
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const studentStats = await pool.query('SELECT COUNT(*) as total, SUM(fees_paid) as revenue FROM students');
    const sessionStats = await pool.query(
      `SELECT COUNT(*) as upcoming FROM sessions WHERE status IN ('Pending', 'Scheduled') AND session_date >= CURRENT_DATE`
    );
    
    res.json({
      totalStudents: parseInt(studentStats.rows[0].total) || 0,
      totalRevenue: parseFloat(studentStats.rows[0].revenue) || 0,
      upcomingSessions: parseInt(sessionStats.rows[0].upcoming) || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all students
app.get('/api/students', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, 
        COUNT(m.id) as makeup_credits
       FROM students s 
       LEFT JOIN makeup_classes m ON s.id = m.student_id AND m.status = 'Available'
       GROUP BY s.id 
       ORDER BY s.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new student
app.post('/api/students', async (req, res) => {
  const { 
    name, grade, parent_name, parent_email, primary_contact, alternate_contact, 
    timezone, program_name, class_type, duration, currency, per_session_fee, total_sessions 
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO students (
        name, grade, parent_name, parent_email, primary_contact, alternate_contact, 
        timezone, program_name, class_type, duration, currency, per_session_fee, 
        total_sessions, completed_sessions, remaining_sessions, fees_paid
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, $13, 0) 
      RETURNING id`,
      [name, grade, parent_name, parent_email, primary_contact, alternate_contact, 
       timezone, program_name, class_type, duration, currency, per_session_fee, total_sessions]
    );

    const studentId = result.rows[0].id;

    // Send welcome email
    const emailData = {
      parent_name, 
      student_name: name, 
      grade, 
      program_name, 
      class_type, 
      duration, 
      total_sessions, 
      timezone,
      zoom_link: 'https://us04web.zoom.us/j/7288533155?pwd=Nng5N2l0aU12L0FQK245c0VVVHJBUT09'
    };

    await sendEmail(
      parent_email, 
      `Welcome to Fluent Feathers Academy - ${name}`, 
      getWelcomeEmail(emailData), 
      parent_name, 
      'Welcome'
    );

    res.json({ success: true, message: `Student added successfully! Welcome email sent.`, studentId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update student
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

// Delete student
app.delete('/api/students/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM students WHERE id = $1', [req.params.id]);
    res.json({ message: 'Student deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get student details
app.get('/api/students/:id/details', async (req, res) => {
  try {
    const student = await pool.query('SELECT * FROM students WHERE id = $1', [req.params.id]);
    const payments = await pool.query(
      'SELECT * FROM payment_history WHERE student_id = $1 ORDER BY payment_date DESC', 
      [req.params.id]
    );
    const makeupClasses = await pool.query(
      'SELECT * FROM makeup_classes WHERE student_id = $1 ORDER BY credit_date DESC', 
      [req.params.id]
    );
    const sessions = await pool.query(
      'SELECT * FROM sessions WHERE student_id = $1 ORDER BY session_date DESC', 
      [req.params.id]
    );

    res.json({
      student: student.rows[0],
      paymentHistory: payments.rows,
      makeupClasses: makeupClasses.rows,
      sessions: sessions.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record payment
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

    await pool.query(
      'UPDATE students SET fees_paid = fees_paid + $1 WHERE id = $2',
      [amount, studentId]
    );
    
    res.json({ success: true, message: 'Payment recorded successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Schedule classes
app.post('/api/schedule/classes', async (req, res) => {
  const { student_id, classes } = req.body;

  try {
    const student = (await pool.query('SELECT * FROM students WHERE id = $1', [student_id])).rows[0];
    
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }
    
    const count = (await pool.query('SELECT COUNT(*) as count FROM sessions WHERE student_id = $1', [student_id])).rows[0].count;
    let sessionNumber = parseInt(count) + 1;

    const zoomLink = 'https://us04web.zoom.us/j/7288533155?pwd=Nng5N2l0aU12L0FQK245c0VVVHJBUT09';
    const scheduledClasses = [];

    for (const cls of classes) {
      // ✅ FIXED: Validate date and time format
      if (!cls.date || !cls.time) {
        console.error('Invalid class data:', cls);
        continue;
      }
      
      // Convert IST to UTC for storage
      const utc = istToUTC(cls.date, cls.time);
      
      console.log(`📅 Scheduling: IST ${cls.date} ${cls.time} -> UTC ${utc.date} ${utc.time}`);
      
      await pool.query(
        `INSERT INTO sessions (
          student_id, session_number, session_date, session_time, zoom_link, status
        ) VALUES ($1, $2, $3::date, $4::time, $5, 'Pending')`,
        [student_id, sessionNumber, utc.date, utc.time, zoomLink]
      );
      
      scheduledClasses.push({ ...cls, session_number: sessionNumber });
      sessionNumber++;
    }

    if (scheduledClasses.length === 0) {
      return res.status(400).json({ error: 'No valid classes to schedule' });
    }

    // Generate email schedule rows
    const rows = scheduledClasses.map((cls, i) => {
      const utc = istToUTC(cls.date, cls.time);
      const display = utcToTimezone(utc.date, utc.time, student.timezone);
      
      return `
        <tr style="background: ${i % 2 === 0 ? '#f8f9fa' : 'white'};">
          <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">
            <strong>Session ${parseInt(count) + i + 1}</strong>
          </td>
          <td style="padding: 10px; border: 1px solid #ddd;">
            ${display.day}, ${display.date}
          </td>
          <td style="padding: 10px; border: 1px solid #ddd;">
            <strong style="color: #667eea; font-size: 1.1rem;">${display.time}</strong>
            <br>
            <small style="color: #718096;">(${student.timezone})</small>
          </td>
        </tr>
      `;
    }).join('');

    // Send schedule email
    await sendEmail(
      student.parent_email,
      `📅 Class Schedule - ${student.name}`,
      getScheduleEmail({
        parent_name: student.parent_name,
        student_name: student.name,
        timezone: student.timezone,
        schedule_rows: rows
      }),
      student.parent_name,
      'Schedule'
    );

    res.json({ message: `${scheduledClasses.length} classes scheduled. Email sent to ${student.parent_email}.` });
  } catch (err) {
    console.error('Schedule error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get sessions for student (admin view)
app.get('/api/sessions/:studentId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sessions WHERE student_id = $1 ORDER BY session_date ASC, session_time ASC',
      [req.params.studentId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark attendance
app.post('/api/sessions/:sessionId/attendance', async (req, res) => {
  const { attendance } = req.body;
  const sessionId = req.params.sessionId;

  try {
    await pool.query(
      'UPDATE sessions SET status = $1, attendance = $2 WHERE id = $3',
      [attendance === 'Present' ? 'Completed' : 'Missed', attendance, sessionId]
    );

    if (attendance === 'Present') {
      const session = (await pool.query('SELECT student_id FROM sessions WHERE id = $1', [sessionId])).rows[0];
      await pool.query(
        `UPDATE students SET 
          completed_sessions = completed_sessions + 1, 
          remaining_sessions = GREATEST(remaining_sessions - 1, 0)
         WHERE id = $1`,
        [session.student_id]
      );
    }

    res.json({ message: 'Attendance marked successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload session material
app.post('/api/sessions/:sessionId/upload', upload.single('file'), async (req, res) => {
  const sessionId = req.params.sessionId;
  const { materialType } = req.body;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    let column = '';
    if (materialType === 'ppt') column = 'ppt_file_path';
    else if (materialType === 'recording') column = 'recording_file_path';
    else if (materialType === 'homework') column = 'homework_file_path';
    else return res.status(400).json({ error: 'Invalid material type' });

    await pool.query(
      `UPDATE sessions SET ${column} = $1 WHERE id = $2`,
      [req.file.filename, sessionId]
    );

    res.json({ message: 'Material uploaded successfully!', filename: req.file.filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add teacher notes
app.put('/api/sessions/:sessionId/notes', async (req, res) => {
  const { teacher_notes } = req.body;
  try {
    await pool.query(
      'UPDATE sessions SET teacher_notes = $1 WHERE id = $2',
      [teacher_notes, req.params.sessionId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Grade homework
app.post('/api/sessions/:sessionId/grade', async (req, res) => {
  const { grade, comments } = req.body;
  const sessionId = req.params.sessionId;

  try {
    await pool.query(
      'UPDATE sessions SET homework_grade = $1, homework_comments = $2 WHERE id = $3',
      [grade, comments, sessionId]
    );

    res.json({ message: 'Homework graded successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get materials for student
app.get('/api/materials/:studentId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM materials WHERE student_id = $1 ORDER BY uploaded_at DESC',
      [req.params.studentId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload homework (parent)
app.post('/api/upload/homework/:studentId', upload.single('file'), async (req, res) => {
  const { sessionDate } = req.body;
  const studentId = req.params.studentId;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    await pool.query(
      `INSERT INTO materials (
        student_id, session_date, file_type, file_name, file_path, uploaded_by
      ) VALUES ($1, $2, 'Homework', $3, $4, 'Parent')`,
      [studentId, sessionDate, req.file.originalname, req.file.filename]
    );

    res.json({ message: 'Homework uploaded successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel class (parent)
app.post('/api/parent/cancel-class', async (req, res) => {
  const { student_id, session_date, session_time, reason } = req.body;

  try {
   const session = (await pool.query(
      'SELECT * FROM sessions WHERE student_id = $1 AND session_date = $2::date AND session_time = $3::time',
      [student_id, session_date, session_time]
    )).rows[0];

    if (!session) return res.status(404).json({ error: 'Session not found' });

    await pool.query(
      'UPDATE sessions SET status = $1, cancelled_by = $2 WHERE id = $3',
      ['Cancelled by Parent', 'Parent', session.id]
    );

    await pool.query(
      `INSERT INTO makeup_classes (
        student_id, original_session_id, reason, credit_date, status
      ) VALUES ($1, $2, $3, $4, 'Available')`,
      [student_id, session.id, reason || 'Parent cancelled', session_date]
    );

    await pool.query(
      'UPDATE students SET remaining_sessions = LEAST(remaining_sessions + 1, total_sessions) WHERE id = $1',
      [student_id]
    );

    res.json({ message: 'Class cancelled! Makeup credit added.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get email logs
app.get('/api/email-logs', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM email_log ORDER BY sent_at DESC LIMIT 100'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PARENT LOGIN ====================
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function hashPassword(password) {
  return await bcrypt.hash(password, 10);
}

async function verifyPassword(input, hash) {
  return await bcrypt.compare(input, hash);
}

app.post('/api/parent/check-email', async (req, res) => {
  try {
    const student = (await pool.query('SELECT * FROM students WHERE parent_email = $1', [req.body.email])).rows[0];
    if (!student) {
      return res.status(404).json({ error: 'No student found with this email.' });
    }
    
    const creds = (await pool.query('SELECT password FROM parent_credentials WHERE parent_email = $1', [req.body.email])).rows[0];
    res.json({ hasPassword: creds && creds.password ? true : false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/parent/setup-password', async (req, res) => {
  const { email, password } = req.body;
  try {
    const student = (await pool.query('SELECT * FROM students WHERE parent_email = $1', [email])).rows[0];
    if (!student) return res.status(404).json({ error: 'Student not found' });
    
    const hash = await hashPassword(password);
    
    await pool.query(
      `INSERT INTO parent_credentials (parent_email, password)
       VALUES ($1, $2) 
       ON CONFLICT(parent_email) DO UPDATE SET password = $2`,
      [email, hash]
    );
    
    await pool.query(
      'UPDATE parent_credentials SET last_login = CURRENT_TIMESTAMP WHERE parent_email = $1',
      [email]
    );
    
    res.json({ student });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/parent/login-password', async (req, res) => {
  const { email, password } = req.body;
  try {
    const creds = (await pool.query('SELECT password FROM parent_credentials WHERE parent_email = $1', [email])).rows[0];
    
    if (!creds || !(await verifyPassword(password, creds.password))) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    
    const student = (await pool.query('SELECT * FROM students WHERE parent_email = $1', [email])).rows[0];
    
    await pool.query('UPDATE parent_credentials SET last_login = CURRENT_TIMESTAMP WHERE parent_email = $1', [email]);

    res.json({ student });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/parent/send-otp', async (req, res) => {
  const { email } = req.body;
  try {
    const student = (await pool.query('SELECT * FROM students WHERE parent_email = $1', [email])).rows[0];
    if (!student) return res.status(404).json({ error: 'No student found' });
    
    const otp = generateOTP();
    const expiry = new Date(Date.now() + 10 * 60000);
    
    await pool.query(
      `INSERT INTO parent_credentials (parent_email, otp, otp_expiry, otp_attempts) 
       VALUES ($1, $2, $3, 0) 
       ON CONFLICT(parent_email) DO UPDATE SET otp = $2, otp_expiry = $3, otp_attempts = 0`,
      [email, otp, expiry]
    );

    await sendEmail(
      email,
      'Your Login OTP - Fluent Feathers Academy',
      `<p style="font-size: 18px;">Your OTP is <strong style="font-size: 24px; color: #667eea;">${otp}</strong>. It expires in 10 minutes.</p>`,
      student.parent_name,
      'OTP Login'
    );

    res.json({ message: 'OTP sent successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/parent/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  try {
    const creds = (await pool.query('SELECT otp, otp_expiry FROM parent_credentials WHERE parent_email = $1', [email])).rows[0];
    
    if (!creds || creds.otp !== otp || new Date() > new Date(creds.otp_expiry)) {
      return res.status(401).json({ error: 'Invalid or Expired OTP' });
    }
    
    const student = (await pool.query('SELECT * FROM students WHERE parent_email = $1', [email])).rows[0];
    
    await pool.query(
      'UPDATE parent_credentials SET otp = NULL, otp_expiry = NULL WHERE parent_email = $1',
      [email]
    );
    
    res.json({ student });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ==================== GROUP SESSIONS API ====================

// Get all groups
app.get('/api/groups', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT group_name, group_id 
      FROM students 
      WHERE group_name IS NOT NULL 
      ORDER BY group_name
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get students in a group
app.get('/api/groups/:groupId/students', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM students WHERE group_id = $1',
      [req.params.groupId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Schedule group session
app.post('/api/schedule/group-session', async (req, res) => {
  const { group_name, session_date, session_time, student_ids } = req.body;
  
  try {
    const utc = istToUTC(session_date, session_time);
    const zoomLink = 'https://us04web.zoom.us/j/7288533155?pwd=Nng5N2l0aU12L0FQK245c0VVVHJBUT09';
    
    // Create group session
    const sessionResult = await pool.query(
      `INSERT INTO group_sessions (group_name, session_date, session_time, zoom_link)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [group_name, utc.date, utc.time, zoomLink]
    );
    
    const groupSessionId = sessionResult.rows[0].id;
    
    // Link students to session
    for (const studentId of student_ids) {
      await pool.query(
        `INSERT INTO group_session_students (group_session_id, student_id)
         VALUES ($1, $2)`,
        [groupSessionId, studentId]
      );
    }
    
    res.json({ 
      success: true, 
      message: `Group session scheduled for ${student_ids.length} students!` 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║  🎓 FLUENT FEATHERS ACADEMY - SIMPLIFIED LMS    ║
║  ✅ Server running on port ${PORT}              ║
║  📡 http://localhost:${PORT}                    ║
║  📧 Email System Active                         ║
║  🐘 PostgreSQL Connected                        ║
╚══════════════════════════════════════════════════╝
  `);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  pool.end(() => {
    console.log('✅ Database connection closed');
    process.exit(0);
  });
});