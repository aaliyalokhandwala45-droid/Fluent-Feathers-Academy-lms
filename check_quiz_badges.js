const { Client } = require('pg');

async function checkPerfectQuizzes() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/lms'
  });

  try {
    await client.connect();

    const result = await client.query(`
      SELECT qa.student_id, qa.quiz_date, qa.score, sb.badge_type, sb.badge_name
      FROM quiz_attempts qa
      LEFT JOIN student_badges sb ON qa.student_id = sb.student_id
        AND sb.badge_type LIKE 'daily_quiz_champion%'
      WHERE qa.score = 10
      ORDER BY qa.quiz_date DESC
      LIMIT 50
    `);

    console.log('Perfect quiz attempts and their badges:');
    result.rows.forEach(row => {
      console.log(`Student ${row.student_id}: ${row.quiz_date} - Score: ${row.score} - Badge: ${row.badge_type || 'NONE'} - Name: ${row.badge_name || 'N/A'}`);
    });

    // Count how many perfect scores don't have badges
    const withoutBadges = result.rows.filter(row => !row.badge_type);
    console.log(`\nTotal perfect scores: ${result.rows.length}`);
    console.log(`Perfect scores without badges: ${withoutBadges.length}`);

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await client.end();
  }
}

checkPerfectQuizzes();