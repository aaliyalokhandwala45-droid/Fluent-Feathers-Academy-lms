# 🎓 Fluent Feathers Academy - Professional LMS

A complete, production-ready Learning Management System with email automation, file uploads, and lifetime data storage.

---

## 📋 TABLE OF CONTENTS

1. [Features](#features)
2. [Installation](#installation)
3. [Email Configuration](#email-configuration)
4. [Running Locally](#running-locally)
5. [Deployment (Make it Public)](#deployment)
6. [User Guide](#user-guide)
7. [Troubleshooting](#troubleshooting)

---

## ✨ FEATURES

### 🎓 For Admin (You)
- **Dashboard** with real-time stats
- **Add/Delete Students** with welcome emails
- **Schedule Classes** in advance
- **Mark Attendance** (Present/Absent/Cancel)
- **Upload Materials** (Private or Batch)
- **Weekly Timetable** management
- **Email Log** tracking
- **Session Tracking** (lifetime data)

### 👨‍👩‍👧 For Parents
- **Login with Email** (no password needed)
- **View Upcoming Classes** with Zoom links
- **View Past Classes** (complete history)
- **Download Materials** (PPTs, PDFs, Recordings)
- **Upload Homework** after classes
- **Cancel Classes** (with email notification)

### 📧 Automated Emails
- **Welcome Email** when student is added
- **Daily Reminders** at 8:00 AM for today's classes
- **Cancellation Emails** when classes are cancelled

---

## 🚀 INSTALLATION

### Step 1: Install Dependencies

```bash
npm install
```

This installs:
- `express` - Web server
- `sqlite3` - Database
- `multer` - File uploads
- `nodemailer` - Email sending
- `node-cron` - Automated tasks

### Step 2: Delete Old Database (if upgrading)

```bash
# On Windows
del lms.db

# On Mac/Linux
rm lms.db
```

---

## 📧 EMAIL CONFIGURATION

### Option 1: Gmail (Recommended)

1. **Enable 2-Factor Authentication** on your Gmail account
2. **Generate App Password**:
   - Go to: https://myaccount.google.com/apppasswords
   - Select "Mail" and "Windows Computer"
   - Copy the 16-character password

3. **Update server.js** (lines 20-24):

```javascript
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'your-email@gmail.com',        // ← Your Gmail
    pass: 'xxxx xxxx xxxx xxxx'          // ← App Password
  }
});
```

### Option 2: Outlook

```javascript
const transporter = nodemailer.createTransport({
  service: 'outlook',
  auth: {
    user: 'your-email@outlook.com',
    pass: 'your-password'
  }
});
```

### Option 3: Other Email Services

```javascript
const transporter = nodemailer.createTransport({
  host: 'smtp.your-provider.com',
  port: 587,
  secure: false,
  auth: {
    user: 'your-email',
    pass: 'your-password'
  }
});
```

---

## 💻 RUNNING LOCALLY

### Start the Server

```bash
npm start
```

You should see:

```
✅ Database connected
✅ All tables initialized
╔════════════════════════════════════════╗
║   🎓 FLUENT FEATHERS LMS SERVER       ║
║   ✅ Running on port 3000              ║
║   📧 Email automation active          ║
╚════════════════════════════════════════╝
```

### Access Your LMS

- **Admin Portal**: `http://localhost:3000` (click Admin Login)
- **Parent Portal**: `http://localhost:3000/parent.html`

---

## 🌐 DEPLOYMENT (Make it Public)

### Option 1: Railway (Easiest - FREE)

1. **Create Account**: https://railway.app
2. **Install Railway CLI**:

```bash
npm install -g @railway/cli
```

3. **Login & Deploy**:

```bash
railway login
railway init
railway up
```

4. **Set Environment Variables** in Railway Dashboard:
   - `LMS_URL` = your-app.railway.app

5. **Your LMS will be live at**: `https://your-app.railway.app`

### Option 2: Render (FREE)

1. **Create Account**: https://render.com
2. **Connect GitHub Repository**
3. **Create New Web Service**
4. **Set Environment Variable**:
   - `LMS_URL` = your-app.onrender.com

### Option 3: Vercel (For Static + API)

Not recommended for this app as it uses SQLite and file uploads.

---

## 📖 USER GUIDE

### 🎓 Admin Guide

#### 1. Add a Student

1. Go to **Students** tab
2. Fill in all details:
   - **Student Type**: Private or Group
   - **Batch Name**: Only for Group students
3. Click **Add Student**
4. ✅ Welcome email sent automatically!

#### 2. Schedule Classes

1. Go to **Sessions** tab
2. Select student
3. Add multiple dates and times
4. Click **Schedule All Classes**

#### 3. Mark Attendance

1. Go to **Students** tab or **Sessions** tab
2. Click **View Details** on any student
3. Click:
   - **Present** = Session completed, count reduces
   - **Absent** = Session recorded, count unchanged
   - **Cancel** = Session cancelled, count increases

#### 4. Upload Materials

##### For Private Students:
1. Go to **Materials** tab
2. Select **Private Student**
3. Choose student, date, file type
4. Upload file

##### For Group/Batch:
1. Go to **Materials** tab
2. Select **Batch/Group**
3. Upload file (all students in batch can see it)

#### 5. Manage Timetable

1. Go to **Timetable** tab
2. Add time slots (day + time)
3. Book slots for students
4. Visual grid shows vacant (green) vs booked (red)

#### 6. View Email Log

1. Go to **Email Log** tab
2. See all automated emails sent
3. Check status (Sent/Failed)

---

### 👨‍👩‍👧 Parent Guide

#### 1. Login

1. Go to: `your-website.com/parent.html`
2. Enter your email (received in welcome email)
3. Click **Login**

#### 2. View Upcoming Classes

1. **Upcoming Classes** tab shows:
   - Session number
   - Date & time
   - Zoom link (click to join)

#### 3. View Past Classes

1. **Past Classes** tab shows:
   - Completed sessions (Session 1, 2, 3...)
   - Complete history (including cancelled)

#### 4. Download Materials

1. Go to **Materials** tab
2. See all PPTs, PDFs, Recordings
3. Click **Download** on any file

#### 5. Upload Homework

1. Go to **Upload Homework** tab
2. Select session date
3. Upload homework file
4. View submitted homework below

#### 6. Cancel a Class

1. **Upcoming Classes** tab
2. Click **Cancel Upcoming Class**
3. Remaining sessions increase by 1
4. ✅ Email sent to you and admin

---

## 🔧 TROUBLESHOOTING

### Problem: Emails Not Sending

**Solution 1**: Check email configuration in `server.js`

```javascript
// Make sure these are correct:
user: 'your-actual-email@gmail.com',
pass: 'your-actual-app-password'
```

**Solution 2**: Enable "Less secure app access" (Gmail)

**Solution 3**: Check console for email errors

```bash
# Look for:
Email error: ...
```

### Problem: Files Not Uploading

**Solution**: Check `uploads` folder exists

```bash
# Create it manually:
mkdir uploads
```

### Problem: Database Errors

**Solution**: Delete and recreate database

```bash
# Stop server (Ctrl+C)
# Delete database
del lms.db  # Windows
rm lms.db   # Mac/Linux
# Restart server
npm start
```

### Problem: Can't Access from Other Devices

**Solution**: Deploy to Railway/Render (see Deployment section)

---

## 📞 SUPPORT

### Check Server Logs

```bash
# Terminal shows all activity:
✅ Database connected
✅ Student added
📧 Email sent to: parent@example.com
```

### Common Issues

1. **Port Already in Use**: Change port in `server.js` line 13
2. **Module Not Found**: Run `npm install`
3. **Database Locked**: Close other instances of the app

---

## 🎉 YOU'RE READY!

Your professional LMS is now:
- ✅ Fully functional
- ✅ Email automated
- ✅ Lifetime data storage
- ✅ Private + Batch support
- ✅ Parent portal ready
- ✅ Production-ready

### Next Steps:

1. ✅ Configure your email
2. ✅ Start the server
3. ✅ Add your first student
4. ✅ Deploy to make it public
5. ✅ Share parent portal link!

---

## 📝 LICENSE

This LMS is custom-built for Fluent Feathers Academy.

---

**Made with ❤️ for Fluent Feathers Academy**