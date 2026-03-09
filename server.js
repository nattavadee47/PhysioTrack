const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;const JWT_SECRET = 'physio_secret';

// ================= DB =================
const pool = mysql.createPool({
  host: 'gateway01.ap-northeast-1.prod.aws.tidbcloud.com',
  user: '3HZNLzyS4E2dJfG.root',
  password: '1CmpzXSMTQxYdngG',
  database: 'stroke_rehab_db',
  ssl: { minVersion: 'TLSv1.2' },
  timezone: '+07:00'
});

// ================= MIDDLEWARE =================
app.use(cors());
app.use(express.json());

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.sendStatus(403);
    req.user = decoded;
    next();
  });
}

const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(err => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

// ================= LOGIN =================
app.post('/api/login', asyncHandler(async (req, res) => {
  const { phone, password } = req.body;

  const [rows] = await pool.query(
    `SELECT u.user_id, u.full_name, u.password_hash, p.physio_id
     FROM Users u
     JOIN Physiotherapists p ON p.user_id = u.user_id
     WHERE u.phone = ?`,
    [phone]
  );

  if (!rows.length) return res.status(401).json({ error: 'ข้อมูลไม่ถูกต้อง' });

  const valid = await bcrypt.compare(password, rows[0].password_hash);
  if (!valid) return res.status(401).json({ error: 'ข้อมูลไม่ถูกต้อง' });

  // ✅ เพิ่ม physio_id ลงใน token เพื่อใช้ตอนสร้างแผน
  const token = jwt.sign(
    { user_id: rows[0].user_id, physio_id: rows[0].physio_id },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({ success: true, token, name: rows[0].full_name });
}));

app.post('/api/logout', auth, (req, res) => res.json({ success: true }));

// ================= DASHBOARD =================
app.get('/api/dashboard', auth, asyncHandler(async (req, res) => {
  // ตรวจสอบว่ามี column status หรือไม่ ถ้าไม่มีให้สร้าง
  try {
    const [cols] = await pool.query(`SHOW COLUMNS FROM Patients LIKE 'status'`);
    if (cols.length === 0) {
      await pool.execute(`ALTER TABLE Patients ADD COLUMN status ENUM('active','followup','completed') NOT NULL DEFAULT 'active'`);
    }
  } catch (e) {
    console.error('alter table error:', e.message);
  }

  const [[count]] = await pool.query(`SELECT COUNT(*) AS total FROM Patients`);
  const [[statusCounts]] = await pool.query(`
    SELECT
      SUM(CASE WHEN status = 'active'    THEN 1 ELSE 0 END) AS active_patients,
      SUM(CASE WHEN status = 'followup'  THEN 1 ELSE 0 END) AS followup_patients,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_patients
    FROM Patients
  `);
  res.json({
    total_patients:     count.total,
    active_patients:    statusCounts.active_patients    || 0,
    followup_patients:  statusCounts.followup_patients  || 0,
    completed_patients: statusCounts.completed_patients || 0
  });
}));

// ================= UPDATE PATIENT STATUS =================
app.put('/api/patients/:id/status', auth, asyncHandler(async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['active', 'followup', 'completed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
  }
  await pool.execute(`UPDATE Patients SET status = ? WHERE patient_id = ?`, [status, req.params.id]);
  res.json({ success: true });
}));

// ================= PATIENTS =================

// ดูรายชื่อผู้ป่วยทั้งหมด
app.get('/api/patients', auth, asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT 
       p.patient_id,
       p.first_name,
       p.last_name,
       TIMESTAMPDIFF(YEAR, p.birth_date, CURDATE()) AS age,
       p.gender,
       p.injured_side,
       p.injured_part,
       COALESCE(p.status, 'active') AS status,
       COUNT(es.session_id) AS total_sessions,
       COALESCE(AVG(es.accuracy_percent), 0) AS avg_score
     FROM Patients p
     LEFT JOIN Exercise_Sessions es 
       ON es.patient_id = p.patient_id AND es.completed = 1
     GROUP BY p.patient_id
     ORDER BY p.patient_id DESC`
  );
  res.json(rows);
}));

// เพิ่มผู้ป่วยใหม่ — dynamic ตาม column จริงใน DB
app.post('/api/patients', auth, asyncHandler(async (req, res) => {
  const [cols] = await pool.query('SHOW COLUMNS FROM Patients');
  const colNames = cols.map(c => c.Field);

  const fieldMap = {
    user_id:                 req.user.user_id,           // ✅ ดึงจาก token
    first_name:              req.body.first_name,
    last_name:               req.body.last_name,
    birth_date:              req.body.birth_date,
    gender:                  req.body.gender         || null,
    injured_side:            req.body.injured_side   || null,
    injured_part:            req.body.injured_part   || null,
    diagnosis:               req.body.diagnosis      || null,
    patient_phone:           req.body.patient_phone  || null,
    emergency_contact_name:  req.body.emergency_contact_name  || null,
    emergency_contact_phone: req.body.emergency_contact_phone || null,
  };

  const validFields = Object.keys(fieldMap).filter(f => colNames.includes(f));
  const values      = validFields.map(f => fieldMap[f]);
  const fieldList   = validFields.join(', ');
  const placeholders = validFields.map(() => '?').join(', ');

  const [result] = await pool.execute(
    `INSERT INTO Patients (${fieldList}) VALUES (${placeholders})`,
    values
  );
  res.json({ success: true, patient_id: result.insertId });
}));

// ดูข้อมูลผู้ป่วยรายบุคคล
app.get('/api/patients/:id', auth, asyncHandler(async (req, res) => {
  // ดึง column จริงก่อน เพื่อป้องกัน column ไม่มีใน DB
  const [cols] = await pool.query(`SHOW COLUMNS FROM Patients`);
  const colNames = cols.map(c => c.Field);
  const hasBirthDate = colNames.includes('birth_date');

  const selectAge = hasBirthDate
    ? ', TIMESTAMPDIFF(YEAR, birth_date, CURDATE()) AS age'
    : ', NULL AS age';

  const [rows] = await pool.query(
    `SELECT *${selectAge} FROM Patients WHERE patient_id = ?`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'ไม่พบผู้ป่วย' });
  res.json(rows[0]);
}));

// ✅ แก้ไขข้อมูลส่วนตัวผู้ป่วย — dynamic ตาม column จริงใน DB
app.put('/api/patients/:id', auth, asyncHandler(async (req, res) => {
  const [cols] = await pool.query('SHOW COLUMNS FROM Patients');
  const colNames = cols.map(c => c.Field);

  const fieldMap = {
    first_name:                req.body.first_name,
    last_name:                 req.body.last_name,
    birth_date:                req.body.birth_date,
    gender:                    req.body.gender         || null,
    injured_side:              req.body.injured_side   || null,
    injured_part:              req.body.injured_part   || null,
    diagnosis:                 req.body.diagnosis      || null,
    patient_phone:             req.body.patient_phone  || null,
    emergency_contact_name:    req.body.emergency_contact_name  || null,
    emergency_contact_phone:   req.body.emergency_contact_phone || null,
  };

  const validFields = Object.keys(fieldMap).filter(f => colNames.includes(f));
  if (!validFields.length) return res.status(400).json({ error: 'ไม่มี column ที่อัพเดตได้' });

  const setClauses = validFields.map(f => `${f} = ?`).join(', ');
  const values     = validFields.map(f => fieldMap[f]);
  values.push(req.params.id);

  await pool.execute(
    `UPDATE Patients SET ${setClauses} WHERE patient_id = ?`,
    values
  );
  res.json({ success: true });
}));

// ================= HISTORY =================
app.get('/api/patients/:id/appointments', auth, asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT 
       session_id AS appointment_id,
       DATE(session_date) AS appointment_date,
       TIME(session_date) AS appointment_time,
       notes,
       'Completed' AS status
     FROM Exercise_Sessions
     WHERE patient_id = ? AND completed = 1
     ORDER BY session_date DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

// ================= TRAINING RESULTS =================
// ✅ ดึงชื่อท่า (name_th) จากตาราง Exercises
app.get('/api/patients/:id/training-results', auth, asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT 
       es.session_date,
       e.name_th AS exercise_name,
       es.actual_reps AS score,
       es.accuracy_percent AS accuracy,
       ROUND(es.duration_seconds / 60, 2) AS duration_minutes,
       es.notes
     FROM Exercise_Sessions es
     LEFT JOIN Exercises e ON e.exercise_id = es.exercise_id
     WHERE es.patient_id = ? AND es.completed = 1
     ORDER BY es.session_date DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

// ================= STATS =================
app.get('/api/patients/:id/stats', auth, asyncHandler(async (req, res) => {
  // สถิติรวม
  // actual_reps_left + actual_reps_right + actual_reps (รวม)
  // ใช้ GREATEST เพื่อไม่นับซ้ำ: ถ้ามี actual_reps ใช้เลย ถ้าไม่มีให้บวก left+right
  let stats = { total_sessions: 0, total_reps: 0, total_minutes: 0 };
  try {
    const [[row]] = await pool.query(
      `SELECT
         COUNT(DISTINCT DATE(session_date)) AS total_sessions,
         COALESCE(SUM(
           CASE WHEN actual_reps > 0 THEN actual_reps
                ELSE COALESCE(actual_reps_left,0) + COALESCE(actual_reps_right,0)
           END
         ), 0) AS total_reps,
         COALESCE(SUM(duration_seconds) / 60, 0) AS total_minutes
       FROM Exercise_Sessions
       WHERE patient_id = ? AND completed = 1`,
      [req.params.id]
    );
    stats = row;
  } catch (e) {
    console.error('stats query error:', e.message);
  }

  // จำนวนครั้งรายวัน สำหรับกราฟเส้น
  let weekly = [];
  try {
    const [rows] = await pool.query(
      `SELECT
         DATE_FORMAT(DATE(session_date), '%d/%m/%Y') AS session_day,
         DATE(session_date) AS raw_day,
         COALESCE(SUM(
           CASE WHEN actual_reps > 0 THEN actual_reps
                ELSE COALESCE(actual_reps_left,0) + COALESCE(actual_reps_right,0)
           END
         ), 0) AS total_reps
       FROM Exercise_Sessions
       WHERE patient_id = ? AND completed = 1
       GROUP BY DATE(session_date), DATE_FORMAT(DATE(session_date), '%d/%m/%Y')
       ORDER BY DATE(session_date) ASC`,
      [req.params.id]
    );
    weekly = rows;
  } catch (e) {
    console.error('weekly query error:', e.message);
  }

  // จำนวนครั้งแยกตามท่า สำหรับกราฟแท่ง
  let reps_by_exercise = [];
  try {
    const [rows] = await pool.query(
      `SELECT
         COALESCE(e.name_th, CONCAT('ท่า#', es.exercise_id)) AS exercise_name,
         COALESCE(SUM(
           CASE WHEN es.actual_reps > 0 THEN es.actual_reps
                ELSE COALESCE(es.actual_reps_left,0) + COALESCE(es.actual_reps_right,0)
           END
         ), 0) AS total_reps,
         COALESCE(SUM(COALESCE(es.actual_reps_left,0)),  0) AS total_reps_left,
         COALESCE(SUM(COALESCE(es.actual_reps_right,0)), 0) AS total_reps_right,
         COUNT(*) AS session_count
       FROM Exercise_Sessions es
       LEFT JOIN Exercises e ON e.exercise_id = es.exercise_id
       WHERE es.patient_id = ? AND es.completed = 1
       GROUP BY es.exercise_id, e.name_th
       ORDER BY total_reps DESC`,
      [req.params.id]
    );
    reps_by_exercise = rows;
  } catch (e) {
    console.error('reps_by_exercise query error:', e.message);
  }

  res.json({ ...stats, weekly_progress: weekly, reps_by_exercise });
}));

// ================= ASSESSMENTS =================
app.post('/api/patients/:id/assessment', auth, asyncHandler(async (req, res) => {
  const {
    weight, height, bmi,
    arm_raise, elbow_bend, hand_grip, finger_spread,
    walking, balance, pain_level, notes
  } = req.body;

  // ลอง insert แบบเต็มก่อน ถ้าผิดพลาดให้ fallback
  try {
    const [result] = await pool.execute(
      `INSERT INTO Assessments
       (patient_id, weight, height, bmi,
        arm_raise, elbow_bend, hand_grip, finger_spread,
        walking, balance, pain_level, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [req.params.id,
       weight || null, height || null, bmi || null,
       arm_raise || 0, elbow_bend || 0, hand_grip || 0, finger_spread || 0,
       walking || 0, balance || 0, pain_level || 0, notes || '']
    );
    return res.json({ success: true, assessment_id: result.insertId });
  } catch (e) {
    console.error('assessment insert error:', e.message);
    // Fallback: ใช้ SHOW COLUMNS แล้ว insert เฉพาะที่มี
    const [cols] = await pool.query(`SHOW COLUMNS FROM Assessments`);
    const colNames = cols.map(c => c.Field);
    const fieldMap = {
      patient_id: req.params.id,
      weight: weight || null, height: height || null, bmi: bmi || null,
      arm_raise: arm_raise || 0, elbow_bend: elbow_bend || 0,
      hand_grip: hand_grip || 0, finger_spread: finger_spread || 0,
      walking: walking || 0, balance: balance || 0,
      pain_level: pain_level || 0, notes: notes || ''
    };
    const validFields = Object.keys(fieldMap).filter(f => colNames.includes(f));
    const values = validFields.map(f => fieldMap[f]);
    const placeholders = validFields.map(() => '?').join(', ');
    const fieldList = validFields.join(', ');
    const hasCreatedAt = colNames.includes('created_at');
    const sql = hasCreatedAt
      ? `INSERT INTO Assessments (${fieldList}, created_at) VALUES (${placeholders}, NOW())`
      : `INSERT INTO Assessments (${fieldList}) VALUES (${placeholders})`;
    const [result] = await pool.execute(sql, values);
    return res.json({ success: true, assessment_id: result.insertId });
  }
}));

app.get('/api/patients/:id/assessments', auth, asyncHandler(async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM Assessments WHERE patient_id = ? ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    // กรณีไม่มี created_at ลอง order by assessment_id
    try {
      const [rows] = await pool.query(
        `SELECT * FROM Assessments WHERE patient_id = ? ORDER BY assessment_id DESC`,
        [req.params.id]
      );
      res.json(rows);
    } catch (e2) {
      res.json([]);
    }
  }
}));

// ================= EXERCISE PLANS =================

// ✅ ดึงแผนพร้อมรายการท่าในแผน (ตรงกับ ERD: ExercisePlans → Plan_Exercises → Exercises)
app.get('/api/patients/:id/exercise-plans', auth, asyncHandler(async (req, res) => {
  const [plans] = await pool.query(
    `SELECT plan_id, plan_name, start_date, end_date, notes AS plan_notes
     FROM ExercisePlans
     WHERE patient_id = ?
     ORDER BY plan_id DESC`,
    [req.params.id]
  );

  for (const plan of plans) {
    const [exercises] = await pool.query(
      `SELECT 
         pe.plan_exercise_id,
         pe.target_reps,
         pe.target_sets,
         e.exercise_id,
         e.name_th,
         e.name_en,
         e.description,
         e.angle_range,
         e.hold_time,
         e.repetitions,
         e.sets,
         e.rest_time
       FROM Plan_Exercises pe
       JOIN Exercises e ON e.exercise_id = pe.exercise_id
       WHERE pe.plan_id = ?`,
      [plan.plan_id]
    );
    plan.exercises = exercises;
  }

  res.json(plans);
}));

// ✅ สร้างแผนใหม่ (ใช้ physio_id จาก token)
app.post('/api/patients/:id/exercise-plan', auth, asyncHandler(async (req, res) => {
  const { plan_name, start_date, end_date, notes } = req.body;
  const physio_id = req.user.physio_id;

  const [result] = await pool.execute(
    `INSERT INTO ExercisePlans (patient_id, physio_id, plan_name, start_date, end_date, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [req.params.id, physio_id, plan_name, start_date || null, end_date || null, notes || '']
  );
  res.json({ success: true, plan_id: result.insertId });
}));

// ✅ แก้ไขแผน
app.put('/api/exercise-plan/:plan_id', auth, asyncHandler(async (req, res) => {
  const { plan_name, start_date, end_date, notes } = req.body;

  await pool.execute(
    `UPDATE ExercisePlans
     SET plan_name = ?, start_date = ?, end_date = ?, notes = ?
     WHERE plan_id = ?`,
    [plan_name, start_date || null, end_date || null, notes || '', req.params.plan_id]
  );
  res.json({ success: true });
}));

// ✅ ลบแผน (ลบ Plan_Exercises ที่เกี่ยวข้องก่อน)
app.delete('/api/exercise-plan/:plan_id', auth, asyncHandler(async (req, res) => {
  await pool.execute(`DELETE FROM Plan_Exercises WHERE plan_id = ?`, [req.params.plan_id]);
  await pool.execute(`DELETE FROM ExercisePlans WHERE plan_id = ?`, [req.params.plan_id]);
  res.json({ success: true });
}));

// ✅ เพิ่มท่าออกกำลังกายเข้าแผน (Plan_Exercises)
app.post('/api/exercise-plan/:plan_id/exercises', auth, asyncHandler(async (req, res) => {
  const { exercise_id, target_reps, target_sets } = req.body;

  const [result] = await pool.execute(
    `INSERT INTO Plan_Exercises (plan_id, exercise_id, target_reps, target_sets)
     VALUES (?, ?, ?, ?)`,
    [req.params.plan_id, exercise_id, target_reps || 10, target_sets || 3]
  );
  res.json({ success: true, plan_exercise_id: result.insertId });
}));

// ✅ ลบท่าออกจากแผน
app.delete('/api/plan-exercise/:plan_exercise_id', auth, asyncHandler(async (req, res) => {
  await pool.execute(
    `DELETE FROM Plan_Exercises WHERE plan_exercise_id = ?`,
    [req.params.plan_exercise_id]
  );
  res.json({ success: true });
}));

// ================= EXERCISES (คลังท่าออกกำลังกายทั้งหมด) =================

// ✅ ดึงท่าทั้งหมดให้นักกายภาพเลือกใส่แผน
app.get('/api/exercises', auth, asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT exercise_id, name_th, name_en, description,
            angle_range, hold_time, repetitions, sets, rest_time
     FROM Exercises
     ORDER BY exercise_id ASC`
  );
  res.json(rows);
}));

// ✅ ปรับเกณฑ์การตรวจจับท่าทาง angle_range (แทน posture_threshold เดิม)
app.put('/api/exercises/:exercise_id/threshold', auth, asyncHandler(async (req, res) => {
  const { angle_range } = req.body;

  await pool.execute(
    `UPDATE Exercises SET angle_range = ? WHERE exercise_id = ?`,
    [angle_range, req.params.exercise_id]
  );
  res.json({ success: true });
}));

// ================= START =================
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
