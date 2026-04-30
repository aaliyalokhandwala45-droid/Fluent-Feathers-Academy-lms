# Daily Quiz System Improvements

## Issues Fixed

### 1. ❌ **Groq API Rate Limiting (429 Error)**
**Problem:** When generating AI quiz questions, the Groq API was returning 429 (Too Many Requests) errors, causing quiz generation to fail with "Error: Failed to generate AI quiz" message.

**Solution Implemented:**
- Enhanced retry logic with exponential backoff (2s, 4s, 8s, 16s, 30s max)
- Added jitter to prevent thundering herd
- Improved retry delay detection from Groq API responses
- Increased retry attempts handling from basic to more sophisticated backoff strategy

**Files Modified:** `server.js` (functions `getGroqRetryDelayMs()` and `generatePendingQuizQuestions()`)

---

### 2. ✨ **New Feature: Custom Theme/Prompt for Quiz Generation**
**Problem:** Teachers couldn't customize what type of questions to generate. All questions were generic, and there was no way to create themed quizzes (e.g., Teacher's Day, Vocabulary Focus, Holiday themed).

**Solution Implemented:**
- Added theme/prompt input field to admin dashboard
- Teachers can now specify a theme before generating questions (e.g., "Teacher's Day", "Vocabulary Focus", "Spring Theme")
- Theme is passed through the entire generation pipeline and included in the Groq API prompt
- AI generates questions relevant to the specified theme
- Questions are generated for all three difficulty levels (Beginner, Intermediate, Advanced) with the same theme

**UI Changes:**
- New input field in admin.html: "📌 Theme/Prompt (Optional)"
- Placeholder text guides teachers on usage
- Help text explains how to use the feature

**Files Modified:**
- `public/admin.html` (added UI input field and updated generateAIQuiz function)
- `server.js` (updated /api/admin/generate-ai-quiz endpoint)

---

### 3. 🎯 **Question Relevance & Variety**
**Problem:** Without theme guidance, questions could be repetitive across days and lacked context-based relevance.

**Solution Implemented:**
- Theme parameter is now included in the Groq API prompt to guide question generation
- AI generates questions specifically related to the provided theme
- Maintains existing duplicate prevention logic to avoid repetition
- Falls back to question bank if AI generation fails after all retries

**Files Modified:** `server.js` (enhanced `generateQuizQuestionsWithAI()` function)

---

## Technical Implementation Details

### Backend Changes (`server.js`)

#### 1. Enhanced Retry Logic
```javascript
function getGroqRetryDelayMs(err, attemptNumber = 0, fallbackMs = 6000) {
  // Extracts retry-after from Groq response
  // Implements exponential backoff: 2^n seconds (max 30s)
  // Adds random jitter to prevent synchronized retries
}
```

#### 2. Updated AI Generation Function
```javascript
async function generateQuizQuestionsWithAI(level, count = 10, options = {}) {
  // Now accepts 'theme' parameter in options
  // Includes theme in Groq API prompt when provided
  // Maintains backward compatibility (theme is optional)
}
```

#### 3. Updated Pending Questions Generation
```javascript
async function generatePendingQuizQuestions(quizDate, levelsToGenerate, options = {}) {
  // Now accepts and passes 'theme' parameter
  // Passes theme to generateQuizQuestionsWithAI
  // Uses improved exponential backoff on Groq rate limit errors
}
```

#### 4. Updated API Endpoint
```javascript
app.post('/api/admin/generate-ai-quiz', async (req, res) => {
  // Now accepts 'prompt' parameter in request body
  // Passes theme through to generation functions
  // Returns theme information in success response
}
```

### Frontend Changes (`admin.html`)

#### 1. Theme Input UI
```html
<input type="text" id="quizPrompt" 
       placeholder="e.g., Teacher's Day, Vocabulary Focus, Spring Theme, Grammar Rules, etc."
       style="width: 100%; padding: 10px 12px; border-radius: 8px;">
```

#### 2. Updated Generate Function
```javascript
async function generateAIQuiz() {
  const prompt = document.getElementById('quizPrompt')?.value?.trim() || '';
  // Sends prompt to backend
  // Displays theme in confirmation dialog and loading message
}
```

---

## How to Use

### For Teachers/Admins:

1. **Go to Admin Dashboard** → **Daily Quiz Management** tab
2. **Enter Theme/Prompt** (optional, examples provided):
   - Leave blank for general English questions
   - Or enter: "Teacher's Day", "Vocabulary Focus", "Grammar Rules", "Holiday Theme", etc.
3. **Select Quiz Date** using the date picker
4. **Click "✨ Generate with AI"** button
5. **Wait for generation** - will show progress message with theme
6. **Review & Edit** generated questions (can modify before approval)
7. **Approve** questions to publish for students

### Theme Examples:

| Theme | Use Case |
|-------|----------|
| Teacher's Day | Generate questions related to teachers and education |
| Vocabulary Focus | More emphasis on vocabulary and word choice questions |
| Grammar Rules | Focus on grammar, sentence structure, and corrections |
| Spring/Seasonal | Generate questions using seasonal vocabulary and contexts |
| Story Elements | Focus on narrative, characters, plot development |

---

## Error Handling & Retry Strategy

### When Groq API is Rate Limited:

1. **First attempt fails** → Wait 2 seconds + jitter
2. **Second attempt fails** → Wait 4 seconds + jitter  
3. **Third attempt fails** → Wait 8 seconds + jitter
4. **Fourth attempt fails** → Wait 16 seconds + jitter
5. **Fifth attempt fails** → Wait 30 seconds + jitter
6. **Subsequent failures** → Continue waiting 30 seconds + jitter
7. **After 8 total attempts** → Falls back to existing question bank
8. **If all fallbacks exhausted** → Returns 429 error to admin with helpful message

### Admin Error Message:
```
"Groq is rate-limited right now and could not create fresh AI questions after retries. 
Please wait a minute and generate again."
```

---

## Files Modified

### 1. `server.js`
- Enhanced `getGroqRetryDelayMs()` with exponential backoff
- Updated `generatePendingQuizQuestions()` to pass attempt number to retry logic
- Updated `generateQuizQuestionsWithAI()` to accept and use theme parameter
- Modified `/api/admin/generate-ai-quiz` endpoint to accept prompt parameter
- All changes maintain backward compatibility

### 2. `public/admin.html`
- Added theme/prompt input field before "Generate with AI" button
- Updated `generateAIQuiz()` function to read and send prompt
- Improved UI messaging to show theme being used

---

## Backward Compatibility

✅ All changes are backward compatible:
- Theme parameter is optional (defaults to null)
- Existing quiz generation still works without specifying a theme
- No database migrations needed
- No breaking API changes

---

## Testing Recommendations

1. **Test with theme:**
   - Generate quiz with theme "Teacher's Day"
   - Verify questions are relevant to the theme
   - Check all three levels have theme-appropriate questions

2. **Test without theme:**
   - Generate quiz without entering theme
   - Verify general English questions are generated
   - Confirm existing behavior is maintained

3. **Test rate limiting:**
   - Monitor logs for "Groq rate limit reached" messages
   - Verify exponential backoff delays are applied (2s, 4s, 8s, etc.)
   - Confirm fallback to question bank after retries

4. **Test question quality:**
   - Review generated questions for relevance
   - Verify no duplicate questions across days
   - Confirm all 4 options are present and valid

---

## Performance Notes

- Exponential backoff reduces server load during rate limiting
- Jitter prevents synchronized retry storms
- Maximum wait time capped at 30 seconds per attempt
- Theme parameter adds minimal overhead to API calls
- Groq API prompt size increased slightly but remains within limits

---

## Future Enhancements

Potential improvements for future versions:
1. Store theme with generated questions for reference
2. Save commonly used themes as templates
3. Add theme suggestions/autocomplete
4. Track which themes work best for different grade levels
5. Add theme-specific category guidance for AI
6. Create pre-built theme packs (holidays, seasons, topics)
