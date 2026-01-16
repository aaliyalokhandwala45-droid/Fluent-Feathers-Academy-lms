// ==================== DATABASE FIX SCRIPT ====================
// Run this once to fix the database schema issues

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function fixDatabase() {
  const client = await pool.connect();
  
  try {
    console.log('🔧 Starting database fixes...');

    // Begin transaction
    await client.query('BEGIN');

    // 1. Drop all existing tables (if they exist) to start fresh
    console.log('📋 Dropping existing tables...');
    const dropTables = [
      'email_log',
      'event_registrations',
      'events',
      'payment_history',
      'makeup_classes',
      'materials',
      'session_attendance',
      'sessions',
      'parent_credentials',
      'students',
      'groups'
    ];

    for (const table of dropTables) {
      await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
      console.log(`  ✓ Dropped ${table}`);
    }

    // 2. Create groups table
    console.log('📋 Creating groups table...');
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
    console.log('  ✓ Created groups table');

    // 3. Create students table
    console.log('📋 Creating students table...');
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL
      )
    `);
    console.log('  ✓ Created students table');

    // 4. Create parent_credentials table
    console.log('📋 Creating parent_credentials table...');
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
    console.log('  ✓ Created parent_credentials table');

    // 5. Create sessions table
    console.log('📋 Creating sessions table...');
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
        homework_grade TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
      )
    `);
    console.log('  ✓ Created sessions table');

    // 6. Create session_attendance table
    console.log('📋 Creating session_attendance table...');
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
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);
    console.log('  ✓ Created session_attendance table');

    // 7. Create materials table
    console.log('📋 Creating materials table...');
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
    console.log('  ✓ Created materials table');

    // 8. Create makeup_classes table
    console.log('📋 Creating makeup_classes table...');
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
    console.log('  ✓ Created makeup_classes table');

    // 9. Create payment_history table
    console.log('📋 Creating payment_history table...');
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
    console.log('  ✓ Created payment_history table');

    // 10. Create events table
    console.log('📋 Creating events table...');
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
    console.log('  ✓ Created events table');

    // 11. Create event_registrations table
    console.log('📋 Creating event_registrations table...');
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
    console.log('  ✓ Created event_registrations table');

    // 12. Create email_log table
    console.log('📋 Creating email_log table...');
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
    console.log('  ✓ Created email_log table');

    // Commit transaction
    await client.query('COMMIT');
    console.log('✅ Database fix completed successfully!');
    console.log('');
    console.log('🎉 You can now add students without errors.');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error fixing database:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the fix
fixDatabase()
  .then(() => {
    console.log('👋 Script completed. You can now restart your server.');
    process.exit(0);
  })
  .catch(err => {
    console.error('💥 Fatal error:', err);
    process.exit(1);
  });