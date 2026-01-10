// force rebuild - smtp switch - PostgreSQL Version
console.log("🚀 SERVER FILE STARTED");
const { Pool } = require('pg');
require('dotenv').config(); // 👈 move this UP
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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/uploads/homework/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'uploads', 'homework', req.params.filename);
  
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

// Initialize database tables with ENHANCED SCHEMA
async function initializeDatabase() {
  try {
    // Enhanced Students table with timezone and currency
    await pool.query(`CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
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
      per_session_fee DECIMAL(10,2) NOT NULL,
      total_sessions INTEGER NOT NULL,
      completed_sessions INTEGER DEFAULT 0,
      remaining_sessions INTEGER,
      fees_paid DECIMAL(10,2) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Enhanced Sessions table with detailed tracking
    await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
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
      parent_feedback TEXT,
      ppt_file_path TEXT,
      recording_file_path TEXT,
      homework_file_path TEXT,
      homework_grade TEXT,
      homework_comments TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    )`);

    // Materials table
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

    // Make-up Classes table
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

    // Payment History table
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

    // Events table
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

    // Event Registrations table
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

    // Timetable table
    await pool.query(`CREATE TABLE IF NOT EXISTS timetable (
      id SERIAL PRIMARY KEY,
      day_of_week TEXT NOT NULL,
      time_slot TEXT NOT NULL,
      is_booked INTEGER DEFAULT 0,
      student_id INTEGER,
      student_name TEXT,
      program_name TEXT,
      duration TEXT,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL
    )`);

    // Email log table
    await pool.query(`CREATE TABLE IF NOT EXISTS email_log (
      id SERIAL PRIMARY KEY,
      recipient_name TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      email_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL,
      sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Parent Login Credentials table
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

    console.log('✅ Enhanced database tables initialized');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  }
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
}// ==================== ENHANCED EMAIL TEMPLATES WITH PROPER HTML ====================
function getEmailTemplate(type, data) {
  const templates = {
    welcome: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome to Fluent Feathers Academy</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7fa;">
        <table role="presentation" style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 30px 0; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
              <h1 style="color: white; margin: 0; font-size: 32px; font-weight: 600;">🎓 Fluent Feathers Academy</h1>
              <p style="color: white; margin: 10px 0 0 0; font-size: 16px;">Empowering Young Minds</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px 20px;">
              <table role="presentation" style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden;">
                <tr>
                  <td style="padding: 50px 40px;">
                    <h2 style="color: #2c3e50; margin: 0 0 20px 0; font-size: 28px;">Welcome to Our Learning Family!</h2>
                    <p style="font-size: 17px; color: #555; line-height: 1.7; margin: 0 0 15px 0;">Dear ${data.parent_name},</p>
                    <p style="font-size: 17px; color: #555; line-height: 1.7; margin: 0 0 30px 0;">We're absolutely delighted to welcome <strong style="color: #667eea;">${data.student_name}</strong> to our ${data.program_name} program! This is the beginning of an exciting learning journey.</p>
                    
                    <div style="background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); padding: 30px; border-radius: 10px; margin: 30px 0; border-left: 5px solid #667eea;">
                      <h3 style="color: #667eea; margin: 0 0 25px 0; font-size: 22px;">📋 Enrollment Summary</h3>
                      <table style="width: 100%; border-collapse: collapse;">
                        <tr style="border-bottom: 1px solid #dee2e6;">
                          <td style="padding: 15px 0; font-weight: 600; color: #495057; font-size: 15px;">Student Name:</td>
                          <td style="padding: 15px 0; color: #495057; text-align: right; font-size: 15px;">${data.student_name}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #dee2e6;">
                          <td style="padding: 15px 0; font-weight: 600; color: #495057; font-size: 15px;">Grade Level:</td>
                          <td style="padding: 15px 0; color: #495057; text-align: right; font-size: 15px;">${data.grade}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #dee2e6;">
                          <td style="padding: 15px 0; font-weight: 600; color: #495057; font-size: 15px;">Program:</td>
                          <td style="padding: 15px 0; color: #495057; text-align: right; font-size: 15px;">${data.program_name}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #dee2e6;">
                          <td style="padding: 15px 0; font-weight: 600; color: #495057; font-size: 15px;">Class Format:</td>
                          <td style="padding: 15px 0; color: #495057; text-align: right; font-size: 15px;">${data.class_type}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #dee2e6;">
                          <td style="padding: 15px 0; font-weight: 600; color: #495057; font-size: 15px;">Session Duration:</td>
                          <td style="padding: 15px 0; color: #495057; text-align: right; font-size: 15px;">${data.duration}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #dee2e6;">
                          <td style="padding: 15px 0; font-weight: 600; color: #495057; font-size: 15px;">Total Sessions:</td>
                          <td style="padding: 15px 0; color: #495057; text-align: right; font-size: 15px;">${data.total_sessions}</td>
                        </tr>
                        <tr>
                          <td style="padding: 15px 0; font-weight: 600; color: #495057; font-size: 15px;">Your Timezone:</td>
                          <td style="padding: 15px 0; color: #495057; text-align: right; font-size: 15px;">${data.timezone}</td>
                        </tr>
                      </table>
                    </div>

                    <div style="text-align: center; margin: 40px 0;">
                      <a href="${data.zoom_link}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 18px 50px; text-decoration: none; border-radius: 30px; font-weight: 600; font-size: 17px; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); transition: all 0.3s;">🎥 Access Your Classroom</a>
                    </div>

                    <div style="background: #d1ecf1; padding: 25px; border-radius: 10px; border-left: 5px solid #17a2b8; margin: 30px 0;">
                      <h4 style="margin: 0 0 15px 0; color: #0c5460; font-size: 18px;">📅 What Happens Next?</h4>
                      <ul style="margin: 0; padding-left: 20px; color: #0c5460; line-height: 1.8;">
                        <li>Your detailed class schedule will arrive within 24 hours</li>
                        <li>You'll receive automatic reminders before each session</li>
                        <li>Access your parent portal anytime to track progress</li>
                        <li>Our support team is here whenever you need us</li>
                      </ul>
                    </div>

                    <p style="font-size: 15px; color: #6c757d; line-height: 1.7; margin: 30px 0 0 0; text-align: center;">
                      Have questions? Simply reply to this email or contact us anytime. We're here to help!
                    </p>

                    <div style="text-align: center; margin-top: 40px; padding-top: 30px; border-top: 2px solid #eee;">
                      <p style="color: #667eea; font-weight: 600; font-size: 17px; margin: 0 0 5px 0;">Warm regards,</p>
                      <p style="color: #667eea; font-weight: 600; font-size: 17px; margin: 0;">The Fluent Feathers Team</p>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 30px 20px; text-align: center; font-size: 13px; color: #999;">
              <p style="margin: 0 0 8px 0;">© 2025 Fluent Feathers Academy. All rights reserved.</p>
              <p style="margin: 0;">You're receiving this because ${data.student_name} enrolled in our program.</p>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
    
    event_announcement: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7fa;">
        <table role="presentation" style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 30px 0; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">🎉 Special Event Announcement</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px 20px;">
              <table role="presentation" style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
                <tr>
                  <td style="padding: 50px 40px;">
                    <h2 style="color: #2c3e50; margin: 0 0 20px 0; font-size: 26px;">${data.event_name}</h2>
                    <p style="font-size: 17px; color: #555; line-height: 1.7; margin: 0 0 15px 0;">Dear ${data.parent_name},</p>
                    <p style="font-size: 17px; color: #555; line-height: 1.7; margin: 0 0 30px 0;">We're excited to invite <strong>${data.student_name}</strong> to participate in our upcoming ${data.event_type}!</p>
                    
                    <div style="background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); padding: 30px; border-radius: 10px; margin: 30px 0; border-left: 5px solid #667eea;">
                      <h3 style="color: #667eea; margin: 0 0 20px 0; font-size: 20px;">📅 Event Details</h3>
                      <p style="margin: 12px 0; color: #2c3e50; font-size: 16px;"><strong>Event:</strong> ${data.event_name}</p>
                      <p style="margin: 12px 0; color: #2c3e50; font-size: 16px;"><strong>Date & Time:</strong> ${data.event_date} at ${data.event_time}</p>
                      <p style="margin: 12px 0; color: #2c3e50; font-size: 16px;"><strong>Duration:</strong> ${data.duration}</p>
                      <p style="margin: 12px 0; color: #2c3e50; font-size: 16px;"><strong>Format:</strong> ${data.event_type}</p>
                      <p style="margin: 12px 0; color: #2c3e50; font-size: 16px;"><strong>Platform:</strong> Online via Zoom</p>
                      ${data.max_participants > 0 ? `<p style="margin: 12px 0; color: #e74c3c; font-weight: 600; font-size: 16px;">⚠️ Limited to ${data.max_participants} participants</p>` : '<p style="margin: 12px 0; color: #27ae60; font-size: 16px;">✓ Open to all students</p>'}
                      <p style="margin-top: 20px; color: #2c3e50; line-height: 1.7; font-size: 15px;">${data.event_description}</p>
                    </div>

                    <div style="text-align: center; margin: 40px 0;">
                      <a href="${data.registration_link}" style="display: inline-block; background: linear-gradient(135deg, #27ae60 0%, #229954 100%); color: white; padding: 18px 50px; text-decoration: none; border-radius: 30px; font-weight: 600; font-size: 17px; box-shadow: 0 4px 15px rgba(39, 174, 96, 0.4);">📝 Register ${data.student_name} Now</a>
                    </div>

                    <p style="color: #e74c3c; font-weight: 600; text-align: center; margin: 25px 0; font-size: 16px; background: #fee; padding: 15px; border-radius: 8px;">⏰ Registration Deadline: ${data.deadline}</p>
                    
                    <p style="font-size: 15px; color: #6c757d; line-height: 1.7; margin-top: 30px; text-align: center;">
                      Questions? Just reply to this email. We're here to help!
                    </p>
                    
                    <div style="text-align: center; margin-top: 40px; padding-top: 30px; border-top: 2px solid #eee;">
                      <p style="color: #667eea; font-weight: 600; font-size: 17px; margin: 0 0 5px 0;">Best regards,</p>
                      <p style="color: #667eea; font-weight: 600; font-size: 17px; margin: 0;">Fluent Feathers Academy Team</p>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 30px 20px; text-align: center; font-size: 13px; color: #999;">
              <p style="margin: 0 0 8px 0;">© 2025 Fluent Feathers Academy</p>
              <p style="margin: 0;">Sent to ${data.parent_name}</p>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `
  };
  
  return templates[type] || '';
}

// ==================== ENHANCED TEST EMAIL ENDPOINT ====================
app.post('/api/test-email', async (req, res) => {
  const { email } = req.body;
  
  console.log('🧪 Starting detailed email test...');
  console.log('📧 Sender:', process.env.EMAIL_USER);
  console.log('📬 Recipient:', email);
  
  const testHTML = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="font-family: Arial, sans-serif; padding: 30px; background: #f4f7fa;">
      <div style="max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
        <h1 style="color: #667eea; text-align: center;">✅ Email Test Successful!</h1>
        <p style="font-size: 18px; color: #2c3e50;">Congratulations! Your email system is working correctly.</p>
        
        <div style="background: #d4edda; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #28a745;">
          <h3 style="color: #155724; margin-top: 0;">Test Details:</h3>
          <ul style="color: #155724;">
            <li><strong>Sender:</strong> ${process.env.EMAIL_USER}</li>
            <li><strong>Time (IST):</strong> ${convertToIST(new Date().toISOString())}</li>
            <li><strong>TLS Encryption:</strong> ✓ Enabled</li>
            <li><strong>Authentication:</strong> ✓ SMTP API Key</li>
            <li><strong>Plain Text Version:</strong> ✓ Included</li>
          </ul>
        </div>
        
        <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ffc107;">
          <p style="color: #856404; margin: 0;">
            <strong>⚠️ Important:</strong> If this email landed in your spam folder, mark it as "Not Spam" 
            and add <strong>${process.env.EMAIL_USER}</strong> to your contacts.
          </p>
        </div>
        
        <p style="color: #7f8c8d; font-size: 14px; margin-top: 30px; text-align: center;">
          If you received this email, your Fluent Feathers LMS email system is configured correctly for 2025!
        </p>
        
        <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 2px solid #eee;">
          <p style="color: #667eea; font-weight: bold; margin: 0;">Fluent Feathers Academy</p>
          <p style="color: #7f8c8d; font-size: 12px;">Email System Test</p>
        </div>
      </div>
    </body>
    </html>
  `;
  
  const success = await sendEmail(
    email,
    '✅ Test Email - Fluent Feathers Academy [2025 System Check]',
    testHTML,
    'Test Recipient',
    'Test'
  );
  
  if (success) {
    res.json({ 
      success: true,
      message: '✅ Test email sent successfully! Check your inbox and spam folder.',
      details: {
        sender: process.env.EMAIL_USER,
        recipient: email,
        timestamp: new Date().toISOString(),
        timestampIST: convertToIST(new Date().toISOString())
      }
    });
  } else {
    res.status(500).json({ 
      success: false,
      error: '❌ Failed to send test email. Check server console logs for detailed error messages.'
    });
  }
});

// Enhanced file upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadType = req.body.uploadType || 'homework';
    let dest = 'uploads/homework/';
    
    switch (uploadType) {
      case 'homework':
        dest = 'uploads/homework/';
        break;
      case 'settings':
        dest = 'uploads/settings/';
        break;
      default:
        dest = 'uploads/homework/';
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

// Submit homework feedback
app.post('/api/homework/:homeworkId/feedback', async (req, res) => {
  const homeworkId = req.params.homeworkId;
  const { grade, comments } = req.body;
  
  try {
    // Get homework details
    const homeworkResult = await pool.query(
      'SELECT * FROM materials WHERE id = $1',
      [homeworkId]
    );
    
    if (homeworkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Homework not found' });
    }
    
    const homework = homeworkResult.rows[0];
    
    // Get student details
    const studentResult = await pool.query(
      'SELECT * FROM students WHERE id = $1',
      [homework.student_id]
    );
    
    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    
    const student = studentResult.rows[0];
    
    // Update materials with feedback
    await pool.query(
      `UPDATE materials SET 
        feedback_grade = $1,
        feedback_comments = $2,
        feedback_given = 1,
        feedback_date = CURRENT_TIMESTAMP
        WHERE id = $3`,
      [grade, comments, homeworkId]
    );
    
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});// ========== ENHANCED API ROUTES ==========

// Dashboard stats with enhanced metrics
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const studentStats = await pool.query(
      `SELECT COUNT(*) as totalstudents, SUM(fees_paid) as totalrevenue FROM students`
    );
    
    const today = new Date().toISOString().split('T')[0];
    
    const sessionStats = await pool.query(
      `SELECT COUNT(*) as upcomingsessions FROM sessions WHERE status IN ('Pending', 'Scheduled') AND session_date >= $1`,
      [today]
    );
    
    const todayStats = await pool.query(
      `SELECT COUNT(*) as todaysessions FROM sessions WHERE session_date = $1`,
      [today]
    );
    
    const eventStats = await pool.query(
      `SELECT COUNT(*) as totalevents FROM events WHERE event_status = 'Upcoming'`
    );
    
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

// Enhanced student creation with timezone and currency
app.post('/api/students', async (req, res) => {
  const { 
    name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, program_name, 
    class_type, duration, currency, per_session_fee, total_sessions 
  } = req.body;

  const fees_paid = per_session_fee * total_sessions;
  const remaining_sessions = total_sessions;

  try {
    const result = await pool.query(
      `INSERT INTO students (
        name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, program_name, 
        class_type, duration, currency, per_session_fee, total_sessions, 
        remaining_sessions, fees_paid
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, program_name, 
       class_type, duration, currency, per_session_fee, total_sessions, 
       remaining_sessions, fees_paid]
    );

    const studentId = result.rows[0].id;

    // Create initial payment record
    await pool.query(
      `INSERT INTO payment_history (student_id, payment_date, amount, currency, payment_method, sessions_covered, notes)
       VALUES ($1, $2, $3, $4, 'Initial Payment', $5, 'Enrollment payment')`,
      [studentId, new Date().toISOString().split('T')[0], fees_paid, currency, `Sessions 1-${total_sessions}`]
    );

    // Send enhanced welcome email
    const emailData = {
      parent_name, student_name: name, grade, program_name, class_type, 
      duration, total_sessions, timezone,
      zoom_link: 'https://us04web.zoom.us/j/7288533155?pwd=Nng5N2l0aU12L0FQK245c0VVVHJBUT09'
    };

    const emailHtml = getEmailTemplate('welcome', emailData);
    await sendEmail(parent_email, `Welcome to Fluent Feathers Academy - ${name}`, emailHtml, parent_name, 'Welcome');

    res.json({ 
      message: `Student ${name} added successfully! Welcome email sent to ${parent_email}.`, 
      studentId 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update student (Edit student endpoint)
app.put('/api/students/:id', async (req, res) => {
  const studentId = req.params.id;
  const { 
    name, grade, parent_name, parent_email, primary_contact, alternate_contact,
    timezone, program_name, class_type, duration, currency, 
    per_session_fee, total_sessions 
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE students SET 
        name = $1, 
        grade = $2, 
        parent_name = $3, 
        parent_email = $4,
        primary_contact = $5, 
        alternate_contact = $6, 
        timezone = $7,
        program_name = $8, 
        class_type = $9, 
        duration = $10, 
        currency = $11,
        per_session_fee = $12, 
        total_sessions = $13
        WHERE id = $14`,
      [name, grade, parent_name, parent_email, primary_contact, alternate_contact,
       timezone, program_name, class_type, duration, currency,
       per_session_fee, total_sessions, studentId]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    
    res.json({ message: 'Student updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all students with enhanced data
app.get('/api/students', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, 
        COUNT(m.id) as makeup_credits,
        (SELECT COUNT(*) FROM payment_history WHERE student_id = s.id) as payment_records
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

// Get detailed student info with payment history and makeup classes
app.get('/api/students/:id/details', async (req, res) => {
  const studentId = req.params.id;
  
  try {
    // Get student info
    const studentResult = await pool.query(
      `SELECT * FROM students WHERE id = $1`,
      [studentId]
    );
    
    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    
    const student = studentResult.rows[0];

    // Get payment history
    const paymentsResult = await pool.query(
      `SELECT * FROM payment_history WHERE student_id = $1 ORDER BY payment_date DESC`,
      [studentId]
    );

    // Get makeup classes
    const makeupResult = await pool.query(
      `SELECT * FROM makeup_classes WHERE student_id = $1 ORDER BY credit_date DESC`,
      [studentId]
    );

    res.json({
      student,
      paymentHistory: paymentsResult.rows,
      makeupClasses: makeupResult.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record new payment
app.post('/api/students/:id/payment', async (req, res) => {
  const { amount, currency, payment_method, receipt_number, sessions_covered, notes } = req.body;
  const studentId = req.params.id;
  const payment_date = new Date().toISOString().split('T')[0];

  try {
    await pool.query(
      `INSERT INTO payment_history (student_id, payment_date, amount, currency, payment_method, receipt_number, sessions_covered, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [studentId, payment_date, amount, currency, payment_method, receipt_number, sessions_covered, notes]
    );

    // Update student's fees_paid
    await pool.query(
      `UPDATE students SET fees_paid = fees_paid + $1 WHERE id = $2`,
      [amount, studentId]
    );
    
    res.json({ message: 'Payment recorded successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== EVENT MANAGEMENT ==========

app.post('/api/events', async (req, res) => {
  const {
    event_type,
    event_name,
    event_description,
    event_date,
    event_time,
    duration,
    zoom_link,
    max_participants,
    registration_deadline
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO events (event_type, event_name, event_description, event_date, event_time, duration, zoom_link, max_participants, registration_deadline)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [event_type, event_name, event_description, event_date, event_time, duration, zoom_link, max_participants, registration_deadline]
    );

    const eventId = result.rows[0].id;

    // Fetch all students
    const studentsResult = await pool.query(`SELECT * FROM students`);
    const students = studentsResult.rows;

    console.log(`📧 Sending event announcements to ${students.length} parents`);

    for (const student of students) {
      const emailData = {
        parent_name: student.parent_name,
        student_name: student.name,
        event_name,
        event_type,
        event_date,
        event_time,
        duration,
        event_description,
        max_participants,
        deadline: registration_deadline,
        registration_link: `${process.env.BASE_URL}/register-event/${eventId}/${student.id}`
      };

      const emailHtml = getEmailTemplate('event_announcement', emailData);

      await sendEmail(
        student.parent_email,
        `New Event: ${event_name}`,
        emailHtml,
        student.parent_name,
        'Event Announcement'
      );

      // Small delay to protect Gmail
      await new Promise(r => setTimeout(r, 1500));
    }

    console.log('✅ All event emails processed');

    res.json({
      message: `Event created and ${students.length} emails sent`,
      eventId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all events with registration counts
app.get('/api/events', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.*, COUNT(er.id) as registered_count 
       FROM events e 
       LEFT JOIN event_registrations er ON e.id = er.event_id 
       GROUP BY e.id 
       ORDER BY e.event_date DESC`
    );
    
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Parent portal event registration
app.post('/api/events/:eventId/register', async (req, res) => {
  const { eventId } = req.params;
  const { student_id, parent_email } = req.body;

  try {
    // Check if already registered
    const existingResult = await pool.query(
      `SELECT * FROM event_registrations WHERE event_id = $1 AND student_id = $2`,
      [eventId, student_id]
    );

    if (existingResult.rows.length > 0) {
      return res.status(400).json({ error: 'Already registered for this event' });
    }

    // Get student info
    const studentResult = await pool.query(
      `SELECT * FROM students WHERE id = $1`,
      [student_id]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const student = studentResult.rows[0];

    // Register for event
    await pool.query(
      `INSERT INTO event_registrations (event_id, student_id, parent_name, parent_email)
       VALUES ($1, $2, $3, $4)`,
      [eventId, student_id, student.parent_name, parent_email]
    );

    await sendEmail(
      parent_email,
      `Event Registration Confirmed`,
      `<p>${student.name} is registered successfully.</p>`,
      student.parent_name,
      'Event Registration'
    );

    res.json({ message: 'Registered successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Event Registration via Email Link
app.get('/register-event/:eventId/:studentId', async (req, res) => {
  const { eventId, studentId } = req.params;
  
  try {
    // Get student info
    const studentResult = await pool.query(
      `SELECT * FROM students WHERE id = $1`,
      [studentId]
    );

    if (studentResult.rows.length === 0) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Registration Error</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #f4f4f4; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            h1 { color: #e74c3c; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>❌ Student Not Found</h1>
            <p>Unable to find student information. Please contact the academy.</p>
          </div>
        </body>
        </html>
      `);
    }

    const student = studentResult.rows[0];

    // Get event info
    const eventResult = await pool.query(
      `SELECT * FROM events WHERE id = $1`,
      [eventId]
    );

    if (eventResult.rows.length === 0) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Registration Error</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #f4f4f4; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            h1 { color: #e74c3c; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>❌ Event Not Found</h1>
            <p>This event may have been cancelled or removed.</p>
          </div>
        </body>
        </html>
      `);
    }

    const event = eventResult.rows[0];

    // Check if already registered
    const existingResult = await pool.query(
      `SELECT * FROM event_registrations WHERE event_id = $1 AND student_id = $2`,
      [eventId, studentId]
    );

    if (existingResult.rows.length > 0) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Already Registered</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #f4f4f4; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            h1 { color: #27ae60; }
            .event-details { background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: left; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✅ Already Registered!</h1>
            <p>${student.name} is already registered for this event.</p>
            <div class="event-details">
              <h3>${event.event_name}</h3>
              <p><strong>Date:</strong> ${event.event_date}</p>
              <p><strong>Time:</strong> ${event.event_time}</p>
              <p><strong>Type:</strong> ${event.event_type}</p>
            </div>
            <p>You will receive the Zoom link before the event starts.</p>
          </div>
        </body>
        </html>
      `);
    }

    // Register the student
    await pool.query(
      `INSERT INTO event_registrations (event_id, student_id, parent_name, parent_email)
       VALUES ($1, $2, $3, $4)`,
      [eventId, studentId, student.parent_name, student.parent_email]
    );

    // Send confirmation email
    const confirmationHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
        <table role="presentation" style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 20px 0; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
              <h1 style="color: white; margin: 0; font-size: 24px;">Fluent Feathers Academy</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px 20px;">
              <table role="presentation" style="max-width: 600px; margin: 0 auto; background: white; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                <tr>
                  <td style="padding: 40px;">
                    <h2 style="color: #27ae60; margin-top: 0;">Registration Confirmed!</h2>
                    <p style="font-size: 16px; color: #555;">Dear ${student.parent_name},</p>
                    <p style="font-size: 16px; color: #555;"><strong>${student.name}</strong> has been successfully registered for <strong>${event.event_name}</strong>!</p>
                    
                    <div style="background: #f8f9fa; padding: 25px; border-radius: 8px; margin: 25px 0;">
                      <h3 style="color: #667eea; margin-top: 0;">Event Details</h3>
                      <p style="margin: 10px 0;"><strong>Date:</strong> ${event.event_date}</p>
                      <p style="margin: 10px 0;"><strong>Time:</strong> ${event.event_time}</p>
                      <p style="margin: 10px 0;"><strong>Duration:</strong> ${event.duration}</p>
                      <p style="margin: 10px 0;"><strong>Type:</strong> ${event.event_type}</p>
                    </div>
                    
                    <div style="background: #d4edda; padding: 20px; border-radius: 8px; border-left: 4px solid #27ae60;">
                      <p style="margin: 0; color: #155724;">The Zoom link will be sent to you 1 hour before the event starts.</p>
                    </div>
                    
                    <p style="font-size: 14px; color: #7f8c8d; margin-top: 30px;">
                      Looking forward to seeing ${student.name} at the event!
                    </p>
                    
                    <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 2px solid #eee;">
                      <p style="color: #667eea; font-weight: bold; margin: 0;">Best regards,</p>
                      <p style="color: #667eea; font-weight: bold; margin: 5px 0;">Fluent Feathers Academy Team</p>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    await sendEmail(
      student.parent_email, 
      `Registration Confirmed - ${event.event_name}`, 
      confirmationHtml, 
      student.parent_name, 
      'Event Registration'
    );

    // Show success page
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Registration Successful</title>
        <style>
          body { 
            font-family: Arial, sans-serif; 
            padding: 40px; 
            text-align: center; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            margin: 0;
          }
          .container { 
            max-width: 600px; 
            margin: 0 auto; 
            background: white; 
            padding: 40px; 
            border-radius: 10px; 
            box-shadow: 0 10px 30px rgba(0,0,0,0.2); 
          }
          h1 { color: #27ae60; margin-bottom: 20px; }
          .checkmark { font-size: 80px; color: #27ae60; margin: 20px 0; }
          .event-details { 
            background: #f8f9fa; 
            padding: 20px; 
            border-radius: 8px; 
            margin: 20px 0; 
            text-align: left; 
          }
          .event-details p { margin: 10px 0; }
          .footer { color: #7f8c8d; font-size: 14px; margin-top: 30px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="checkmark">✓</div>
          <h1>Registration Successful!</h1>
          <p style="font-size: 18px; color: #2c3e50;">
            <strong>${student.name}</strong> has been registered for:
          </p>
          <div class="event-details">
            <h3 style="color: #667eea; margin-top: 0;">${event.event_name}</h3>
            <p><strong>Date:</strong> ${event.event_date}</p>
            <p><strong>Time:</strong> ${event.event_time}</p>
            <p><strong>Duration:</strong> ${event.duration}</p>
            <p><strong>Type:</strong> ${event.event_type}</p>
          </div>
          <p style="color: #27ae60; font-weight: bold;">
            ✉️ A confirmation email has been sent to ${student.parent_email}
          </p>
          <p style="background: #d4edda; padding: 15px; border-radius: 5px; color: #155724;">
            The Zoom link will be sent 1 hour before the event starts.
          </p>
          <div class="footer">
            <p>Thank you for registering!</p>
            <p>Fluent Feathers Academy</p>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Registration Error</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          h1 { color: #e74c3c; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>❌ Registration Failed</h1>
          <p>An error occurred. Please try again or contact the academy.</p>
        </div>
      </body>
      </html>
    `);
  }
});// Parent cancel specific upcoming class
app.post('/api/parent/cancel-upcoming-class', async (req, res) => {
  const { student_id, session_date, session_time, reason } = req.body;

  try {
    // Get student info
    const studentResult = await pool.query(
      `SELECT * FROM students WHERE id = $1`,
      [student_id]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const student = studentResult.rows[0];

    // Find the specific session
    const sessionResult = await pool.query(
      `SELECT * FROM sessions WHERE student_id = $1 AND session_date = $2 AND session_time = $3 AND status IN ('Pending', 'Scheduled')`,
      [student_id, session_date, session_time]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found or already cancelled' });
    }

    const session = sessionResult.rows[0];

    // Mark session as cancelled by parent
    await pool.query(
      `UPDATE sessions SET status = 'Cancelled by Parent', cancelled_by = 'Parent' WHERE id = $1`,
      [session.id]
    );

    // Create makeup class credit
    await pool.query(
      `INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status, notes)
       VALUES ($1, $2, $3, $4, 'Available', 'Parent cancellation - makeup available')`,
      [student_id, session.id, reason || 'Cancelled by Parent', session_date]
    );

    // Increase remaining sessions count
    await pool.query(
      `UPDATE students SET remaining_sessions = remaining_sessions + 1 WHERE id = $1`,
      [student_id]
    );

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

    await sendEmail(
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark event attendance 
app.post('/api/events/:eventId/attendance', async (req, res) => {
  const { eventId } = req.params;
  const { attendedStudents } = req.body;

  try {
    for (const studentId of attendedStudents) {
      await pool.query(
        `UPDATE event_registrations SET attendance_status = 'Attended' WHERE event_id = $1 AND student_id = $2`,
        [eventId, studentId]
      );
    }

    res.json({ 
      message: `Attendance marked for ${attendedStudents.length} students.` 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== ENHANCED SESSION MANAGEMENT ==========

// Enhanced session creation with detailed tracking
app.post('/api/schedule/classes', async (req, res) => {
  const { student_id, classes } = req.body;
  const ZOOM_LINK = 'https://us04web.zoom.us/j/7288533155?pwd=Nng5N2l0aU12L0FQK245c0VVVHJBUT09';

  try {
    // Get student info
    const studentResult = await pool.query(
      `SELECT * FROM students WHERE id = $1`,
      [student_id]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const student = studentResult.rows[0];

    // Get current session count
    const countResult = await pool.query(
      `SELECT COUNT(*) as count FROM sessions WHERE student_id = $1`,
      [student_id]
    );

    let sessionNumber = parseInt(countResult.rows[0].count) + 1;

    // Insert all sessions
    for (const cls of classes) {
      await pool.query(
        `INSERT INTO sessions (student_id, session_number, session_date, session_time, zoom_link, status) VALUES ($1, $2, $3, $4, $5, 'Pending')`,
        [student_id, sessionNumber, cls.date, cls.time, ZOOM_LINK]
      );
      sessionNumber++;
    }

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
              <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">Session ${parseInt(countResult.rows[0].count) + index + 1}</td>
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enhanced attendance marking with makeup class credits
app.post('/api/attendance/present/:studentId', async (req, res) => {
  const studentId = req.params.studentId;
  const today = new Date().toISOString().split('T')[0];

  try {
    // Get today's session
    const sessionResult = await pool.query(
      `SELECT * FROM sessions WHERE student_id = $1 AND session_date = $2 AND status IN ('Pending', 'Scheduled') LIMIT 1`,
      [studentId, today]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'No scheduled session found for today' });
    }

    const session = sessionResult.rows[0];

    // Mark session as completed
    await pool.query(
      `UPDATE sessions SET status = 'Completed', attendance = 'Present' WHERE id = $1`,
      [session.id]
    );

    // Update student's completed and remaining sessions
    await pool.query(
      `UPDATE students SET completed_sessions = completed_sessions + 1, remaining_sessions = remaining_sessions - 1 WHERE id = $1`,
      [studentId]
    );

    res.json({ message: 'Attendance marked as Present! Session completed successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enhanced absence marking with makeup credit
app.post('/api/attendance/absent/:studentId', async (req, res) => {
  const studentId = req.params.studentId;
  const { reason } = req.body;
  const today = new Date().toISOString().split('T')[0];

  try {
    const sessionResult = await pool.query(
      `SELECT * FROM sessions WHERE student_id = $1 AND session_date = $2 AND status IN ('Pending', 'Scheduled') LIMIT 1`,
      [studentId, today]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'No session found for today' });
    }

    const session = sessionResult.rows[0];

    // Mark session as missed
    await pool.query(
      `UPDATE sessions SET status = 'Missed', attendance = 'Absent' WHERE id = $1`,
      [session.id]
    );

    // Create makeup class credit
    await pool.query(
      `INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status)
       VALUES ($1, $2, $3, $4, 'Available')`,
      [studentId, session.id, reason || 'Student Absent', today]
    );

    res.json({ message: 'Marked as Absent. Makeup class credit added to student account.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enhanced class cancellation with detailed logging
app.post('/api/attendance/cancel/:studentId', async (req, res) => {
  const studentId = req.params.studentId;
  const { reason } = req.body;
  const today = new Date().toISOString().split('T')[0];

  try {
    // Get student
    const studentResult = await pool.query(
      `SELECT * FROM students WHERE id = $1`,
      [studentId]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const student = studentResult.rows[0];

    // Get upcoming session
    const sessionResult = await pool.query(
      `SELECT * FROM sessions WHERE student_id = $1 AND session_date >= $2 AND status IN ('Pending', 'Scheduled') ORDER BY session_date ASC LIMIT 1`,
      [studentId, today]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'No upcoming session found' });
    }

    const session = sessionResult.rows[0];

    // Mark session as cancelled
    await pool.query(
      `UPDATE sessions SET status = 'Cancelled by Teacher', cancelled_by = 'Teacher' WHERE id = $1`,
      [session.id]
    );

    // Create makeup class credit
    await pool.query(
      `INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status, notes)
       VALUES ($1, $2, $3, $4, 'Available', $5)`,
      [studentId, session.id, reason || 'Cancelled by Teacher', session.session_date, 'Teacher cancellation - makeup available']
    );

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

    await sendEmail(student.parent_email, `📅 Class Cancelled - ${session.session_date}`, cancelEmailHtml, student.parent_name, 'Cancellation');

    res.json({ message: 'Class cancelled successfully! Makeup credit added and confirmation email sent.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== ENHANCED MATERIAL MANAGEMENT ==========

// Enhanced material upload with session linking
app.post('/api/upload/material/:targetId', upload.single('file'), async (req, res) => {
  const { fileType, sessionDate, uploadType, sessionId } = req.body;
  const targetId = req.params.targetId;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const studentId = uploadType === 'private' ? targetId : null;
  const batchName = uploadType === 'batch' ? targetId : null;

  try {
    // Insert into materials table
    await pool.query(
      `INSERT INTO materials (student_id, batch_name, session_date, file_type, file_name, file_path, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'Teacher')`,
      [studentId, batchName, sessionDate, fileType, req.file.originalname, req.file.filename]
    );

    // If linked to a specific session, update session record
    if (sessionId && uploadType === 'private') {
      const column = fileType === 'PPT' ? 'ppt_file_path' : 
                    fileType === 'Recording' ? 'recording_file_path' :
                    fileType === 'Homework' ? 'homework_file_path' : null;

      if (column) {
        await pool.query(
          `UPDATE sessions SET ${column} = $1 WHERE id = $2`,
          [req.file.filename, sessionId]
        );
      }
    }

    // Send material notification email to affected students
    if (uploadType === 'private') {
      const studentResult = await pool.query(
        `SELECT * FROM students WHERE id = $1`,
        [targetId]
      );

      if (studentResult.rows.length > 0) {
        const student = studentResult.rows[0];
        
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
    }

    res.json({ message: 'Material uploaded successfully! Notification sent to students.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Grade homework
app.post('/api/sessions/:sessionId/grade-homework', async (req, res) => {
  const { grade, comments } = req.body;
  const sessionId = req.params.sessionId;

  try {
    await pool.query(
      `UPDATE sessions SET homework_grade = $1, homework_comments = $2 WHERE id = $3`,
      [grade, comments, sessionId]
    );

    // Get student info and send grade notification
    const sessionResult = await pool.query(
      `SELECT s.*, st.parent_email, st.parent_name FROM sessions s 
       JOIN students st ON s.student_id = st.id 
       WHERE s.id = $1`,
      [sessionId]
    );

    if (sessionResult.rows.length > 0) {
      const session = sessionResult.rows[0];
      
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

    res.json({ message: 'Homework graded successfully! Grade sent to parent.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== AUTOMATED REMINDERS ==========

// 24-hour reminder cron job
cron.schedule('0 9 * * *', async () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = tomorrow.toISOString().split('T')[0];

  try {
    const result = await pool.query(
      `SELECT s.*, st.parent_email, st.parent_name, st.name as student_name, st.timezone 
       FROM sessions s 
       JOIN students st ON s.student_id = st.id 
       WHERE s.session_date = $1 AND s.status IN ('Pending', 'Scheduled')`,
      [tomorrowDate]
    );

    for (const session of result.rows) {
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
  } catch (err) {
    console.error('24h reminder error:', err);
  }
});

// 1-hour reminder cron job
cron.schedule('0 * * * *', async () => {
  const now = new Date();
  const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);
  const currentDate = now.toISOString().split('T')[0];
  const targetTime = oneHourLater.toTimeString().slice(0, 5);

  try {
    const result = await pool.query(
      `SELECT s.*, st.parent_email, st.parent_name, st.name as student_name 
       FROM sessions s 
       JOIN students st ON s.student_id = st.id 
       WHERE s.session_date = $1 AND s.session_time = $2 AND s.status IN ('Pending', 'Scheduled')`,
      [currentDate, targetTime]
    );

    for (const session of result.rows) {
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
  } catch (err) {
    console.error('1h reminder error:', err);
  }
});

// Get sessions for a student
app.get('/api/sessions/:studentId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM sessions WHERE student_id = $1 ORDER BY session_date ASC`,
      [req.params.studentId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get upcoming sessions
app.get('/api/sessions/upcoming/:studentId', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  
  try {
    const result = await pool.query(
      `SELECT * FROM sessions WHERE student_id = $1 AND session_date >= $2 AND status IN ('Pending', 'Scheduled') ORDER BY session_date ASC`,
      [req.params.studentId, today]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get completed sessions
app.get('/api/sessions/completed/:studentId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM sessions WHERE student_id = $1 AND status = 'Completed' ORDER BY session_date DESC`,
      [req.params.studentId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get student by ID
app.get('/api/students/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM students WHERE id = $1`,
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check if parent email exists and has password
app.post('/api/parent/check-email', async (req, res) => {
  const { email } = req.body;
  
  try {
    const studentResult = await pool.query(
      `SELECT * FROM students WHERE parent_email = $1`,
      [email]
    );
    
    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'No student found with this email. Please contact admin.' });
    }
    
    // Check if password exists
    const credResult = await pool.query(
      `SELECT * FROM parent_credentials WHERE parent_email = $1`,
      [email]
    );
    
    res.json({ 
      exists: true, 
      hasPassword: credResult.rows.length > 0 && credResult.rows[0].password ? true : false 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Setup password for first-time login
app.post('/api/parent/setup-password', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    // Verify student exists
    const studentResult = await pool.query(
      `SELECT * FROM students WHERE parent_email = $1`,
      [email]
    );
    
    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    
    const student = studentResult.rows[0];
    const hashedPassword = hashPassword(password);
    
    // Insert or update credentials
    await pool.query(
      `INSERT INTO parent_credentials (parent_email, password) 
       VALUES ($1, $2) 
       ON CONFLICT(parent_email) DO UPDATE SET password = $2`,
      [email, hashedPassword]
    );
    
    // Update last login
    await pool.query(
      `UPDATE parent_credentials SET last_login = CURRENT_TIMESTAMP WHERE parent_email = $1`,
      [email]
    );
    
    res.json({ message: 'Password set successfully', student });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login with password
app.post('/api/parent/login-password', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const credResult = await pool.query(
      `SELECT * FROM parent_credentials WHERE parent_email = $1`,
      [email]
    );
    
    if (credResult.rows.length === 0 || !credResult.rows[0].password) {
      return res.status(404).json({ error: 'Password not set. Please use OTP login.' });
    }
    
    const cred = credResult.rows[0];
    
    // Verify password
    if (!verifyPassword(password, cred.password)) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    
    // Get student data
    const studentResult = await pool.query(
      `SELECT * FROM students WHERE parent_email = $1`,
      [email]
    );
    
    // Update last login
    await pool.query(
      `UPDATE parent_credentials SET last_login = CURRENT_TIMESTAMP WHERE parent_email = $1`,
      [email]
    );
    
    res.json({ message: 'Login successful', student: studentResult.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send OTP to email
app.post('/api/parent/send-otp', async (req, res) => {
  const { email } = req.body;
  
  try {
    // Verify student exists
    const studentResult = await pool.query(
      `SELECT * FROM students WHERE parent_email = $1`,
      [email]
    );
    
    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    
    const student = studentResult.rows[0];
    
    // Generate OTP
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    
    // Save OTP
    await pool.query(
      `INSERT INTO parent_credentials (parent_email, otp, otp_expiry, otp_attempts) 
       VALUES ($1, $2, $3, 0) 
       ON CONFLICT(parent_email) DO UPDATE SET 
         otp = $2, 
         otp_expiry = $3, 
         otp_attempts = 0`,
      [email, otp, otpExpiry.toISOString()]
    );
    
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify OTP
app.post('/api/parent/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  
  try {
    const credResult = await pool.query(
      `SELECT * FROM parent_credentials WHERE parent_email = $1`,
      [email]
    );
    
    if (credResult.rows.length === 0 || !credResult.rows[0].otp) {
      return res.status(404).json({ error: 'No OTP found. Please request a new one.' });
    }
    
    const cred = credResult.rows[0];
    
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
      await pool.query(
        `UPDATE parent_credentials SET otp_attempts = otp_attempts + 1 WHERE parent_email = $1`,
        [email]
      );
      return res.status(401).json({ error: 'Incorrect OTP. Please try again.' });
    }
    
    // OTP verified - clear OTP and get student data
    await pool.query(
      `UPDATE parent_credentials SET otp = NULL, otp_expiry = NULL, otp_attempts = 0, last_login = CURRENT_TIMESTAMP WHERE parent_email = $1`,
      [email]
    );
    
    const studentResult = await pool.query(
      `SELECT * FROM students WHERE parent_email = $1`,
      [email]
    );
    
    res.json({ message: 'Login successful', student: studentResult.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload homework from parent
app.post('/api/upload/homework/:studentId', upload.single('file'), async (req, res) => {
  const { sessionDate } = req.body;
  const studentId = req.params.studentId;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    await pool.query(
      `INSERT INTO materials (student_id, session_date, file_type, file_name, file_path, uploaded_by)
       VALUES ($1, $2, 'Homework', $3, $4, 'Parent')`,
      [studentId, sessionDate, req.file.originalname, req.file.filename]
    );

    // Get student info to send notification
    const studentResult = await pool.query(
      `SELECT * FROM students WHERE id = $1`,
      [studentId]
    );

    if (studentResult.rows.length > 0) {
      const student = studentResult.rows[0];
      
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
        'fluentfeathersbyaaliya@gmail.com',
        `Homework Submitted - ${student.name}`,
        homeworkEmail,
        'Teacher',
        'Homework Submission'
      );
    }

    res.json({ message: 'Homework uploaded successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all materials (admin view)
app.get('/api/materials/all/admin', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM materials ORDER BY uploaded_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get materials for student
app.get('/api/materials/:studentId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM materials WHERE student_id = $1 OR batch_name IS NOT NULL ORDER BY uploaded_at DESC`,
      [req.params.studentId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete material
app.delete('/api/materials/:id', async (req, res) => {
  try {
    const materialResult = await pool.query(
      `SELECT * FROM materials WHERE id = $1`,
      [req.params.id]
    );
    
    if (materialResult.rows.length === 0) {
      return res.status(404).json({ error: 'Material not found' });
    }
    
    const material = materialResult.rows[0];

    // Delete file
    const filePath = path.join(__dirname, 'uploads', material.file_path);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    await pool.query(
      `DELETE FROM materials WHERE id = $1`,
      [req.params.id]
    );
    
    res.json({ message: 'Material deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get email log with IST conversion
app.get('/api/emails/log', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM email_log ORDER BY sent_at DESC LIMIT 100`
    );
    
    // Convert timestamps to IST
    const rowsWithIST = result.rows.map(row => ({
      ...row,
      sent_at_ist: convertToIST(row.sent_at),
      sent_at: row.sent_at
    }));
    
    res.json(rowsWithIST);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get event registrations
app.get('/api/events/:eventId/registrations', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM event_registrations WHERE event_id = $1`,
      [req.params.eventId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark event complete
app.post('/api/events/:eventId/complete', async (req, res) => {
  try {
    await pool.query(
      `UPDATE events SET event_status = 'Completed' WHERE id = $1`,
      [req.params.eventId]
    );
    res.json({ message: 'Event marked as complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Timetable endpoints
app.get('/api/timetable/slots', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM timetable ORDER BY 
       CASE day_of_week 
         WHEN 'Monday' THEN 1 
         WHEN 'Tuesday' THEN 2 
         WHEN 'Wednesday' THEN 3 
         WHEN 'Thursday' THEN 4 
         WHEN 'Friday' THEN 5 
         WHEN 'Saturday' THEN 6 
         WHEN 'Sunday' THEN 7 
       END, time_slot`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/timetable/slots', async (req, res) => {
  const { day_of_week, time_slot } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO timetable (day_of_week, time_slot) VALUES ($1, $2) RETURNING id`,
      [day_of_week, time_slot]
    );
    res.json({ message: 'Slot added successfully', id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/timetable/book/:slotId', async (req, res) => {
  const { student_id, student_name, program_name, duration } = req.body;
  
  try {
    await pool.query(
      `UPDATE timetable SET is_booked = 1, student_id = $1, student_name = $2, program_name = $3, duration = $4 WHERE id = $5`,
      [student_id, student_name, program_name, duration, req.params.slotId]
    );
    res.json({ message: 'Slot booked successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/timetable/unbook/:slotId', async (req, res) => {
  try {
    await pool.query(
      `UPDATE timetable SET is_booked = 0, student_id = NULL, student_name = NULL, program_name = NULL, duration = NULL WHERE id = $1`,
      [req.params.slotId]
    );
    res.json({ message: 'Slot freed successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/timetable/slots/:id', async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM timetable WHERE id = $1`,
      [req.params.id]
    );
    res.json({ message: 'Slot deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete student
app.delete('/api/students/:id', async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM students WHERE id = $1`,
      [req.params.id]
    );
    res.json({ message: 'Student deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
║  🤖 Reminder System Active             ║
║  🐘 PostgreSQL Database Connected      ║
╚════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server gracefully...');
  pool.end((err) => {
    if (err) console.error(err.message);
    else console.log('✅ Database connection closed');
    process.exit(0);
  });
});