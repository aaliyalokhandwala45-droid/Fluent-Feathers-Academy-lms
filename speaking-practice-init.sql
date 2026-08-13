-- Speaking Practice Database Schema
-- This file is applied via server.js migrations

-- Speaking topics library (both AI-generated and admin-added)
CREATE TABLE IF NOT EXISTS speaking_topics (
  id SERIAL PRIMARY KEY,
  age_group VARCHAR(20) NOT NULL CHECK (age_group IN ('young', 'intermediate', 'advanced')),
  difficulty VARCHAR(20) NOT NULL CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
  category VARCHAR(50) NOT NULL,
  topic_text TEXT NOT NULL,
  generated_by_ai BOOLEAN DEFAULT false,
  approved_by_admin BOOLEAN DEFAULT false,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Track which topics have been shown to each student (to avoid repetition)
CREATE TABLE IF NOT EXISTS speaking_topics_used (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES speaking_topics(id) ON DELETE CASCADE,
  used_date DATE NOT NULL,
  UNIQUE(student_id, topic_id, used_date)
);

-- Speaking practice attempts (metadata only - NO permanent video URL stored)
CREATE TABLE IF NOT EXISTS speaking_attempts (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES speaking_topics(id),
  attempt_date DATE NOT NULL,
  difficulty VARCHAR(20),
  duration_seconds INTEGER,
  confidence_rating INTEGER CHECK (confidence_rating >= 1 AND confidence_rating <= 5),
  reflection_data JSONB,
  ai_feedback JSONB,
  completion_status VARCHAR(20) DEFAULT 'incomplete' CHECK (completion_status IN ('incomplete', 'recorded', 'analyzed', 'completed')),
  temp_storage_id TEXT,
  temp_storage_deleted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Speaking feedback details (stored after video is deleted)
CREATE TABLE IF NOT EXISTS speaking_feedback (
  id SERIAL PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES speaking_attempts(id) ON DELETE CASCADE,
  voice_pace VARCHAR(30),
  voice_volume VARCHAR(30),
  voice_modulation VARCHAR(30),
  filler_words_detected BOOLEAN,
  facial_expressiveness VARCHAR(30),
  camera_engagement VARCHAR(30),
  hand_gestures_detected BOOLEAN,
  gesture_variety VARCHAR(30),
  presentation_confidence VARCHAR(30),
  vocabulary_variety VARCHAR(30),
  sentence_construction VARCHAR(30),
  grammar_patterns VARCHAR(30),
  clarity_of_expression VARCHAR(30),
  language_feedback TEXT,
  strengths_summary TEXT,
  improvement_suggestion TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_speaking_topics_age_difficulty ON speaking_topics(age_group, difficulty);
CREATE INDEX IF NOT EXISTS idx_speaking_topics_active ON speaking_topics(active);
CREATE INDEX IF NOT EXISTS idx_speaking_topics_used_student ON speaking_topics_used(student_id);
CREATE INDEX IF NOT EXISTS idx_speaking_attempts_student ON speaking_attempts(student_id);
CREATE INDEX IF NOT EXISTS idx_speaking_attempts_date ON speaking_attempts(attempt_date);
CREATE INDEX IF NOT EXISTS idx_speaking_feedback_attempt ON speaking_feedback(attempt_id);
