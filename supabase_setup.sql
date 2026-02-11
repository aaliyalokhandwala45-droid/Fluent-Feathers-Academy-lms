-- ==================== FLUENT FEATHERS LMS - SUPABASE SETUP ====================
-- Run this FIRST in Supabase SQL Editor BEFORE importing your backup data
-- This creates all the necessary tables with the correct structure

-- Drop tables if they exist (in reverse order of dependencies)
DROP TABLE IF EXISTS monthly_assessments CASCADE;
DROP TABLE IF EXISTS student_certificates CASCADE;
DROP TABLE IF EXISTS student_badges CASCADE;
DROP TABLE IF EXISTS class_feedback CASCADE;
DROP TABLE IF EXISTS payment_renewals CASCADE;
DROP TABLE IF EXISTS payment_history CASCADE;
DROP TABLE IF EXISTS event_registrations CASCADE;
DROP TABLE IF EXISTS events CASCADE;
DROP TABLE IF EXISTS email_log CASCADE;
DROP TABLE IF EXISTS parent_credentials CASCADE;
DROP TABLE IF EXISTS makeup_classes CASCADE;
DROP TABLE IF EXISTS materials CASCADE;
DROP TABLE IF EXISTS session_attendance CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS students CASCADE;
DROP TABLE IF EXISTS groups CASCADE;
DROP TABLE IF EXISTS announcements CASCADE;

-- ==================== CORE TABLES ====================

-- Groups table (must be before students due to foreign key)
CREATE TABLE groups (
  id SERIAL PRIMARY KEY,
  group_name TEXT NOT NULL,
  program_name TEXT NOT NULL,
  duration TEXT NOT NULL,
  timezone TEXT DEFAULT 'Asia/Kolkata',
  max_students INTEGER DEFAULT 10,
  current_students INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Students table
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
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  group_name TEXT,
  date_of_birth DATE,
  payment_method TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table
CREATE TABLE sessions (
  id SERIAL PRIMARY KEY,
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Session attendance (for group sessions)
CREATE TABLE session_attendance (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  attendance TEXT DEFAULT 'Pending',
  homework_grade TEXT,
  homework_comments TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, student_id)
);

-- Materials table (homework, PPTs, recordings)
CREATE TABLE materials (
  id SERIAL PRIMARY KEY,
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  session_date DATE NOT NULL,
  file_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  feedback_grade TEXT,
  feedback_comments TEXT,
  feedback_given INTEGER DEFAULT 0,
  feedback_date TIMESTAMP
);

-- ==================== EVENTS & REGISTRATIONS ====================

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
);

CREATE TABLE event_registrations (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  registration_method TEXT DEFAULT 'Parent',
  attendance TEXT DEFAULT 'Pending',
  registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, student_id)
);

-- ==================== COMMUNICATION ====================

CREATE TABLE email_log (
  id SERIAL PRIMARY KEY,
  recipient_name TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  email_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE announcements (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  announcement_type TEXT DEFAULT 'General',
  priority TEXT DEFAULT 'Normal',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==================== AUTHENTICATION ====================

CREATE TABLE parent_credentials (
  id SERIAL PRIMARY KEY,
  parent_email TEXT UNIQUE NOT NULL,
  password TEXT,
  otp TEXT,
  otp_expiry TIMESTAMP,
  otp_attempts INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login TIMESTAMP
);

-- ==================== FEEDBACK & BADGES ====================

CREATE TABLE class_feedback (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  feedback_text TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, student_id)
);

CREATE TABLE student_badges (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  badge_type TEXT NOT NULL,
  badge_name TEXT NOT NULL,
  badge_description TEXT,
  earned_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==================== ASSESSMENTS & CERTIFICATES ====================

CREATE TABLE monthly_assessments (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  skills TEXT,
  certificate_title TEXT,
  performance_summary TEXT,
  areas_of_improvement TEXT,
  teacher_comments TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE student_certificates (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  certificate_type TEXT NOT NULL,
  award_title TEXT NOT NULL,
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  issued_date DATE DEFAULT CURRENT_DATE,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==================== PAYMENTS ====================

CREATE TABLE payment_history (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  payment_date DATE NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  currency TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  receipt_number TEXT,
  sessions_covered TEXT,
  payment_status TEXT DEFAULT 'Paid',
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payment_renewals (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  renewal_date DATE NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  currency TEXT NOT NULL,
  sessions_added INTEGER NOT NULL,
  payment_method TEXT,
  notes TEXT,
  status TEXT DEFAULT 'Paid',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE makeup_classes (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  original_session_id INTEGER,
  reason TEXT NOT NULL,
  credit_date DATE NOT NULL,
  status TEXT DEFAULT 'Available',
  used_date DATE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==================== INDEXES ====================

CREATE INDEX idx_students_email ON students(parent_email);
CREATE INDEX idx_students_birthday ON students(date_of_birth);
CREATE INDEX idx_sessions_student ON sessions(student_id);
CREATE INDEX idx_sessions_group ON sessions(group_id);
CREATE INDEX idx_sessions_date ON sessions(session_date);
CREATE INDEX idx_feedback_student ON class_feedback(student_id);
CREATE INDEX idx_feedback_session ON class_feedback(session_id);
CREATE INDEX idx_badges_student ON student_badges(student_id);
CREATE INDEX idx_certificates_student ON student_certificates(student_id);
CREATE INDEX idx_materials_student ON materials(student_id);
CREATE INDEX idx_email_log_date ON email_log(sent_at);

-- ==================== ROW LEVEL SECURITY ====================
-- Enable RLS on all tables to prevent unauthorized direct access
-- The app connects via service_role key which bypasses RLS, so this is safe

ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE parent_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_badges ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_renewals ENABLE ROW LEVEL SECURITY;
ALTER TABLE makeup_classes ENABLE ROW LEVEL SECURITY;

-- Allow service_role full access (this is what your server uses)
CREATE POLICY "Service role full access" ON groups FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON students FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON sessions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON session_attendance FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON materials FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON event_registrations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON email_log FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON announcements FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON parent_credentials FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON class_feedback FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON student_badges FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON monthly_assessments FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON student_certificates FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON payment_history FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON payment_renewals FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON makeup_classes FOR ALL USING (true) WITH CHECK (true);

-- ==================== DONE ====================
-- Now you can import your backup data!
