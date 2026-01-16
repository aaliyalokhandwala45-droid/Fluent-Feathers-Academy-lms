// ==================== ADVANCED LMS - SERVER.JS (PART 1) ====================
console.log("🚀 Starting Advanced LMS Server...");

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
        group_id INTEGER,
        group_name TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Groups/Batches table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS groups (
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

    // Sessions table (for both private and group)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
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

    // Session attendance (for group sessions - tracks individual student attendance)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS session_attendance (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        attendance TEXT DEFAULT 'Pending',
        homework_grade TEXT,
        homework_comments TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    // Materials table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS materials (
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

    // Events table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
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

    // Event registrations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS event_registrations (
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

// ==================== TIMEZONE HELPERS ====================
// Convert IST (admin input) to UTC (database storage)
function istToUTC(dateStr, timeStr) {
  try {
    if (!dateStr || !timeStr) {
      throw new Error('Date or time is missing');
    }
    
    const cleanDate = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
    let cleanTime = timeStr.trim();
    if (cleanTime.length === 5) cleanTime += ':00';
    
    const isoString = `${cleanDate}T${cleanTime}+05:30`;
    const date = new Date(isoString);
    
    if (isNaN(date.getTime())) {
      console.error('❌ Invalid IST datetime:', dateStr, timeStr);
      return { date: cleanDate, time: cleanTime.substring(0, 5) };
    }
    
    const utcDate = date.toISOString().split('T')[0];
    const utcTime = date.toISOString().split('T')[1].substring(0, 8);
    
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
    if (!utcDate || !utcTime || !timezone) {
      throw new Error('Missing UTC date, time, or timezone');
    }
    
    const cleanDate = utcDate.includes('T') ? utcDate.split('T')[0] : utcDate;
    const cleanTime = utcTime.length === 5 ? utcTime + ':00' : utcTime.substring(0, 8);
    
    const isoString = `${cleanDate}T${cleanTime}Z`;
    const date = new Date(isoString);
    
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

// Continue to Part 2...// ==================== EMAIL SYSTEM ====================
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

// ==================== EMAIL TEMPLATES ====================
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

function getEventEmail(data) {
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="font-family: Arial, sans-serif; background: #f4f7fa; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px;">
        <h1 style="color: #667eea; text-align: center;">🎉 ${data.event_name}</h1>
        <p>Dear ${data.parent_name},</p>
        <p>${data.event_description}</p>
        
        <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="color: #667eea;">📅 Event Details</h3>
          <p><strong>Date:</strong> ${data.event_date}</p>
          <p><strong>Time:</strong> ${data.event_time}</p>
          <p><strong>Duration:</strong> ${data.event_duration}</p>
          ${data.zoom_link ? `<p><strong>Zoom Link:</strong> <a href="${data.zoom_link}">${data.zoom_link}</a></p>` : ''}
        </div>

        <div style="text-align: center; margin: 30px 0;">
          <a href="${data.registration_link}" style="display: inline-block; background: #38a169; color: white; padding: 15px 40px; text-decoration: none; border-radius: 25px; font-weight: bold;">✅ Register Now</a>
        </div>

        <p style="color: #667eea; font-weight: bold; text-align: center;">Best regards,<br>Fluent Feathers Academy Team</p>
      </div>
    </body>
    </html>
  `;
}

// ==================== API ROUTES - DASHBOARD ====================

// Dashboard stats
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const studentStats = await pool.query('SELECT COUNT(*) as total, SUM(fees_paid) as revenue FROM students WHERE is_active = true');
    const sessionStats = await pool.query(
      `SELECT COUNT(*) as upcoming FROM sessions WHERE status IN ('Pending', 'Scheduled') AND session_date >= CURRENT_DATE`
    );
    const groupStats = await pool.query('SELECT COUNT(*) as total FROM groups');
    const eventStats = await pool.query('SELECT COUNT(*) as total FROM events WHERE status = \'Active\'');
    
    res.json({
      totalStudents: parseInt(studentStats.rows[0].total) || 0,
      totalRevenue: parseFloat(studentStats.rows[0].revenue) || 0,
      upcomingSessions: parseInt(sessionStats.rows[0].upcoming) || 0,
      totalGroups: parseInt(groupStats.rows[0].total) || 0,
      activeEvents: parseInt(eventStats.rows[0].total) || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get upcoming classes (for admin dashboard)
app.get('/api/dashboard/upcoming-classes', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Get private sessions
    const privateSessions = await pool.query(`
      SELECT 
        s.id, s.session_date, s.session_time, s.zoom_link, s.session_type,
        st.name as student_name, st.timezone, s.session_number,
        CONCAT(st.program_name, ' - ', st.duration) as class_info
      FROM sessions s
      JOIN students st ON s.student_id = st.id
      WHERE s.session_date >= $1 
        AND s.status IN ('Pending', 'Scheduled')
        AND s.session_type = 'Private'
      ORDER BY s.session_date ASC, s.session_time ASC
      LIMIT 10
    `, [today]);

    // Get group sessions
    const groupSessions = await pool.query(`
      SELECT 
        s.id, s.session_date, s.session_time, s.zoom_link, s.session_type,
        g.group_name as student_name, g.timezone, s.session_number,
        CONCAT(g.program_name, ' - ', g.duration) as class_info
      FROM sessions s
      JOIN groups g ON s.group_id = g.id
      WHERE s.session_date >= $1 
        AND s.status IN ('Pending', 'Scheduled')
        AND s.session_type = 'Group'
      ORDER BY s.session_date ASC, s.session_time ASC
      LIMIT 10
    `, [today]);

    const allSessions = [...privateSessions.rows, ...groupSessions.rows]
      .sort((a, b) => {
        const dateA = new Date(a.session_date + 'T' + a.session_time);
        const dateB = new Date(b.session_date + 'T' + b.session_time);
        return dateA - dateB;
      })
      .slice(0, 10);

    res.json(allSessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== API ROUTES - STUDENTS ====================

// Get all students
app.get('/api/students', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, 
        COUNT(m.id) as makeup_credits,
        g.group_name as group_display_name
       FROM students s 
       LEFT JOIN makeup_classes m ON s.id = m.student_id AND m.status = 'Available'
       LEFT JOIN groups g ON s.group_id = g.id
       WHERE s.is_active = true
       GROUP BY s.id, g.group_name
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
    timezone, program_name, class_type, duration, currency, per_session_fee, total_sessions,
    group_id
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO students (
        name, grade, parent_name, parent_email, primary_contact, alternate_contact, 
        timezone, program_name, class_type, duration, currency, per_session_fee, 
        total_sessions, completed_sessions, remaining_sessions, fees_paid, group_id,
        is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, $13, 0, $14, true) 
      RETURNING id`,
      [name, grade, parent_name, parent_email, primary_contact, alternate_contact, 
       timezone, program_name, class_type, duration, currency, per_session_fee, total_sessions, group_id]
    );

    const studentId = result.rows[0].id;

    // Update group student count if enrolled in group
    if (group_id) {
      await pool.query(
        'UPDATE groups SET current_students = current_students + 1 WHERE id = $1',
        [group_id]
      );
    }

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

// Continue to Part 3...
// ==================== API ROUTES - STUDENTS (CONTINUED) ====================

// Update student
app.put('/api/students/:id', async (req, res) => {
  const studentId = req.params.id;
  const { 
    name, grade, parent_name, parent_email, primary_contact, alternate_contact,
    timezone, program_name, class_type, duration, currency, 
    per_session_fee, total_sessions, group_id
  } = req.body;

  try {
    // Get current group_id
    const currentStudent = await pool.query('SELECT group_id FROM students WHERE id = $1', [studentId]);
    const oldGroupId = currentStudent.rows[0]?.group_id;

    await pool.query(
      `UPDATE students SET 
        name = $1, grade = $2, parent_name = $3, parent_email = $4,
        primary_contact = $5, alternate_contact = $6, timezone = $7,
        program_name = $8, class_type = $9, duration = $10, currency = $11,
        per_session_fee = $12, total_sessions = $13, group_id = $14
       WHERE id = $15`,
      [name, grade, parent_name, parent_email, primary_contact, alternate_contact,
       timezone, program_name, class_type, duration, currency,
       per_session_fee, total_sessions, group_id, studentId]
    );

    // Update group counts if group changed
    if (oldGroupId !== group_id) {
      if (oldGroupId) {
        await pool.query('UPDATE groups SET current_students = current_students - 1 WHERE id = $1', [oldGroupId]);
      }
      if (group_id) {
        await pool.query('UPDATE groups SET current_students = current_students + 1 WHERE id = $1', [group_id]);
      }
    }
    
    res.json({ message: 'Student updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete student (soft delete)
app.delete('/api/students/:id', async (req, res) => {
  try {
    // Get student's group_id
    const student = await pool.query('SELECT group_id FROM students WHERE id = $1', [req.params.id]);
    const groupId = student.rows[0]?.group_id;

    // Soft delete
    await pool.query('UPDATE students SET is_active = false WHERE id = $1', [req.params.id]);

    // Update group count
    if (groupId) {
      await pool.query('UPDATE groups SET current_students = current_students - 1 WHERE id = $1', [groupId]);
    }

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

// ==================== API ROUTES - GROUPS/BATCHES ====================

// Get all groups
app.get('/api/groups', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT g.*,
        COUNT(DISTINCT s.id) as enrolled_students
      FROM groups g
      LEFT JOIN students s ON g.id = s.group_id AND s.is_active = true
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new group
app.post('/api/groups', async (req, res) => {
  const { group_name, program_name, duration, timezone, max_students } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO groups (group_name, program_name, duration, timezone, max_students, current_students)
       VALUES ($1, $2, $3, $4, $5, 0) RETURNING id`,
      [group_name, program_name, duration, timezone, max_students]
    );

    res.json({ success: true, message: 'Group created successfully!', groupId: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get students in a group
app.get('/api/groups/:groupId/students', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM students WHERE group_id = $1 AND is_active = true ORDER BY name',
      [req.params.groupId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete group
app.delete('/api/groups/:id', async (req, res) => {
  try {
    // Check if group has students
    const students = await pool.query('SELECT COUNT(*) as count FROM students WHERE group_id = $1 AND is_active = true', [req.params.id]);
    
    if (parseInt(students.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Cannot delete group with enrolled students. Please remove students first.' });
    }

    await pool.query('DELETE FROM groups WHERE id = $1', [req.params.id]);
    res.json({ message: 'Group deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== API ROUTES - SCHEDULING ====================

// Schedule private classes
app.post('/api/schedule/private-classes', async (req, res) => {
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
      if (!cls.date || !cls.time) {
        console.error('Invalid class data:', cls);
        continue;
      }
      
      const utc = istToUTC(cls.date, cls.time);
      
      console.log(`📅 Scheduling: IST ${cls.date} ${cls.time} -> UTC ${utc.date} ${utc.time}`);
      
      await pool.query(
        `INSERT INTO sessions (
          student_id, session_type, session_number, session_date, session_time, zoom_link, status
        ) VALUES ($1, 'Private', $2, $3::date, $4::time, $5, 'Pending')`,
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

// Schedule group classes
app.post('/api/schedule/group-classes', async (req, res) => {
  const { group_id, classes } = req.body;

  try {
    const group = (await pool.query('SELECT * FROM groups WHERE id = $1', [group_id])).rows[0];
    
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }
    
    const count = (await pool.query('SELECT COUNT(*) as count FROM sessions WHERE group_id = $1', [group_id])).rows[0].count;
    let sessionNumber = parseInt(count) + 1;

    const zoomLink = 'https://us04web.zoom.us/j/7288533155?pwd=Nng5N2l0aU12L0FQK245c0VVVHJBUT09';
    const scheduledClasses = [];

    for (const cls of classes) {
      if (!cls.date || !cls.time) {
        console.error('Invalid class data:', cls);
        continue;
      }
      
      const utc = istToUTC(cls.date, cls.time);
      
      const result = await pool.query(
        `INSERT INTO sessions (
          group_id, session_type, session_number, session_date, session_time, zoom_link, status
        ) VALUES ($1, 'Group', $2, $3::date, $4::time, $5, 'Pending') RETURNING id`,
        [group_id, sessionNumber, utc.date, utc.time, zoomLink]
      );

      const sessionId = result.rows[0].id;

      // Create attendance records for all students in group
      const students = await pool.query('SELECT id FROM students WHERE group_id = $1 AND is_active = true', [group_id]);
      
      for (const student of students.rows) {
        await pool.query(
          'INSERT INTO session_attendance (session_id, student_id, attendance) VALUES ($1, $2, \'Pending\')',
          [sessionId, student.id]
        );
      }
      
      scheduledClasses.push({ ...cls, session_number: sessionNumber });
      sessionNumber++;
    }

    if (scheduledClasses.length === 0) {
      return res.status(400).json({ error: 'No valid classes to schedule' });
    }

    // Send emails to all students in group
    const students = await pool.query(
      'SELECT * FROM students WHERE group_id = $1 AND is_active = true',
      [group_id]
    );

    for (const student of students.rows) {
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

      await sendEmail(
        student.parent_email,
        `📅 ${group.group_name} - Class Schedule`,
        getScheduleEmail({
          parent_name: student.parent_name,
          student_name: student.name,
          timezone: student.timezone,
          schedule_rows: rows
        }),
        student.parent_name,
        'Schedule'
      );
    }

    res.json({ message: `${scheduledClasses.length} group classes scheduled. Emails sent to ${students.rows.length} students.` });
  } catch (err) {
    console.error('Schedule error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Continue to Part 4...
// ==================== API ROUTES - SESSIONS ====================

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

// Get all past sessions (for admin)
app.get('/api/sessions/past/all', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Get private sessions
    const privateSessions = await pool.query(`
      SELECT 
        s.*, 
        st.name as student_name,
        st.timezone,
        NULL as group_name
      FROM sessions s
      JOIN students st ON s.student_id = st.id
      WHERE s.session_date <= $1 
        AND s.session_type = 'Private'
      ORDER BY s.session_date DESC, s.session_time DESC
      LIMIT 50
    `, [today]);

    // Get group sessions
    const groupSessions = await pool.query(`
      SELECT 
        s.*, 
        g.group_name as student_name,
        g.timezone,
        g.group_name
      FROM sessions s
      JOIN groups g ON s.group_id = g.id
      WHERE s.session_date <= $1 
        AND s.session_type = 'Group'
      ORDER BY s.session_date DESC, s.session_time DESC
      LIMIT 50
    `, [today]);

    const allSessions = [...privateSessions.rows, ...groupSessions.rows]
      .sort((a, b) => {
        const dateA = new Date(a.session_date + 'T' + a.session_time);
        const dateB = new Date(b.session_date + 'T' + b.session_time);
        return dateB - dateA;
      })
      .slice(0, 50);

    res.json(allSessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update session
app.put('/api/sessions/:sessionId', async (req, res) => {
  const { session_date, session_time } = req.body;
  const sessionId = req.params.sessionId;

  try {
    const utc = istToUTC(session_date, session_time);
    
    await pool.query(
      'UPDATE sessions SET session_date = $1::date, session_time = $2::time WHERE id = $3',
      [utc.date, utc.time, sessionId]
    );

    res.json({ message: 'Session updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark attendance (private session)
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
      if (session.student_id) {
        await pool.query(
          `UPDATE students SET 
            completed_sessions = completed_sessions + 1, 
            remaining_sessions = GREATEST(remaining_sessions - 1, 0)
           WHERE id = $1`,
          [session.student_id]
        );
      }
    }

    res.json({ message: 'Attendance marked successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark attendance for group session
app.post('/api/sessions/:sessionId/group-attendance', async (req, res) => {
  const { attendanceData } = req.body; // Array of {student_id, attendance}
  const sessionId = req.params.sessionId;

  try {
    for (const record of attendanceData) {
      await pool.query(
        'UPDATE session_attendance SET attendance = $1 WHERE session_id = $2 AND student_id = $3',
        [record.attendance, sessionId, record.student_id]
      );

      if (record.attendance === 'Present') {
        await pool.query(
          `UPDATE students SET 
            completed_sessions = completed_sessions + 1, 
            remaining_sessions = GREATEST(remaining_sessions - 1, 0)
           WHERE id = $1`,
          [record.student_id]
        );
      }
    }

    // Update session status
    await pool.query(
      'UPDATE sessions SET status = $1 WHERE id = $2',
      ['Completed', sessionId]
    );

    res.json({ message: 'Group attendance marked successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get group session attendance
app.get('/api/sessions/:sessionId/group-attendance', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        sa.*,
        s.name as student_name
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

    // If it's a group session, create material records for all students
    const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    const sessionData = session.rows[0];

    if (sessionData.session_type === 'Group' && sessionData.group_id) {
      const students = await pool.query(
        'SELECT id FROM students WHERE group_id = $1 AND is_active = true',
        [sessionData.group_id]
      );

      for (const student of students.rows) {
        await pool.query(
          `INSERT INTO materials (
            student_id, group_id, session_id, session_date, file_type, file_name, file_path, uploaded_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Teacher')`,
          [student.id, sessionData.group_id, sessionId, sessionData.session_date, 
           materialType.toUpperCase(), req.file.originalname, req.file.filename]
        );
      }
    } else if (sessionData.student_id) {
      await pool.query(
        `INSERT INTO materials (
          student_id, session_id, session_date, file_type, file_name, file_path, uploaded_by
        ) VALUES ($1, $2, $3, $4, $5, $6, 'Teacher')`,
        [sessionData.student_id, sessionId, sessionData.session_date, 
         materialType.toUpperCase(), req.file.originalname, req.file.filename]
      );
    }

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
app.post('/api/sessions/:sessionId/grade/:studentId', async (req, res) => {
  const { grade, comments } = req.body;
  const { sessionId, studentId } = req.params;

  try {
    // Update in session_attendance for group sessions
    await pool.query(
      'UPDATE session_attendance SET homework_grade = $1, homework_comments = $2 WHERE session_id = $3 AND student_id = $4',
      [grade, comments, sessionId, studentId]
    );

    // Update in materials table
    await pool.query(
      `UPDATE materials SET 
        feedback_grade = $1, 
        feedback_comments = $2, 
        feedback_given = 1, 
        feedback_date = CURRENT_TIMESTAMP 
       WHERE session_id = $3 AND student_id = $4 AND file_type = 'Homework'`,
      [grade, comments, sessionId, studentId]
    );

    res.json({ message: 'Homework graded successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== API ROUTES - MATERIALS ====================

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
  const { sessionDate, sessionId } = req.body;
  const studentId = req.params.studentId;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    await pool.query(
      `INSERT INTO materials (
        student_id, session_id, session_date, file_type, file_name, file_path, uploaded_by
      ) VALUES ($1, $2, $3, 'Homework', $4, $5, 'Parent')`,
      [studentId, sessionId, sessionDate, req.file.originalname, req.file.filename]
    );

    res.json({ message: 'Homework uploaded successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== API ROUTES - EVENTS ====================

// Get all events
app.get('/api/events', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.*,
        COUNT(DISTINCT er.id) as registered_count
      FROM events e
      LEFT JOIN event_registrations er ON e.id = er.event_id
      GROUP BY e.id
      ORDER BY e.event_date DESC, e.event_time DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create event
app.post('/api/events', async (req, res) => {
  const { 
    event_name, event_description, event_date, event_time, event_duration,
    target_audience, specific_grades, zoom_link, max_participants
  } = req.body;

  try {
    const utc = istToUTC(event_date, event_time);

    const result = await pool.query(
      `INSERT INTO events (
        event_name, event_description, event_date, event_time, event_duration,
        target_audience, specific_grades, zoom_link, max_participants, status
      ) VALUES ($1, $2, $3::date, $4::time, $5, $6, $7, $8, $9, 'Active') RETURNING id`,
      [event_name, event_description, utc.date, utc.time, event_duration,
       target_audience, specific_grades, zoom_link, max_participants]
    );

    const eventId = result.rows[0].id;

    // Send emails to eligible students
    let students;
    if (target_audience === 'All') {
      students = await pool.query('SELECT * FROM students WHERE is_active = true');
    } else if (target_audience === 'Specific Grades' && specific_grades) {
      const gradeList = specific_grades.split(',').map(g => g.trim());
      students = await pool.query(
        'SELECT * FROM students WHERE is_active = true AND grade = ANY($1)',
        [gradeList]
      );
    }

    if (students && students.rows.length > 0) {
      for (const student of students.rows) {
        const display = utcToTimezone(utc.date, utc.time, student.timezone);
        
        const registrationLink = `${req.protocol}://${req.get('host')}/parent.html?event=${eventId}&student=${student.id}`;

        await sendEmail(
          student.parent_email,
          `🎉 ${event_name} - Registration Open`,
          getEventEmail({
            parent_name: student.parent_name,
            event_name,
            event_description,
            event_date: display.date,
            event_time: display.time,
            event_duration,
            zoom_link,
            registration_link: registrationLink
          }),
          student.parent_name,
          'Event'
        );
      }
    }

    res.json({ 
      success: true, 
      message: `Event created! Emails sent to ${students?.rows.length || 0} eligible students.`,
      eventId 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Continue to Part 5...// ==================== API ROUTES - EVENTS (CONTINUED) ====================

// Register for event (parent)
app.post('/api/events/:eventId/register', async (req, res) => {
  const { student_id } = req.body;
  const eventId = req.params.eventId;

  try {
    // Check if already registered
    const existing = await pool.query(
      'SELECT id FROM event_registrations WHERE event_id = $1 AND student_id = $2',
      [eventId, student_id]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Already registered for this event' });
    }

    // Check if event is full
    const event = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
    const eventData = event.rows[0];

    if (eventData.max_participants && eventData.current_participants >= eventData.max_participants) {
      return res.status(400).json({ error: 'Event is full' });
    }

    await pool.query(
      `INSERT INTO event_registrations (event_id, student_id, registration_method)
       VALUES ($1, $2, 'Parent')`,
      [eventId, student_id]
    );

    await pool.query(
      'UPDATE events SET current_participants = current_participants + 1 WHERE id = $1',
      [eventId]
    );

    res.json({ message: 'Successfully registered for event!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual registration (admin)
app.post('/api/events/:eventId/register-manual', async (req, res) => {
  const { student_id } = req.body;
  const eventId = req.params.eventId;

  try {
    const existing = await pool.query(
      'SELECT id FROM event_registrations WHERE event_id = $1 AND student_id = $2',
      [eventId, student_id]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Student already registered' });
    }

    await pool.query(
      `INSERT INTO event_registrations (event_id, student_id, registration_method)
       VALUES ($1, $2, 'Manual')`,
      [eventId, student_id]
    );

    await pool.query(
      'UPDATE events SET current_participants = current_participants + 1 WHERE id = $1',
      [eventId]
    );

    res.json({ message: 'Student registered successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get event registrations
app.get('/api/events/:eventId/registrations', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        er.*,
        s.name as student_name,
        s.grade,
        s.parent_name,
        s.parent_email
      FROM event_registrations er
      JOIN students s ON er.student_id = s.id
      WHERE er.event_id = $1
      ORDER BY er.registered_at DESC
    `, [req.params.eventId]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark event attendance
app.post('/api/events/:eventId/attendance', async (req, res) => {
  const { attendanceData } = req.body; // Array of {student_id, attendance}
  const eventId = req.params.eventId;

  try {
    for (const record of attendanceData) {
      await pool.query(
        'UPDATE event_registrations SET attendance = $1 WHERE event_id = $2 AND student_id = $3',
        [record.attendance, eventId, record.student_id]
      );
    }

    res.json({ message: 'Event attendance marked successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete event
app.delete('/api/events/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM events WHERE id = $1', [req.params.id]);
    res.json({ message: 'Event deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get events for parent (student-specific)
app.get('/api/events/student/:studentId', async (req, res) => {
  try {
    const student = await pool.query('SELECT * FROM students WHERE id = $1', [req.params.studentId]);
    const studentData = student.rows[0];

    if (!studentData) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Get all active events that match student's eligibility
    let events;
    const today = new Date().toISOString().split('T')[0];

    events = await pool.query(`
      SELECT e.*,
        CASE WHEN er.id IS NOT NULL THEN true ELSE false END as is_registered
      FROM events e
      LEFT JOIN event_registrations er ON e.id = er.event_id AND er.student_id = $1
      WHERE e.status = 'Active' 
        AND e.event_date >= $2
        AND (e.target_audience = 'All' 
          OR (e.target_audience = 'Specific Grades' AND e.specific_grades LIKE '%' || $3 || '%'))
      ORDER BY e.event_date ASC, e.event_time ASC
    `, [req.params.studentId, today, studentData.grade]);

    res.json(events.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Get event details (single event)
app.get('/api/events/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get session details
app.get('/api/sessions/:id/details', async (req, res) => {
  try {
    const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [req.params.id]);
    res.json(session.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ==================== API ROUTES - PARENT PORTAL ====================

// Cancel class (parent)
app.post('/api/parent/cancel-class', async (req, res) => {
  const { student_id, session_id, reason } = req.body;

  try {
    const session = (await pool.query(
      'SELECT * FROM sessions WHERE id = $1 AND student_id = $2',
      [session_id, student_id]
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
      [student_id, session.id, reason || 'Parent cancelled', session.session_date]
    );

    // Don't reduce remaining_sessions, just add makeup credit
    // The makeup credit will be used when scheduling a makeup class

    res.json({ message: 'Class cancelled! Makeup credit added.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get makeup credits for student
app.get('/api/students/:studentId/makeup-credits', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM makeup_classes WHERE student_id = $1 AND status = \'Available\' ORDER BY credit_date DESC',
      [req.params.studentId]
    );
    res.json(result.rows);
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
    const student = (await pool.query('SELECT * FROM students WHERE parent_email = $1 AND is_active = true', [req.body.email])).rows[0];
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
    const student = (await pool.query('SELECT * FROM students WHERE parent_email = $1 AND is_active = true', [email])).rows[0];
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
    
    const student = (await pool.query('SELECT * FROM students WHERE parent_email = $1 AND is_active = true', [email])).rows[0];
    
    await pool.query('UPDATE parent_credentials SET last_login = CURRENT_TIMESTAMP WHERE parent_email = $1', [email]);

    res.json({ student });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/parent/send-otp', async (req, res) => {
  const { email } = req.body;
  try {
    const student = (await pool.query('SELECT * FROM students WHERE parent_email = $1 AND is_active = true', [email])).rows[0];
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
    
    const student = (await pool.query('SELECT * FROM students WHERE parent_email = $1 AND is_active = true', [email])).rows[0];
    
    await pool.query(
      'UPDATE parent_credentials SET otp = NULL, otp_expiry = NULL WHERE parent_email = $1',
      [email]
    );
    
    res.json({ student });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║  🎓 FLUENT FEATHERS ACADEMY - ADVANCED LMS      ║
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