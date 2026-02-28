// One-time script: manually send cancellation email for Monali's 8pm class
// Calls the LIVE Render server so the email goes through Brevo's whitelisted IP
require('dotenv').config();
const axios = require('axios');

const SERVER_URL = 'https://fluent-feathers-academy-lms.onrender.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

async function main() {
  console.log('📧 Sending cancellation email for Monali via live server...');

  const res = await axios.post(`${SERVER_URL}/api/admin/resend-cancel-email`, {
    pass: ADMIN_PASSWORD,
    student_id: 5,    // Monali Gowda
    session_id: 192,  // Feb 28 14:30 group class
    reason: 'Parent Requested',
    has_makeup_credit: true
  });

  console.log('✅', res.data.message || 'Email sent!');
}

main().catch(e => {
  const detail = e.response ? JSON.stringify(e.response.data) : e.message;
  console.error('❌', detail);
  process.exit(1);
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function getClassCancelledEmail({ parentName, studentName, sessionDate, sessionTime, cancelledBy, reason, hasMakeupCredit }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #f56565 0%, #c53030 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">📅</div>
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">Class Cancelled</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 16px;">Session Update Notification</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">Dear <strong>${parentName}</strong>,</p>
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
          A makeup credit has been added to <strong>${studentName}</strong>'s account. You can use this credit during renewal to book an extra session.
        </p>
      </div>` : ''}
      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6;">
        If you have any questions, please don't hesitate to reach out to us.<br><br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">Made with ❤️ By Aaliya</p>
    </div>
  </div>
</body>
</html>`;
}

async function main() {
  // Find Monali's latest cancelled session around 8pm
  const studentRes = await pool.query(`SELECT * FROM students WHERE LOWER(name) LIKE '%monali%' LIMIT 1`);
  if (!studentRes.rows.length) {
    console.error('❌ Student Monali not found');
    process.exit(1);
  }
  const student = studentRes.rows[0];
  console.log(`✅ Found student: ${student.name}, parent: ${student.parent_name}, email: ${student.parent_email}`);

  // Find her most recently attended session marked Excused (group cancel attendance record)
  const sessionRes = await pool.query(`
    SELECT s.*, sa.attendance
    FROM sessions s
    JOIN session_attendance sa ON sa.session_id = s.id AND sa.student_id = $1
    WHERE sa.attendance IN ('Excused', 'Unexcused')
    ORDER BY s.session_date DESC, s.id DESC
    LIMIT 5
  `, [student.id]);

  console.log(`\nFound ${sessionRes.rows.length} excused/cancelled attendance records:`);
  sessionRes.rows.forEach((s, i) => console.log(`  [${i}] id=${s.id} date=${s.session_date} time=${s.session_time} type=${s.session_type} attendance=${s.attendance}`));

  if (!sessionRes.rows.length) {
    // Fallback: any upcoming session for Monali near 8pm
    const anyRes = await pool.query(`
      SELECT * FROM sessions WHERE student_id = $1
      ORDER BY session_date DESC, id DESC LIMIT 10
    `, [student.id]);
    console.log(`\nNo excused records. All recent sessions for ${student.name}:`);
    anyRes.rows.forEach((s, i) => console.log(`  [${i}] id=${s.id} date=${s.session_date} time=${s.session_time} status=${s.status}`));
    process.exit(1);
  }

  const session = sessionRes.rows[0];
  console.log(`\n📧 Using session id=${session.id}, date=${session.session_date}, time=${session.session_time}`);

  // Build date/time strings
  const dateStr = new Date(session.session_date).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const timeStr = session.session_time ? session.session_time.toString().substring(0, 5) + ' (IST/local)' : '8:00 PM';

  const emailHTML = getClassCancelledEmail({
    parentName: student.parent_name || 'Parent',
    studentName: student.name,
    sessionDate: dateStr,
    sessionTime: timeStr,
    cancelledBy: 'Teacher',
    reason: 'Parent Requested',
    hasMakeupCredit: true
  });

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) { console.error('❌ BREVO_API_KEY not set'); process.exit(1); }

  console.log(`\nSending email to: ${student.parent_email}...`);
  await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender: { name: 'Fluent Feathers Academy', email: process.env.EMAIL_USER || 'noreply@fluentfeathers.com' },
    to: [{ email: student.parent_email, name: student.parent_name || student.parent_email }],
    subject: `📅 Class Cancelled - ${student.name}`,
    htmlContent: emailHTML
  }, { headers: { 'api-key': apiKey, 'Content-Type': 'application/json' } }).catch(e => {
    const detail = e.response ? JSON.stringify(e.response.data) : e.message;
    throw new Error(`Brevo API error: ${e.response?.status} - ${detail}`);
  });

  console.log('✅ Email sent successfully!');

  // Log it
  await pool.query(`INSERT INTO email_log (recipient_name, recipient_email, email_type, subject, status) VALUES ($1,$2,$3,$4,'Sent')`,
    [student.parent_name || '', student.parent_email, 'Class-Cancelled', `📅 Class Cancelled - ${student.name}`]);

  await pool.end();
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
