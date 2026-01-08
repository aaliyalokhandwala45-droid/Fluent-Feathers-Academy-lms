console.log("🚀 SERVER FILE STARTED");

require('dotenv').config(); // 👈 move this UP

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const sgMail = require('@sendgrid/mail');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const cron = require('node-cron');

sgMail.setApiKey(process.env.SENDGRID_API_KEY); // 👈 perfect place

const app = express();
const PORT = process.env.PORT || 3000;


// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/uploads/homework/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'uploads', 'homework', req.params.filename);
  
  // Check if file exists
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    console.log('File not found:', filePath);
    res.status(404).send('File not found');
  }
});
// Create directories if they don't exist
const directories = ['uploads', 'uploads/materials', 'uploads/homework', 'uploads/settings'];
directories.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Database setup
const db = new sqlite3.Database('./academy.db', (err) => {
  if (err) {
    console.error('❌ Database connection error:', err);
  } else {
    console.log('✅ Connected to SQLite database');
    initializeDatabase();
  }
});
// ✅ AUTO-MIGRATE students TABLE (SAFE – RUNS ON SERVER START)
db.serialize(() => {
  db.all("PRAGMA table_info(students)", (err, columns) => {
    if (err) {
      console.error("❌ Failed to read students table info:", err);
      return;
    }

    const existingCols = columns.map(col => col.name);

    const requiredColumns = [
     { name: "primary_contact", type: "TEXT" },
      { name: "alternate_contact", type: "TEXT" }, { name: "timezone", type: "TEXT" },
      { name: "currency", type: "TEXT" },
      { name: "per_session_fee", type: "REAL" },
      { name: "fees_paid", type: "REAL DEFAULT 0" },
      { name: "total_sessions", type: "INTEGER DEFAULT 0" },
      { name: "completed_sessions", type: "INTEGER DEFAULT 0" },
      { name: "remaining_sessions", type: "INTEGER DEFAULT 0" }
    ];

    requiredColumns.forEach(col => {
      if (!existingCols.includes(col.name)) {
        db.run(
          `ALTER TABLE students ADD COLUMN ${col.name} ${col.type}`,
          (err) => {
            if (err) {
              console.error(`❌ Failed to add column ${col.name}:`, err);
            } else {
              console.log(`✅ Added column '${col.name}' to students table`);
            }
          }
        );
      }
    });
  });
});


// Initialize database tables with ENHANCED SCHEMA
function initializeDatabase() {
  db.serialize(() => {
    // Enhanced Students table with timezone and currency
    db.run(`CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      grade TEXT NOT NULL,
      parent_name TEXT NOT NULL,
      parent_email TEXT NOT NULL,
      primary_contact TEXT,
  alternate_contact TEXT,
      timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      program_name TEXT NOT NULL,
      class_type TEXT NOT NULL,
      duration TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT '₹',
      per_session_fee REAL NOT NULL,
      total_sessions INTEGER NOT NULL,
      completed_sessions INTEGER DEFAULT 0,
      remaining_sessions INTEGER,
      fees_paid REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Enhanced Sessions table with detailed tracking
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      session_number INTEGER NOT NULL,
      session_date DATE NOT NULL,
      session_time TIME NOT NULL,
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    )`);

    // Materials table (existing)
    db.run(`CREATE TABLE IF NOT EXISTS materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER,
      batch_name TEXT,
      session_date DATE NOT NULL,
      file_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      uploaded_by TEXT NOT NULL,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    )`);
// Add feedback columns to materials table (if not exists)
db.serialize(() => {
  db.run(`ALTER TABLE materials ADD COLUMN feedback_grade TEXT`, () => {});
  db.run(`ALTER TABLE materials ADD COLUMN feedback_comments TEXT`, () => {});
  db.run(`ALTER TABLE materials ADD COLUMN feedback_given INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE materials ADD COLUMN feedback_date DATETIME`, () => {});
});
    // NEW: Make-up Classes table
    db.run(`CREATE TABLE IF NOT EXISTS makeup_classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      original_session_id INTEGER,
      reason TEXT NOT NULL,
      credit_date DATE NOT NULL,
      status TEXT DEFAULT 'Available',
      used_date DATE,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    )`);

    // NEW: Payment History table
    db.run(`CREATE TABLE IF NOT EXISTS payment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      payment_date DATE NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      receipt_number TEXT,
      sessions_covered TEXT,
      payment_status TEXT DEFAULT 'Paid',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    )`);

    // NEW: Events table
    db.run(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      event_name TEXT NOT NULL,
      event_description TEXT,
      event_date DATE NOT NULL,
      event_time TIME NOT NULL,
      duration TEXT NOT NULL,
      zoom_link TEXT NOT NULL,
      max_participants INTEGER DEFAULT 0,
      registration_deadline DATETIME,
      event_status TEXT DEFAULT 'Upcoming',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // NEW: Event Registrations table
    db.run(`CREATE TABLE IF NOT EXISTS event_registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      parent_name TEXT NOT NULL,
      parent_email TEXT NOT NULL,
      registration_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      attendance_status TEXT DEFAULT 'Registered',
      feedback_rating INTEGER,
      feedback_comments TEXT,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    )`);

   

    // Timetable table (existing)
    db.run(`CREATE TABLE IF NOT EXISTS timetable (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_of_week TEXT NOT NULL,
      time_slot TEXT NOT NULL,
      is_booked INTEGER DEFAULT 0,
      student_id INTEGER,
      student_name TEXT,
      program_name TEXT,
      duration TEXT,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL
    )`);

    // Email log table (existing)
db.run(`CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_name TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  email_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// NEW: Parent Login Credentials table
db.run(`CREATE TABLE IF NOT EXISTS parent_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_email TEXT UNIQUE NOT NULL,
  password TEXT,
  otp TEXT,
  otp_expiry DATETIME,
  otp_attempts INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME
)`);

console.log('✅ Enhanced database tables initialized');
  });
}
// Generate 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Hash password (simple encoding - for production use bcrypt)
function hashPassword(password) {
  return Buffer.from(password).toString('base64');
}

// Verify password
function verifyPassword(inputPassword, storedHash) {
  const inputHash = Buffer.from(inputPassword).toString('base64');
  return inputHash === storedHash;
}
// Email configuration
app.post('/register', async (req, res) => {
  try {
    const { email } = req.body;

    await sgMail.send({
      to: email,
      from: 'fluentfeathersbyaaliya@gmail.com',
      subject: 'Registration Successful',
      text: 'Welcome!',
    });

    res.send('Email sent');
  } catch (err) {
    console.error(err);
    res.status(500).send('Email failed');
  }
});




// Enhanced file upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadType = req.body.uploadType || 'homework';  // ← CHANGED
        let dest = 'uploads/homework/';  // ← CHANGED
        
        switch (uploadType) {
            case 'homework':
                dest = 'uploads/homework/';
                break;
            case 'settings':
                dest = 'uploads/settings/';
                break;
            default:
                dest = 'uploads/homework/';  // ← CHANGED
        }
    
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
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});
// Submit homework feedback (Simple version)
app.post('/api/homework/:homeworkId/feedback', async (req, res) => {
  const homeworkId = req.params.homeworkId;
  const { grade, comments } = req.body;
  
  // Get homework and student details
  db.get(`SELECT * FROM materials WHERE id = ?`, [homeworkId], async (err, homework) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!homework) return res.status(404).json({ error: 'Homework not found' });
    
    db.get(`SELECT * FROM students WHERE id = ?`, [homework.student_id], async (err, student) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // Update materials with feedback
      db.run(`UPDATE materials SET 
        feedback_grade = ?,
        feedback_comments = ?,
        feedback_given = 1,
        feedback_date = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [grade, comments, homeworkId],
        async (err) => {
          if (err) return res.status(500).json({ error: err.message });
          
          // Send email to parent
          const feedbackEmail = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #667eea;">📝 Homework Feedback Received!</h2>
              <p>Dear ${student.parent_name},</p>
              <p>Your child's homework has been reviewed.</p>
              
              <div style="background: #d4edda; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 5px solid #27ae60;">
                <h3 style="color: #27ae60; margin-top: 0;">Homework Details</h3>
                <p><strong>Student:</strong> ${student.name}</p>
                <p><strong>Session Date:</strong> ${homework.session_date}</p>
                <p><strong>Grade:</strong> <span style="font-size: 1.5em; color: #27ae60;">${grade}</span></p>
                <p><strong>Teacher Comments:</strong></p>
                <p style="background: white; padding: 15px; border-radius: 5px;">${comments}</p>
              </div>
              
              <p>You can view this feedback in your parent portal.</p>
              <p style="color: #667eea; font-weight: bold;">Best regards,<br>Fluent Feathers Academy</p>
            </div>
          `;
          
          await sendEmail(
            student.parent_email,
            `📝 Homework Feedback - ${student.name}`,
            feedbackEmail,
            student.parent_name,
            'Homework Feedback'
          );
          
          res.json({ message: 'Feedback submitted & email sent to parent!' });
        }
      );
    });
  });
});
// Enhanced email function with templates
async function sendEmail(to, subject, html, recipientName, emailType, attachments = []) {
  try {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: to,
      subject: subject,
      html: html,
      attachments: attachments
    };

    await transporter.sendMail(mailOptions);

    // Log email
    db.run(`INSERT INTO email_log (recipient_name, recipient_email, email_type, subject, status) 
            VALUES (?, ?, ?, ?, 'Sent')`,
      [recipientName, to, emailType, subject]);

    return true;
  } catch (error) {
    console.error('Email error:', error);
    
    // Log failed email
    db.run(`INSERT INTO email_log (recipient_name, recipient_email, email_type, subject, status) 
            VALUES (?, ?, ?, ?, 'Failed')`,
      [recipientName, to, emailType, subject]);

    return false;
  }
}

// Enhanced email templates
function getEmailTemplate(type, data) {
  const templates = {
    welcome: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 10px;">
        <div style="background: white; padding: 30px; border-radius: 8px;">
          <h2 style="color: #2c3e50; text-align: center;">🎓 Welcome to Fluent Feathers Academy!</h2>
          <p>Dear ${data.parent_name},</p>
          <p>We're excited to welcome <strong>${data.student_name}</strong> to our ${data.program_name} program!</p>
          
          <div style="background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3 style="color: #667eea; margin-bottom: 15px;">📋 Enrollment Details</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Student:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.student_name}</td></tr>
              <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Grade:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.grade}</td></tr>
              <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Program:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.program_name}</td></tr>
              <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Class Type:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.class_type}</td></tr>
              <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Duration:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.duration}</td></tr>
              <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Total Sessions:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${data.total_sessions}</td></tr>
              <tr><td style="padding: 8px;"><strong>Timezone:</strong></td><td style="padding: 8px;">${data.timezone}</td></tr>
            </table>
          </div>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${data.zoom_link}" style="background: #9b59b6; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">🎥 Join Class</a>
          </div>

          <p style="color: #7f8c8d; font-size: 0.9em; margin-top: 30px;">
            Your classes will be scheduled soon. You'll receive another email with the complete schedule.<br>
            Questions? WhatsApp us: <a href="https://wa.me/your-number">Click here</a>
          </p>

          <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 2px solid #eee;">
            <p style="color: #667eea; font-weight: bold;">Best regards,<br>Fluent Feathers Academy Team</p>
          </div>
        </div>
      </div>
    `,
    
    event_announcement: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 10px;">
        <div style="background: white; padding: 30px; border-radius: 8px;">
          <h2 style="color: #2c3e50; text-align: center;">🎉 New Event: ${data.event_name}</h2>
          <p>Dear ${data.parent_name},</p>
          <p>We're excited to announce a new <strong>${data.event_type}</strong> for all our students!</p>
          
          <div style="background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3 style="color: #667eea; margin-bottom: 15px;">📅 Event Details</h3>
            <p><strong>Event:</strong> ${data.event_name}</p>
            <p><strong>Date & Time:</strong> ${data.event_date} at ${data.event_time}</p>
            <p><strong>Duration:</strong> ${data.duration}</p>
            <p><strong>Type:</strong> ${data.event_type}</p>
            <p><strong>Platform:</strong> Online via Zoom</p>
            ${data.max_participants > 0 ? `<p><strong>Limited Seats:</strong> ${data.max_participants} participants</p>` : '<p><strong>Unlimited</strong> participants welcome!</p>'}
            <p style="margin-top: 15px;">${data.event_description}</p>
          </div>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${data.registration_link}" style="background: #27ae60; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">✅ Register ${data.student_name} Now - FREE!</a>
          </div>

          <p style="color: #e74c3c; font-weight: bold; text-align: center;">Registration Deadline: ${data.deadline}</p>
        </div>
      </div>
    `
  };
  
  return templates[type] || '';
}

// ========== ENHANCED API ROUTES ==========

// Dashboard stats with enhanced metrics
app.get('/api/dashboard/stats', (req, res) => {
  db.get(`SELECT COUNT(*) as totalStudents, SUM(fees_paid) as totalRevenue FROM students`, (err, studentStats) => {
    if (err) return res.status(500).json({ error: err.message });

    const today = new Date().toISOString().split('T')[0];
    
    db.get(`SELECT COUNT(*) as upcomingSessions FROM sessions WHERE status IN ('Pending', 'Scheduled') AND session_date >= ?`, [today], (err, sessionStats) => {
      if (err) return res.status(500).json({ error: err.message });

      db.get(`SELECT COUNT(*) as todaySessions FROM sessions WHERE session_date = ?`, [today], (err, todayStats) => {
        if (err) return res.status(500).json({ error: err.message });

        db.get(`SELECT COUNT(*) as totalEvents FROM events WHERE event_status = 'Upcoming'`, (err, eventStats) => {
          if (err) return res.status(500).json({ error: err.message });

          res.json({
            totalStudents: studentStats.totalStudents || 0,
            totalRevenue: studentStats.totalRevenue || 0,
            upcomingSessions: sessionStats.upcomingSessions || 0,
            todaySessions: todayStats.todaySessions || 0,
            upcomingEvents: eventStats.totalEvents || 0
          });
        });
      });
    });
  });
});

// Enhanced student creation with timezone and currency
app.post('/api/students', async (req, res) => {
  const { 
    name, grade, parent_name, parent_email,  primary_contact, alternate_contact, timezone, program_name, 
    class_type, duration, currency, per_session_fee, total_sessions 
  } = req.body;

  const fees_paid = per_session_fee * total_sessions;
  const remaining_sessions = total_sessions;

  db.run(`INSERT INTO students (
    name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, program_name, 
    class_type, duration, currency, per_session_fee, total_sessions, 
    remaining_sessions, fees_paid
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, program_name, 
     class_type, duration, currency, per_session_fee, total_sessions, 
     remaining_sessions, fees_paid],
    async function(err) {
      if (err) return res.status(500).json({ error: err.message });

      // Create initial payment record
      db.run(`INSERT INTO payment_history (student_id, payment_date, amount, currency, payment_method, sessions_covered, notes)
              VALUES (?, ?, ?, ?, 'Initial Payment', 'Sessions 1-${total_sessions}', 'Enrollment payment')`,
        [this.lastID, new Date().toISOString().split('T')[0], fees_paid, currency]);

      // Send enhanced welcome email
      const emailData = {
        parent_name, student_name: name, grade, program_name, class_type, 
        duration, total_sessions, timezone,
        zoom_link: 'https://us04web.zoom.us/j/7288533155?pwd=Nng5N2l0aU12L0FQK245c0VVVHJBUT09'
      };

      const emailHtml = getEmailTemplate('welcome', emailData);
      await sendEmail(parent_email, `🎓 Welcome to Fluent Feathers Academy - ${name}`, emailHtml, parent_name, 'Welcome');

      res.json({ 
        message: `Student ${name} added successfully! Welcome email sent to ${parent_email}.`, 
        studentId: this.lastID 
      });
    }
  );
});
// Update student (Edit student endpoint)
app.put('/api/students/:id', async (req, res) => {
  const studentId = req.params.id;
  const { 
    name, grade, parent_name, parent_email, primary_contact, alternate_contact,
    timezone, program_name, class_type, duration, currency, 
    per_session_fee, total_sessions 
  } = req.body;

  db.run(`UPDATE students SET 
    name = ?, 
    grade = ?, 
    parent_name = ?, 
    parent_email = ?,
    primary_contact = ?, 
    alternate_contact = ?, 
    timezone = ?,
    program_name = ?, 
    class_type = ?, 
    duration = ?, 
    currency = ?,
    per_session_fee = ?, 
    total_sessions = ?
    WHERE id = ?`,
    [name, grade, parent_name, parent_email, primary_contact, alternate_contact,
     timezone, program_name, class_type, duration, currency,
     per_session_fee, total_sessions, studentId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'Student not found' });
      res.json({ message: 'Student updated successfully!' });
    }
  );
});
// Get all students with enhanced data
app.get('/api/students', (req, res) => {
  db.all(`SELECT s.*, 
            COUNT(m.id) as makeup_credits,
            (SELECT COUNT(*) FROM payment_history WHERE student_id = s.id) as payment_records
          FROM students s 
          LEFT JOIN makeup_classes m ON s.id = m.student_id AND m.status = 'Available'
          GROUP BY s.id 
          ORDER BY s.created_at DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get detailed student info with payment history and makeup classes
app.get('/api/students/:id/details', (req, res) => {
  const studentId = req.params.id;
  
  // Get student info
  db.get(`SELECT * FROM students WHERE id = ?`, [studentId], (err, student) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!student) return res.status(404).json({ error: 'Student not found' });

    // Get payment history
    db.all(`SELECT * FROM payment_history WHERE student_id = ? ORDER BY payment_date DESC`, [studentId], (err, payments) => {
      if (err) return res.status(500).json({ error: err.message });

      // Get makeup classes
      db.all(`SELECT * FROM makeup_classes WHERE student_id = ? ORDER BY credit_date DESC`, [studentId], (err, makeupClasses) => {
        if (err) return res.status(500).json({ error: err.message });

        res.json({
          student,
          paymentHistory: payments,
          makeupClasses
        });
      });
    });
  });
});

// Record new payment
app.post('/api/students/:id/payment', (req, res) => {
  const { amount, currency, payment_method, receipt_number, sessions_covered, notes } = req.body;
  const studentId = req.params.id;
  const payment_date = new Date().toISOString().split('T')[0];

  db.run(`INSERT INTO payment_history (student_id, payment_date, amount, currency, payment_method, receipt_number, sessions_covered, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [studentId, payment_date, amount, currency, payment_method, receipt_number, sessions_covered, notes],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });

      // Update student's fees_paid
      db.run(`UPDATE students SET fees_paid = fees_paid + ? WHERE id = ?`, [amount, studentId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Payment recorded successfully!' });
      });
    }
  );
});

// ========== EVENT MANAGEMENT ==========

// Create new event
app.post('/api/events', async (req, res) => {
  const { event_type, event_name, event_description, event_date, event_time, duration, zoom_link, max_participants, registration_deadline } = req.body;

  db.run(`INSERT INTO events (event_type, event_name, event_description, event_date, event_time, duration, zoom_link, max_participants, registration_deadline)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [event_type, event_name, event_description, event_date, event_time, duration, zoom_link, max_participants, registration_deadline],
    async function(err) {
      if (err) return res.status(500).json({ error: err.message });

      // Send announcement email to all students
      db.all(`SELECT * FROM students`, async (err, students) => {
        if (err) return res.status(500).json({ error: err.message });

        for (const student of students) {
          const emailData = {
            parent_name: student.parent_name,
            student_name: student.name,
            event_name, event_type, event_date, event_time, duration,
            event_description, max_participants,
            deadline: registration_deadline,
            registration_link: `${process.env.BASE_URL}/register-event/${this.lastID}/${student.id}`
          };

          const emailHtml = getEmailTemplate('event_announcement', emailData);
          await sendEmail(student.parent_email, `🎉 New Event: ${event_name} - Register Now!`, emailHtml, student.parent_name, 'Event Announcement');
        }
      });

      res.json({ message: 'Event created and announcements sent!', eventId: this.lastID });
    }
  );
});

// Get all events
app.get('/api/events', (req, res) => {
  db.all(`SELECT e.*, 
            COUNT(er.id) as registered_count
          FROM events e 
          LEFT JOIN event_registrations er ON e.id = er.event_id 
          GROUP BY e.id 
          ORDER BY e.event_date DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Register student for event
app.post('/api/events/:eventId/register/:studentId', (req, res) => {
  const { eventId, studentId } = req.params;

  // Get student and event info
  db.get(`SELECT * FROM students WHERE id = ?`, [studentId], (err, student) => {
    if (err) return res.status(500).json({ error: err.message });

    db.get(`SELECT * FROM events WHERE id = ?`, [eventId], (err, event) => {
      if (err) return res.status(500).json({ error: err.message });

      // Check if already registered
      db.get(`SELECT * FROM event_registrations WHERE event_id = ? AND student_id = ?`, [eventId, studentId], (err, existing) => {
        if (err) return res.status(500).json({ error: err.message });
        if (existing) return res.status(400).json({ error: 'Already registered for this event' });

        // Register
        db.run(`INSERT INTO event_registrations (event_id, student_id, parent_name, parent_email)
                VALUES (?, ?, ?, ?)`,
          [eventId, studentId, student.parent_name, student.parent_email],
          async function(err) {
            if (err) return res.status(500).json({ error: err.message });

            // Send confirmation email
            const confirmationHtml = `
              <h2>✅ Registration Confirmed - ${event.event_name}</h2>
              <p>Dear ${student.parent_name},</p>
              <p><strong>${student.name}</strong> has been successfully registered for <strong>${event.event_name}</strong>!</p>
              <p><strong>Date & Time:</strong> ${event.event_date} at ${event.event_time}</p>
              <p>Zoom link will be sent 1 hour before the event.</p>
              <p>Best regards,<br>Fluent Feathers Academy</p>
            `;

            await sendEmail(student.parent_email, `✅ Registration Confirmed - ${event.event_name}`, confirmationHtml, student.parent_name, 'Event Registration');

            res.json({ message: 'Registration successful! Confirmation email sent.' });
          }
        );
      });
    });
  });
});
// Parent cancel specific upcoming class
app.post('/api/parent/cancel-upcoming-class', async (req, res) => {
  const { student_id, session_date, session_time, reason } = req.body;

  // Get student info
  db.get(`SELECT * FROM students WHERE id = ?`, [student_id], (err, student) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!student) return res.status(404).json({ error: 'Student not found' });

    // Find the specific session
    db.get(`SELECT * FROM sessions WHERE student_id = ? AND session_date = ? AND session_time = ? AND status IN ('Pending', 'Scheduled')`,
      [student_id, session_date, session_time], async (err, session) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!session) return res.status(404).json({ error: 'Session not found or already cancelled' });

        // Mark session as cancelled by parent
        db.run(`UPDATE sessions SET status = 'Cancelled by Parent', cancelled_by = 'Parent' WHERE id = ?`, 
          [session.id], (err) => {
            if (err) return res.status(500).json({ error: err.message });

            // Create makeup class credit
            db.run(`INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status, notes)
                    VALUES (?, ?, ?, ?, 'Available', 'Parent cancellation - makeup available')`,
              [student_id, session.id, reason || 'Cancelled by Parent', session_date], (err) => {
                if (err) return res.status(500).json({ error: err.message });

                // Send cancellation confirmation email
                const cancelEmail = `
                  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #e74c3c;">✅ Class Cancellation Confirmed</h2>
                    <p>Dear ${student.parent_name},</p>
                    <p>Your cancellation request has been processed:</p>
                    
                    <div style="background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
                      <p><strong>Student:</strong> ${student.name}</p>
                      <p><strong>Date:</strong> ${session_date}</p>
                      <p><strong>Time:</strong> ${session_time}</p>
                      <p><strong>Session:</strong> #${session.session_number}</p>
                      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
                    </div>
                    
                    <div style="background: #d4edda; padding: 20px; border-radius: 5px; margin: 20px 0; border-left: 5px solid #27ae60;">
                      <h3 style="color: #27ae60; margin-top: 0;">🎁 Makeup Credit Added!</h3>
                      <p>A makeup class credit has been added to ${student.name}'s account.</p>
                      <p>Please contact us to schedule the makeup class at your convenience.</p>
                    </div>
                    
                    <p style="color: #667eea; font-weight: bold;">Best regards,<br>Fluent Feathers Academy Team</p>
                  </div>
                `;

                sendEmail(
                  student.parent_email,
                  `✅ Cancellation Confirmed - ${session_date}`,
                  cancelEmail,
                  student.parent_name,
                  'Parent Cancellation'
                );

                res.json({ 
                  message: 'Class cancelled successfully! Makeup credit added and confirmation email sent.',
                  makeupCredit: true
                });
              });
          });
      });
  });
});
// Mark event attendance 
app.post('/api/events/:eventId/attendance', async (req, res) => {
  const { eventId } = req.params;
  const { attendedStudents } = req.body; // Array of student IDs who attended

  try {
    // Update attendance status
    for (const studentId of attendedStudents) {
      await new Promise((resolve, reject) => {
        db.run(`UPDATE event_registrations SET attendance_status = 'Attended' WHERE event_id = ? AND student_id = ?`,
          [eventId, studentId], (err) => {
            if (err) reject(err);
            else resolve();
          });
      });
    }

  

    res.json({ 
  message: `Attendance marked for ${attendedStudents.length} students.` 
});

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ========== ENHANCED SESSION MANAGEMENT ==========

// Enhanced session creation with detailed tracking
app.post('/api/schedule/classes', async (req, res) => {
  const { student_id, classes } = req.body;
  const ZOOM_LINK = 'https://us04web.zoom.us/j/7288533155?pwd=Nng5N2l0aU12L0FQK245c0VVVHJBUT09';

  // Get student info
  db.get(`SELECT * FROM students WHERE id = ?`, [student_id], async (err, student) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!student) return res.status(404).json({ error: 'Student not found' });

    // Get current session count
    db.get(`SELECT COUNT(*) as count FROM sessions WHERE student_id = ?`, [student_id], async (err, result) => {
      if (err) return res.status(500).json({ error: err.message });

      let sessionNumber = result.count + 1;

      // Insert all sessions
      const stmt = db.prepare(`INSERT INTO sessions (student_id, session_number, session_date, session_time, zoom_link, status) VALUES (?, ?, ?, ?, ?, 'Pending')`);

      for (const cls of classes) {
        stmt.run(student_id, sessionNumber, cls.date, cls.time, ZOOM_LINK);
        sessionNumber++;
      }

      stmt.finalize();

      // Enhanced schedule email with timezone conversion
      const scheduleHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #667eea;">📅 Class Schedule for ${student.name}</h2>
          <p>Dear ${student.parent_name},</p>
          <p>We've scheduled <strong>${classes.length} classes</strong> for ${student.name}:</p>
          
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr style="background: #667eea; color: white;">
              <th style="padding: 12px; border: 1px solid #ddd;">Session #</th>
              <th style="padding: 12px; border: 1px solid #ddd;">Date</th>
              <th style="padding: 12px; border: 1px solid #ddd;">Time (${student.timezone})</th>
            </tr>
            ${classes.map((cls, index) => `
              <tr style="background: ${index % 2 === 0 ? '#f8f9fa' : 'white'};">
                <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">Session ${result.count + index + 1}</td>
                <td style="padding: 10px; border: 1px solid #ddd;">${cls.date}</td>
                <td style="padding: 10px; border: 1px solid #ddd;">${cls.time}</td>
              </tr>
            `).join('')}
          </table>
          
          <div style="background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3 style="color: #667eea;">📱 Important Links</h3>
            <p><strong>Zoom Class Link:</strong> <a href="${ZOOM_LINK}" style="color: #9b59b6;">Join Class</a></p>
            <p><strong>Parent Portal:</strong> <a href="${process.env.BASE_URL || 'http://localhost:3000'}/parent.html">Access Portal</a></p>
            <p><strong>WhatsApp Support:</strong> <a href="https://wa.me/your-number">Quick Chat</a></p>
          </div>
          
          <p style="color: #7f8c8d; font-size: 0.9em;">
            You'll receive reminders 24 hours and 1 hour before each class.<br>
            Use the parent portal to cancel classes, upload homework, and track progress.
          </p>
          
          <p style="color: #667eea; font-weight: bold;">Best regards,<br>Fluent Feathers Academy Team</p>
        </div>
      `;

      await sendEmail(student.parent_email, `📅 Class Schedule for ${student.name}`, scheduleHtml, student.parent_name, 'Schedule');

      res.json({ message: `${classes.length} classes scheduled successfully! Email sent to ${student.parent_name}.` });
    });
  });
});

// Enhanced attendance marking with makeup class credits
app.post('/api/attendance/present/:studentId', async (req, res) => {
  const studentId = req.params.studentId;
  const today = new Date().toISOString().split('T')[0];

  // Get today's session
  db.get(`SELECT * FROM sessions WHERE student_id = ? AND session_date = ? AND status IN ('Pending', 'Scheduled') LIMIT 1`, 
    [studentId, today], (err, session) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!session) return res.status(404).json({ error: 'No scheduled session found for today' });

      // Mark session as completed
      db.run(`UPDATE sessions SET status = 'Completed', attendance = 'Present' WHERE id = ?`, [session.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });

        // Update student's completed and remaining sessions
        db.run(`UPDATE students SET completed_sessions = completed_sessions + 1, remaining_sessions = remaining_sessions - 1 WHERE id = ?`,
          [studentId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Attendance marked as Present! Session completed successfully.' });
          }
        );
      });
    }
  );
});

// Enhanced absence marking with makeup credit
app.post('/api/attendance/absent/:studentId', async (req, res) => {
  const studentId = req.params.studentId;
  const { reason } = req.body;
  const today = new Date().toISOString().split('T')[0];

  db.get(`SELECT * FROM sessions WHERE student_id = ? AND session_date = ? AND status IN ('Pending', 'Scheduled') LIMIT 1`,
    [studentId, today], (err, session) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!session) return res.status(404).json({ error: 'No session found for today' });

      // Mark session as missed
      db.run(`UPDATE sessions SET status = 'Missed', attendance = 'Absent' WHERE id = ?`, [session.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });

        // Create makeup class credit
        db.run(`INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status)
                VALUES (?, ?, ?, ?, 'Available')`,
          [studentId, session.id, reason || 'Student Absent', today], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Marked as Absent. Makeup class credit added to student account.' });
          });
      });
    }
  );
});

// Enhanced class cancellation with detailed logging
app.post('/api/attendance/cancel/:studentId', async (req, res) => {
  const studentId = req.params.studentId;
  const { reason } = req.body;
  const today = new Date().toISOString().split('T')[0];

  // Get student and upcoming session
  db.get(`SELECT * FROM students WHERE id = ?`, [studentId], (err, student) => {
    if (err) return res.status(500).json({ error: err.message });

    db.get(`SELECT * FROM sessions WHERE student_id = ? AND session_date >= ? AND status IN ('Pending', 'Scheduled') ORDER BY session_date ASC LIMIT 1`,
      [studentId, today], async (err, session) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!session) return res.status(404).json({ error: 'No upcoming session found' });

        // Mark session as cancelled
        db.run(`UPDATE sessions SET status = 'Cancelled by Teacher', cancelled_by = 'Teacher' WHERE id = ?`, [session.id], (err) => {
          if (err) return res.status(500).json({ error: err.message });

          // Create makeup class credit
          db.run(`INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status, notes)
                  VALUES (?, ?, ?, ?, 'Available', ?)`,
            [studentId, session.id, reason || 'Cancelled by Teacher', session.session_date, 'Teacher cancellation - makeup available'], (err) => {
              if (err) return res.status(500).json({ error: err.message });

              // Send detailed cancellation email
              const cancelEmailHtml = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                  <h2 style="color: #e74c3c;">📅 Class Cancelled - ${student.name}</h2>
                  <p>Dear ${student.parent_name},</p>
                  <p>We regret to inform you that the class scheduled for:</p>
                  
                  <div style="background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0; border-left: 5px solid #e74c3c;">
                    <p><strong>Date:</strong> ${session.session_date}</p>
                    <p><strong>Time:</strong> ${session.session_time} (${student.timezone})</p>
                    <p><strong>Session:</strong> ${session.session_number}</p>
                    <p><strong>Reason:</strong> ${reason || 'Instructor unavailable'}</p>
                  </div>
                  
                  <div style="background: #d4edda; padding: 20px; border-radius: 5px; margin: 20px 0; border-left: 5px solid #27ae60;">
                    <h3 style="color: #27ae60; margin-top: 0;">✅ Good News!</h3>
                    <p>A <strong>makeup class credit</strong> has been added to ${student.name}'s account.</p>
                    <p>You can schedule the makeup class at your convenience through the parent portal.</p>
                  </div>
                  
                  <p>We sincerely apologize for the inconvenience and appreciate your understanding.</p>
                  <p style="color: #667eea; font-weight: bold;">Best regards,<br>Fluent Feathers Academy Team</p>
                </div>
              `;

              sendEmail(student.parent_email, `📅 Class Cancelled - ${session.session_date}`, cancelEmailHtml, student.parent_name, 'Cancellation');

              res.json({ message: 'Class cancelled successfully! Makeup credit added and confirmation email sent.' });
            });
        });
      }
    );
  });
});

// ========== ENHANCED MATERIAL MANAGEMENT ==========

// Enhanced material upload with session linking
app.post('/api/upload/material/:targetId', upload.single('file'), async (req, res) => {
  const { fileType, sessionDate, uploadType, sessionId } = req.body;
  const targetId = req.params.targetId;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const studentId = uploadType === 'private' ? targetId : null;
  const batchName = uploadType === 'batch' ? targetId : null;

  // Insert into materials table
  db.run(`INSERT INTO materials (student_id, batch_name, session_date, file_type, file_name, file_path, uploaded_by)
          VALUES (?, ?, ?, ?, ?, ?, 'Teacher')`,
    [studentId, batchName, sessionDate, fileType, req.file.originalname, req.file.filename],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });

      // If linked to a specific session, update session record
      if (sessionId && uploadType === 'private') {
        const column = fileType === 'PPT' ? 'ppt_file_path' : 
                      fileType === 'Recording' ? 'recording_file_path' :
                      fileType === 'Homework' ? 'homework_file_path' : null;

        if (column) {
          db.run(`UPDATE sessions SET ${column} = ? WHERE id = ?`, [req.file.filename, sessionId]);
        }
      }

      // Send material notification email to affected students
      if (uploadType === 'private') {
        db.get(`SELECT * FROM students WHERE id = ?`, [targetId], async (err, student) => {
          if (student) {
            const materialEmail = `
              <h2>📚 New Material Available - ${student.name}</h2>
              <p>Dear ${student.parent_name},</p>
              <p>New study material has been uploaded for ${student.name}:</p>
              <ul>
                <li><strong>Type:</strong> ${fileType}</li>
                <li><strong>File:</strong> ${req.file.originalname}</li>
                <li><strong>Session Date:</strong> ${sessionDate}</li>
              </ul>
              <p>Access the parent portal to download the material.</p>
              <p>Best regards,<br>Fluent Feathers Academy</p>
            `;
            
            await sendEmail(student.parent_email, `📚 New Material - ${fileType}`, materialEmail, student.parent_name, 'Material Upload');
          }
        });
      }

      res.json({ message: 'Material uploaded successfully! Notification sent to students.' });
    }
  );
});

// Grade homework
app.post('/api/sessions/:sessionId/grade-homework', (req, res) => {
  const { grade, comments } = req.body;
  const sessionId = req.params.sessionId;

  db.run(`UPDATE sessions SET homework_grade = ?, homework_comments = ? WHERE id = ?`,
    [grade, comments, sessionId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });

      // Get student info and send grade notification
      db.get(`SELECT s.*, st.parent_email, st.parent_name FROM sessions s 
              JOIN students st ON s.student_id = st.id 
              WHERE s.id = ?`, [sessionId], async (err, session) => {
        if (session) {
          const gradeEmail = `
            <h2>📝 Homework Graded - Session ${session.session_number}</h2>
            <p>Dear ${session.parent_name},</p>
            <p>Homework for Session ${session.session_number} (${session.session_date}) has been graded:</p>
            <div style="background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
              <p><strong>Grade:</strong> ${grade}</p>
              <p><strong>Teacher Comments:</strong> ${comments}</p>
            </div>
            <p>Keep up the great work!</p>
            <p>Best regards,<br>Fluent Feathers Academy</p>
          `;
          
          await sendEmail(session.parent_email, `📝 Homework Graded - Session ${session.session_number}`, gradeEmail, session.parent_name, 'Homework Grade');
        }
      });

      res.json({ message: 'Homework graded successfully! Grade sent to parent.' });
    }
  );
});

// ========== AUTOMATED REMINDERS ==========

// 24-hour reminder cron job
cron.schedule('0 9 * * *', async () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = tomorrow.toISOString().split('T')[0];

  db.all(`SELECT s.*, st.parent_email, st.parent_name, st.name as student_name, st.timezone 
          FROM sessions s 
          JOIN students st ON s.student_id = st.id 
          WHERE s.session_date = ? AND s.status IN ('Pending', 'Scheduled')`,
    [tomorrowDate], async (err, sessions) => {
      if (err) return;

      for (const session of sessions) {
        const reminderEmail = `
          <h2>📅 Class Reminder - Tomorrow at ${session.session_time}</h2>
          <p>Dear ${session.parent_name},</p>
          <p>Reminder: <strong>${session.student_name}</strong> has a class tomorrow!</p>
          <div style="background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Date:</strong> ${session.session_date}</p>
            <p><strong>Time:</strong> ${session.session_time} (${session.timezone})</p>
            <p><strong>Session:</strong> ${session.session_number}</p>
          </div>
          <div style="text-align: center; margin: 20px 0;">
            <a href="${session.zoom_link}" style="background: #9b59b6; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px;">📱 Join Zoom Class</a>
          </div>
          <p>Best regards,<br>Fluent Feathers Academy</p>
        `;

        await sendEmail(session.parent_email, `📅 Class Tomorrow - ${session.student_name}`, reminderEmail, session.parent_name, '24h Reminder');
      }
    }
  );
});

// 1-hour reminder cron job
cron.schedule('0 * * * *', async () => {
  const now = new Date();
  const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);
  const currentDate = now.toISOString().split('T')[0];
  const targetTime = oneHourLater.toTimeString().slice(0, 5);

  db.all(`SELECT s.*, st.parent_email, st.parent_name, st.name as student_name 
          FROM sessions s 
          JOIN students st ON s.student_id = st.id 
          WHERE s.session_date = ? AND s.session_time = ? AND s.status IN ('Pending', 'Scheduled')`,
    [currentDate, targetTime], async (err, sessions) => {
      if (err) return;

      for (const session of sessions) {
        const urgentEmail = `
          <div style="background: #e74c3c; color: white; text-align: center; padding: 20px; border-radius: 10px;">
            <h2>🔴 CLASS STARTING IN 1 HOUR!</h2>
            <h3>${session.student_name} - Session ${session.session_number}</h3>
            <p style="font-size: 1.2em;">Starting at ${session.session_time}</p>
            <a href="${session.zoom_link}" style="background: white; color: #e74c3c; padding: 20px 40px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block; margin-top: 20px;">🎥 JOIN NOW</a>
          </div>
        `;

        await sendEmail(session.parent_email, `🔴 CLASS IN 1 HOUR - ${session.student_name}`, urgentEmail, session.parent_name, '1h Reminder');
      }
    }
  );
});
// Get sessions for a student
app.get('/api/sessions/:studentId', (req, res) => {
  db.all(`SELECT * FROM sessions WHERE student_id = ? ORDER BY session_date ASC`, 
    [req.params.studentId], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
  });
});

// Get upcoming sessions
app.get('/api/sessions/upcoming/:studentId', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  db.all(`SELECT * FROM sessions WHERE student_id = ? AND session_date >= ? AND status IN ('Pending', 'Scheduled') ORDER BY session_date ASC`, 
    [req.params.studentId, today], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
  });
});

// Get completed sessions
app.get('/api/sessions/completed/:studentId', (req, res) => {
  db.all(`SELECT * FROM sessions WHERE student_id = ? AND status = 'Completed' ORDER BY session_date DESC`, 
    [req.params.studentId], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
  });
});

// Get student by ID
app.get('/api/students/:id', (req, res) => {
  db.get(`SELECT * FROM students WHERE id = ?`, [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Student not found' });
    res.json(row);
  });
});

// Check if parent email exists and has password
app.post('/api/parent/check-email', (req, res) => {
  const { email } = req.body;
  
  db.get(`SELECT * FROM students WHERE parent_email = ?`, [email], (err, student) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!student) return res.status(404).json({ error: 'No student found with this email. Please contact admin.' });
    
    // Check if password exists
    db.get(`SELECT * FROM parent_credentials WHERE parent_email = ?`, [email], (err, cred) => {
      if (err) return res.status(500).json({ error: err.message });
      
      res.json({ 
        exists: true, 
        hasPassword: cred && cred.password ? true : false 
      });
    });
  });
});

// Setup password for first-time login
app.post('/api/parent/setup-password', (req, res) => {
  const { email, password } = req.body;
  
  // Verify student exists
  db.get(`SELECT * FROM students WHERE parent_email = ?`, [email], (err, student) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!student) return res.status(404).json({ error: 'Student not found' });
    
    const hashedPassword = hashPassword(password);
    
    // Insert or update credentials
    db.run(`INSERT INTO parent_credentials (parent_email, password) 
            VALUES (?, ?) 
            ON CONFLICT(parent_email) DO UPDATE SET password = ?`,
      [email, hashedPassword, hashedPassword],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        // Update last login
        db.run(`UPDATE parent_credentials SET last_login = CURRENT_TIMESTAMP WHERE parent_email = ?`, [email]);
        
        res.json({ message: 'Password set successfully', student });
      }
    );
  });
});

// Login with password
app.post('/api/parent/login-password', (req, res) => {
  const { email, password } = req.body;
  
  db.get(`SELECT * FROM parent_credentials WHERE parent_email = ?`, [email], (err, cred) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!cred || !cred.password) return res.status(404).json({ error: 'Password not set. Please use OTP login.' });
    
    // Verify password
    if (!verifyPassword(password, cred.password)) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    
    // Get student data
    db.get(`SELECT * FROM students WHERE parent_email = ?`, [email], (err, student) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // Update last login
      db.run(`UPDATE parent_credentials SET last_login = CURRENT_TIMESTAMP WHERE parent_email = ?`, [email]);
      
      res.json({ message: 'Login successful', student });
    });
  });
});

// Send OTP to email
app.post('/api/parent/send-otp', async (req, res) => {
  const { email } = req.body;
  
  // Verify student exists
  db.get(`SELECT * FROM students WHERE parent_email = ?`, [email], async (err, student) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!student) return res.status(404).json({ error: 'Student not found' });
    
    // Generate OTP
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    
    // Save OTP
    db.run(`INSERT INTO parent_credentials (parent_email, otp, otp_expiry, otp_attempts) 
            VALUES (?, ?, ?, 0) 
            ON CONFLICT(parent_email) DO UPDATE SET 
              otp = ?, 
              otp_expiry = ?, 
              otp_attempts = 0`,
      [email, otp, otpExpiry.toISOString(), otp, otpExpiry.toISOString()],
      async function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        // Send OTP email
        const otpEmail = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8f9fa; padding: 30px; border-radius: 10px;">
            <div style="background: white; padding: 30px; border-radius: 8px; text-align: center;">
              <h2 style="color: #667eea; margin-bottom: 20px;">🔐 Your Login OTP</h2>
              <p style="color: #2c3e50; font-size: 16px; margin-bottom: 30px;">Dear ${student.parent_name},</p>
              
              <div style="background: #667eea; color: white; padding: 20px; border-radius: 8px; margin: 30px 0;">
                <p style="font-size: 14px; margin-bottom: 10px;">Your One-Time Password (OTP) is:</p>
                <h1 style="font-size: 48px; letter-spacing: 10px; margin: 10px 0;">${otp}</h1>
              </div>
              
              <p style="color: #e74c3c; font-weight: bold; margin: 20px 0;">⏱️ Valid for 10 minutes only</p>
              
              <p style="color: #7f8c8d; font-size: 14px; margin-top: 30px;">
                If you didn't request this OTP, please ignore this email or contact us immediately.
              </p>
              
              <div style="border-top: 2px solid #eee; margin-top: 30px; padding-top: 20px;">
                <p style="color: #667eea; font-weight: bold; margin: 0;">Fluent Feathers Academy</p>
                <p style="color: #7f8c8d; font-size: 12px;">Secure Login System</p>
              </div>
            </div>
          </div>
        `;
        
        const emailSent = await sendEmail(email, '🔐 Your Login OTP - Fluent Feathers Academy', otpEmail, student.parent_name, 'OTP Login');
        
        if (emailSent) {
          res.json({ message: 'OTP sent successfully', expiresIn: '10 minutes' });
        } else {
          res.status(500).json({ error: 'Failed to send OTP email' });
        }
      }
    );
  });
});

// Verify OTP
app.post('/api/parent/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  
  db.get(`SELECT * FROM parent_credentials WHERE parent_email = ?`, [email], (err, cred) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!cred || !cred.otp) return res.status(404).json({ error: 'No OTP found. Please request a new one.' });
    
    // Check OTP attempts
    if (cred.otp_attempts >= 5) {
      return res.status(429).json({ error: 'Too many failed attempts. Please request a new OTP.' });
    }
    
    // Check OTP expiry
    const now = new Date();
    const expiry = new Date(cred.otp_expiry);
    if (now > expiry) {
      return res.status(401).json({ error: 'OTP expired. Please request a new one.' });
    }
    
    // Verify OTP
    if (cred.otp !== otp) {
      // Increment failed attempts
      db.run(`UPDATE parent_credentials SET otp_attempts = otp_attempts + 1 WHERE parent_email = ?`, [email]);
      return res.status(401).json({ error: 'Incorrect OTP. Please try again.' });
    }
    
    // OTP verified - clear OTP and get student data
    db.run(`UPDATE parent_credentials SET otp = NULL, otp_expiry = NULL, otp_attempts = 0, last_login = CURRENT_TIMESTAMP WHERE parent_email = ?`, 
      [email], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.get(`SELECT * FROM students WHERE parent_email = ?`, [email], (err, student) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ message: 'Login successful', student });
        });
      }
    );
  });
});

// Parent cancel class
app.post('/api/parent/cancel/:studentId', async (req, res) => {
  const studentId = req.params.studentId;
  const today = new Date().toISOString().split('T')[0];

  // Get student and upcoming session
  db.get(`SELECT * FROM students WHERE id = ?`, [studentId], (err, student) => {
    if (err) return res.status(500).json({ error: err.message });

    db.get(`SELECT * FROM sessions WHERE student_id = ? AND session_date >= ? AND status IN ('Pending', 'Scheduled') ORDER BY session_date ASC LIMIT 1`,
      [studentId, today], async (err, session) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!session) return res.status(404).json({ error: 'No upcoming session found' });

        // Mark session as cancelled
        db.run(`UPDATE sessions SET status = 'Cancelled by Parent', cancelled_by = 'Parent' WHERE id = ?`, 
          [session.id], (err) => {
            if (err) return res.status(500).json({ error: err.message });

            // Update student's remaining sessions
            db.run(`UPDATE students SET remaining_sessions = remaining_sessions + 1 WHERE id = ?`,
              [studentId], async (err) => {
                if (err) return res.status(500).json({ error: err.message });

                // Send cancellation email
                const cancelEmail = `
                  <h2>❌ Class Cancelled</h2>
                  <p>Dear ${student.parent_name},</p>
                  <p>The following class has been cancelled as requested:</p>
                  <ul>
                    <li><strong>Date:</strong> ${session.session_date}</li>
                    <li><strong>Time:</strong> ${session.session_time}</li>
                    <li><strong>Session:</strong> ${session.session_number}</li>
                  </ul>
                  <p>This session has been added back to your remaining sessions count.</p>
                  <p>To reschedule, please contact us via WhatsApp or email.</p>
                  <p>Best regards,<br>Fluent Feathers Academy</p>
                `;

                await sendEmail(
                  student.parent_email,
                  `Class Cancelled - ${session.session_date}`,
                  cancelEmail,
                  student.parent_name,
                  'Parent Cancellation'
                );

                res.json({ message: 'Class cancelled successfully! Remaining sessions updated and confirmation email sent.' });
              });
          });
      });
  });
});

// Upload homework from parent
app.post('/api/upload/homework/:studentId', upload.single('file'), async (req, res) => {
  const { sessionDate } = req.body;
  const studentId = req.params.studentId;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  db.run(`INSERT INTO materials (student_id, session_date, file_type, file_name, file_path, uploaded_by)
          VALUES (?, ?, 'Homework', ?, ?, 'Parent')`,
    [studentId, sessionDate, req.file.originalname, req.file.filename],
    async function(err) {
      if (err) return res.status(500).json({ error: err.message });

      // Get student info to send notification
      db.get(`SELECT * FROM students WHERE id = ?`, [studentId], async (err, student) => {
        if (student) {
          const homeworkEmail = `
            <h2>📝 New Homework Submitted</h2>
            <p>Dear Teacher,</p>
            <p><strong>${student.name}</strong> has submitted homework:</p>
            <ul>
              <li><strong>Session Date:</strong> ${sessionDate}</li>
              <li><strong>File:</strong> ${req.file.originalname}</li>
            </ul>
            <p>Please review and provide feedback.</p>
          `;
          
          await sendEmail(
            process.env.EMAIL_USER,
            `Homework Submitted - ${student.name}`,
            homeworkEmail,
            'Teacher',
            'Homework Submission'
          );
        }
      });

      res.json({ message: 'Homework uploaded successfully!' });
    }
  );
});

// Get all materials (admin view)
app.get('/api/materials/all/admin', (req, res) => {
  db.all(`SELECT * FROM materials ORDER BY uploaded_at DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get materials for student
app.get('/api/materials/:studentId', (req, res) => {
  db.all(`SELECT * FROM materials WHERE student_id = ? OR batch_name IS NOT NULL ORDER BY uploaded_at DESC`, 
    [req.params.studentId], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
  });
});

// Delete material
app.delete('/api/materials/:id', (req, res) => {
  db.get(`SELECT * FROM materials WHERE id = ?`, [req.params.id], (err, material) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!material) return res.status(404).json({ error: 'Material not found' });

    // Delete file
    const filePath = path.join(__dirname, 'uploads', material.file_path);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    db.run(`DELETE FROM materials WHERE id = ?`, [req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Material deleted successfully' });
    });
  });
});

// Get email log
app.get('/api/emails/log', (req, res) => {
  db.all(`SELECT * FROM email_log ORDER BY sent_at DESC LIMIT 100`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get all events
app.get('/api/events', (req, res) => {
  db.all(`SELECT e.*, COUNT(er.id) as registered_count
          FROM events e 
          LEFT JOIN event_registrations er ON e.id = er.event_id 
          GROUP BY e.id 
          ORDER BY e.event_date DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get event registrations
app.get('/api/events/:eventId/registrations', (req, res) => {
  db.all(`SELECT * FROM event_registrations WHERE event_id = ?`, 
    [req.params.eventId], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
  });
});

// Mark event complete
app.post('/api/events/:eventId/complete', (req, res) => {
  db.run(`UPDATE events SET event_status = 'Completed' WHERE id = ?`, 
    [req.params.eventId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Event marked as complete' });
  });
});

// Timetable endpoints
app.get('/api/timetable/slots', (req, res) => {
  db.all(`SELECT * FROM timetable ORDER BY 
          CASE day_of_week 
            WHEN 'Monday' THEN 1 
            WHEN 'Tuesday' THEN 2 
            WHEN 'Wednesday' THEN 3 
            WHEN 'Thursday' THEN 4 
            WHEN 'Friday' THEN 5 
            WHEN 'Saturday' THEN 6 
            WHEN 'Sunday' THEN 7 
          END, time_slot`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/timetable/slots', (req, res) => {
  const { day_of_week, time_slot } = req.body;
  
  db.run(`INSERT INTO timetable (day_of_week, time_slot) VALUES (?, ?)`,
    [day_of_week, time_slot], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Slot added successfully', id: this.lastID });
  });
});

app.post('/api/timetable/book/:slotId', (req, res) => {
  const { student_id, student_name, program_name, duration } = req.body;
  
  db.run(`UPDATE timetable SET is_booked = 1, student_id = ?, student_name = ?, program_name = ?, duration = ? WHERE id = ?`,
    [student_id, student_name, program_name, duration, req.params.slotId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Slot booked successfully' });
  });
});

app.post('/api/timetable/unbook/:slotId', (req, res) => {
  db.run(`UPDATE timetable SET is_booked = 0, student_id = NULL, student_name = NULL, program_name = NULL, duration = NULL WHERE id = ?`,
    [req.params.slotId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Slot freed successfully' });
  });
});

app.delete('/api/timetable/slots/:id', (req, res) => {
  db.run(`DELETE FROM timetable WHERE id = ?`, [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Slot deleted successfully' });
  });
});

// Delete student
app.delete('/api/students/:id', (req, res) => {
  db.run(`DELETE FROM students WHERE id = ?`, [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Student deleted successfully' });
  });
});
// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  🎓 FLUENT FEATHERS ACADEMY LMS V2.0  ║
║  ✅ Server running on port ${PORT}       ║
║  📡 http://localhost:${PORT}              ║
║  🚀 Enhanced Features Active           ║
║  📧 Email Automation Running           ║
║  🤖 Reminder System Active             ║      ║
╚════════════════════════════════════════╝
  `);
});
// trigger railway deploy

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server gracefully...');
  db.close((err) => {
    if (err) console.error(err.message);
    else console.log('✅ Database connection closed');
    process.exit(0);
  });
});
