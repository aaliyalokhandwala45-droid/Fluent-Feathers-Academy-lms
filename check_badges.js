const { Client } = require('pg');

async function checkBadges() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/lms'
  });

  try {
    await client.connect();

    // Check for quiz champion badges with details
    const result = await client.query(`
      SELECT sb.badge_type, sb.badge_name, sb.badge_description, sb.earned_date, s.name as student_name
      FROM student_badges sb
      JOIN students s ON sb.student_id = s.id
      WHERE sb.badge_type LIKE 'daily_quiz_champion%'
      ORDER BY sb.earned_date DESC
      LIMIT 20
    `);

    console.log('Recent Quiz Champion badges:');
    result.rows.forEach(row => {
      console.log(`${row.earned_date}: ${row.student_name} - ${row.badge_name} (${row.badge_description})`);
      console.log(`  Type: ${row.badge_type}`);
    });

    // Check total quiz attempts with perfect scores
    const perfectResult = await client.query(`
      SELECT COUNT(*) as perfect_count
      FROM quiz_attempts
      WHERE score = 10
    `);

    console.log(`\nTotal perfect quiz scores: ${perfectResult.rows[0].perfect_count}`);

    // Check quiz dates
    const dateResult = await client.query(`
      SELECT DISTINCT quiz_date, COUNT(*) as attempts
      FROM quiz_attempts
      WHERE score = 10
      GROUP BY quiz_date
      ORDER BY quiz_date DESC
    `);

    console.log('\nPerfect scores by date:');
    dateResult.rows.forEach(row => {
      console.log(`${row.quiz_date}: ${row.attempts} perfect attempts`);
    });

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await client.end();
  }
}

checkBadges();