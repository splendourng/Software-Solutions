'use strict';

const express = require('express');
const { getPool, withTransaction } = require('../db/pool');
const { ok, fail } = require('../utils/response');
const { authenticate, requirePermission } = require('../middleware/auth');
const { writeAudit, writeActivity } = require('../middleware/audit');
const { pageParams, sanitizeLike } = require('../utils/helpers');
const {
  addTimeline,
  createNotification,
  notifyDepartmentUsers,
  createAlert,
  getDepartmentIdByCode,
  generateId,
  broadcastAuthorized
} = require('../utils/services');

const router = express.Router();

function listMeta(page, limit, total) {
  return { page, limit, total, pages: Math.ceil(total / limit) || 1 };
}

/* ───────────────────────────── Encounters ───────────────────────────── */

router.get('/encounters', authenticate(true), requirePermission('encounters.view'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search, sort, order } = pageParams(req.query);
    const allowedSort = new Set(['created_at', 'started_at', 'encounter_number', 'status', 'updated_at']);
    const sortCol = allowedSort.has(sort) ? sort : 'started_at';
    const where = ['1=1'];
    const params = [];

    if (req.query.patient_id) {
      where.push('e.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.status) {
      where.push('e.status = ?');
      params.push(req.query.status);
    }
    if (req.query.department_id) {
      where.push('e.department_id = ?');
      params.push(parseInt(req.query.department_id, 10));
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(e.encounter_number LIKE ? OR p.full_name LIKE ? OR p.patient_number LIKE ? OR e.chief_complaint LIKE ?)');
      params.push(like, like, like, like);
    }

    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM encounters e JOIN patients p ON p.id = e.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT e.*, p.full_name AS patient_name, p.patient_number, p.hospital_number,
              s.full_name AS clinician_name, d.name AS department_name
       FROM encounters e
       JOIN patients p ON p.id = e.patient_id
       LEFT JOIN staff s ON s.id = e.clinician_staff_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE ${whereSql}
       ORDER BY e.${sortCol} ${order}
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list encounters', 500, err);
  }
});

router.get('/encounters/:id', authenticate(true), requirePermission('encounters.view'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT e.*, p.full_name AS patient_name, p.patient_number, p.hospital_number,
              s.full_name AS clinician_name, d.name AS department_name
       FROM encounters e
       JOIN patients p ON p.id = e.patient_id
       LEFT JOIN staff s ON s.id = e.clinician_staff_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.id = ? LIMIT 1`,
      [req.params.id]
    );
    if (!rows.length) return fail(res, 'Encounter not found', 404);
    return ok(res, { encounter: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load encounter', 500, err);
  }
});

router.post('/encounters', authenticate(true), requirePermission('encounters.manage'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    if (!patientId) return fail(res, 'patient_id is required', 400);

    const result = await withTransaction(async (conn) => {
      const encounterNumber = await generateId(conn, 'ENCOUNTER');
      const clinicianId = b.clinician_staff_id != null ? parseInt(b.clinician_staff_id, 10) : (req.user.staff_id || null);
      const departmentId = b.department_id != null
        ? parseInt(b.department_id, 10)
        : (req.user.primary_department?.id || null);

      const [ins] = await conn.execute(
        `INSERT INTO encounters
         (encounter_number, patient_id, appointment_id, clinician_staff_id, department_id,
          encounter_type, chief_complaint, history_present_illness, examination, assessment, plan_text,
          status, started_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()), ?, ?)`,
        [
          encounterNumber,
          patientId,
          b.appointment_id || null,
          clinicianId,
          departmentId,
          b.encounter_type || 'OPD',
          b.chief_complaint || null,
          b.history_present_illness || null,
          b.examination || null,
          b.assessment || null,
          b.plan_text || null,
          b.status || 'OPEN',
          b.started_at || null,
          req.user.id,
          req.user.id
        ]
      );

      await addTimeline(conn, {
        patientId,
        eventType: 'ENCOUNTER',
        eventTitle: `Encounter ${encounterNumber} started`,
        eventDetails: b.chief_complaint || b.encounter_type || null,
        departmentId,
        relatedEntity: 'encounters',
        relatedId: ins.insertId,
        createdBy: req.user.id
      });

      return { id: ins.insertId, encounter_number: encounterNumber };
    });

    await writeAudit(req, {
      action: 'ENCOUNTER_CREATE',
      entity: 'encounters',
      entityId: result.id,
      patientId,
      description: `Created encounter ${result.encounter_number}`,
      newValue: result
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'ENCOUNTER',
      title: `Encounter ${result.encounter_number}`,
      details: 'Encounter created',
      patientId,
      departmentId: req.user.primary_department?.id || null
    });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: 'encounter:created',
      data: result,
      departmentIds: [req.user.primary_department?.id].filter(Boolean),
      roles: ['DOCTOR', 'HOD'],
      globalAdmin: true
    });

    return ok(res, result, 'Encounter created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to create encounter', 500, err);
  }
});

router.put('/encounters/:id', authenticate(true), requirePermission('encounters.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM encounters WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Encounter not found', 404);
    const enc = existing[0];
    const b = req.body || {};

    await pool.execute(
      `UPDATE encounters SET
         clinician_staff_id = COALESCE(?, clinician_staff_id),
         department_id = COALESCE(?, department_id),
         encounter_type = COALESCE(?, encounter_type),
         chief_complaint = COALESCE(?, chief_complaint),
         history_present_illness = COALESCE(?, history_present_illness),
         examination = COALESCE(?, examination),
         assessment = COALESCE(?, assessment),
         plan_text = COALESCE(?, plan_text),
         status = COALESCE(?, status),
         ended_at = COALESCE(?, ended_at),
         updated_by = ?
       WHERE id = ?`,
      [
        b.clinician_staff_id !== undefined ? b.clinician_staff_id : null,
        b.department_id !== undefined ? b.department_id : null,
        b.encounter_type !== undefined ? b.encounter_type : null,
        b.chief_complaint !== undefined ? b.chief_complaint : null,
        b.history_present_illness !== undefined ? b.history_present_illness : null,
        b.examination !== undefined ? b.examination : null,
        b.assessment !== undefined ? b.assessment : null,
        b.plan_text !== undefined ? b.plan_text : null,
        b.status !== undefined ? b.status : null,
        b.ended_at !== undefined ? b.ended_at : null,
        req.user.id,
        id
      ]
    );

    if (b.status === 'CLOSED' && enc.status !== 'CLOSED') {
      await addTimeline(null, {
        patientId: enc.patient_id,
        eventType: 'ENCOUNTER',
        eventTitle: `Encounter ${enc.encounter_number} closed`,
        relatedEntity: 'encounters',
        relatedId: id,
        departmentId: enc.department_id,
        createdBy: req.user.id
      });
    }

    await writeAudit(req, {
      action: 'ENCOUNTER_UPDATE',
      entity: 'encounters',
      entityId: id,
      patientId: enc.patient_id,
      description: `Updated encounter ${enc.encounter_number}`,
      oldValue: enc,
      newValue: b
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'ENCOUNTER',
      title: `Updated encounter ${enc.encounter_number}`,
      patientId: enc.patient_id,
      departmentId: enc.department_id
    });

    const [rows] = await pool.execute(`SELECT * FROM encounters WHERE id = ?`, [id]);
    return ok(res, { encounter: rows[0] }, 'Encounter updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update encounter', 500, err);
  }
});

/* ───────────────────────────── Diagnoses ───────────────────────────── */

router.get('/diagnoses', authenticate(true), requirePermission('encounters.view', 'clinical.diagnose', 'clinical.view_results'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('d.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.encounter_id) {
      where.push('d.encounter_id = ?');
      params.push(parseInt(req.query.encounter_id, 10));
    }
    if (req.query.status) {
      where.push('d.status = ?');
      params.push(req.query.status);
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(d.diagnosis_name LIKE ? OR d.diagnosis_code LIKE ? OR p.full_name LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM diagnoses d JOIN patients p ON p.id = d.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT d.*, p.full_name AS patient_name, p.patient_number
       FROM diagnoses d JOIN patients p ON p.id = d.patient_id
       WHERE ${whereSql}
       ORDER BY d.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list diagnoses', 500, err);
  }
});

router.get('/diagnoses/:id', authenticate(true), requirePermission('encounters.view', 'clinical.diagnose', 'clinical.view_results'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT d.*, p.full_name AS patient_name FROM diagnoses d
       JOIN patients p ON p.id = d.patient_id WHERE d.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return fail(res, 'Diagnosis not found', 404);
    return ok(res, { diagnosis: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load diagnosis', 500, err);
  }
});

router.post('/diagnoses', authenticate(true), requirePermission('clinical.diagnose'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    if (!patientId || !b.diagnosis_name) return fail(res, 'patient_id and diagnosis_name are required', 400);

    const pool = getPool();
    const [ins] = await pool.execute(
      `INSERT INTO diagnoses
       (patient_id, encounter_id, admission_id, diagnosis_code, diagnosis_name, diagnosis_type, notes, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        patientId,
        b.encounter_id || null,
        b.admission_id || null,
        b.diagnosis_code || null,
        b.diagnosis_name,
        b.diagnosis_type || 'PRIMARY',
        b.notes || null,
        b.status || 'ACTIVE',
        req.user.id,
        req.user.id
      ]
    );

    await addTimeline(null, {
      patientId,
      eventType: 'DIAGNOSIS',
      eventTitle: `Diagnosis: ${b.diagnosis_name}`,
      eventDetails: b.diagnosis_code || b.diagnosis_type || null,
      relatedEntity: 'diagnoses',
      relatedId: ins.insertId,
      departmentId: req.user.primary_department?.id || null,
      createdBy: req.user.id
    });
    await writeAudit(req, {
      action: 'DIAGNOSIS_CREATE',
      entity: 'diagnoses',
      entityId: ins.insertId,
      patientId,
      description: `Added diagnosis ${b.diagnosis_name}`
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'DIAGNOSIS',
      title: `Diagnosis recorded: ${b.diagnosis_name}`,
      patientId,
      departmentId: req.user.primary_department?.id || null
    });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: 'diagnosis:created',
      data: { id: ins.insertId, patient_id: patientId, diagnosis_name: b.diagnosis_name },
      roles: ['DOCTOR', 'HOD_NURSING'],
      globalAdmin: true
    });

    return ok(res, { id: ins.insertId }, 'Diagnosis created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to create diagnosis', 500, err);
  }
});

router.put('/diagnoses/:id', authenticate(true), requirePermission('clinical.diagnose'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM diagnoses WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Diagnosis not found', 404);
    const dx = existing[0];
    const b = req.body || {};

    const previousValue = b.correction_reason
      ? JSON.stringify({
        diagnosis_name: dx.diagnosis_name,
        diagnosis_code: dx.diagnosis_code,
        diagnosis_type: dx.diagnosis_type,
        notes: dx.notes
      })
      : dx.previous_value;

    await pool.execute(
      `UPDATE diagnoses SET
         diagnosis_code = COALESCE(?, diagnosis_code),
         diagnosis_name = COALESCE(?, diagnosis_name),
         diagnosis_type = COALESCE(?, diagnosis_type),
         notes = COALESCE(?, notes),
         status = COALESCE(?, status),
         version = version + IF(?, 1, 0),
         previous_value = COALESCE(?, previous_value),
         correction_reason = COALESCE(?, correction_reason),
         updated_by = ?
       WHERE id = ?`,
      [
        b.diagnosis_code !== undefined ? b.diagnosis_code : null,
        b.diagnosis_name !== undefined ? b.diagnosis_name : null,
        b.diagnosis_type !== undefined ? b.diagnosis_type : null,
        b.notes !== undefined ? b.notes : null,
        b.status !== undefined ? b.status : null,
        b.correction_reason ? 1 : 0,
        b.correction_reason ? previousValue : null,
        b.correction_reason !== undefined ? b.correction_reason : null,
        req.user.id,
        id
      ]
    );

    await writeAudit(req, {
      action: 'DIAGNOSIS_UPDATE',
      entity: 'diagnoses',
      entityId: id,
      patientId: dx.patient_id,
      description: `Updated diagnosis ${dx.diagnosis_name}`,
      oldValue: dx,
      newValue: b,
      severity: b.correction_reason ? 'IMPORTANT' : 'INFO'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'DIAGNOSIS',
      title: `Diagnosis updated: ${b.diagnosis_name || dx.diagnosis_name}`,
      patientId: dx.patient_id
    });

    const [rows] = await pool.execute(`SELECT * FROM diagnoses WHERE id = ?`, [id]);
    return ok(res, { diagnosis: rows[0] }, 'Diagnosis updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update diagnosis', 500, err);
  }
});

/* ───────────────────────────── Symptoms ───────────────────────────── */

router.get('/symptoms', authenticate(true), requirePermission('encounters.view', 'clinical.notes'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('s.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.encounter_id) {
      where.push('s.encounter_id = ?');
      params.push(parseInt(req.query.encounter_id, 10));
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(s.symptom_name LIKE ? OR p.full_name LIKE ?)');
      params.push(like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM symptoms s JOIN patients p ON p.id = s.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT s.*, p.full_name AS patient_name FROM symptoms s
       JOIN patients p ON p.id = s.patient_id
       WHERE ${whereSql}
       ORDER BY s.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list symptoms', 500, err);
  }
});

router.get('/symptoms/:id', authenticate(true), requirePermission('encounters.view', 'clinical.notes'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM symptoms WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'Symptom not found', 404);
    return ok(res, { symptom: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load symptom', 500, err);
  }
});

router.post('/symptoms', authenticate(true), requirePermission('clinical.notes', 'encounters.manage'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    if (!patientId || !b.symptom_name) return fail(res, 'patient_id and symptom_name are required', 400);
    const pool = getPool();
    const [ins] = await pool.execute(
      `INSERT INTO symptoms (patient_id, encounter_id, symptom_name, severity, onset, notes, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [patientId, b.encounter_id || null, b.symptom_name, b.severity || null, b.onset || null, b.notes || null, b.status || 'ACTIVE', req.user.id]
    );
    await addTimeline(null, {
      patientId,
      eventType: 'SYMPTOM',
      eventTitle: `Symptom: ${b.symptom_name}`,
      eventDetails: b.severity || null,
      relatedEntity: 'symptoms',
      relatedId: ins.insertId,
      createdBy: req.user.id
    });
    await writeAudit(req, { action: 'SYMPTOM_CREATE', entity: 'symptoms', entityId: ins.insertId, patientId, description: `Recorded symptom ${b.symptom_name}` });
    await writeActivity({ userId: req.user.id, activityType: 'SYMPTOM', title: `Symptom: ${b.symptom_name}`, patientId });
    return ok(res, { id: ins.insertId }, 'Symptom recorded', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to record symptom', 500, err);
  }
});

router.put('/symptoms/:id', authenticate(true), requirePermission('clinical.notes', 'encounters.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM symptoms WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Symptom not found', 404);
    const b = req.body || {};
    await pool.execute(
      `UPDATE symptoms SET
         symptom_name = COALESCE(?, symptom_name),
         severity = COALESCE(?, severity),
         onset = COALESCE(?, onset),
         notes = COALESCE(?, notes),
         status = COALESCE(?, status)
       WHERE id = ?`,
      [
        b.symptom_name !== undefined ? b.symptom_name : null,
        b.severity !== undefined ? b.severity : null,
        b.onset !== undefined ? b.onset : null,
        b.notes !== undefined ? b.notes : null,
        b.status !== undefined ? b.status : null,
        id
      ]
    );
    await writeAudit(req, { action: 'SYMPTOM_UPDATE', entity: 'symptoms', entityId: id, patientId: existing[0].patient_id, description: 'Updated symptom', oldValue: existing[0], newValue: b });
    const [rows] = await pool.execute(`SELECT * FROM symptoms WHERE id = ?`, [id]);
    return ok(res, { symptom: rows[0] }, 'Symptom updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update symptom', 500, err);
  }
});

/* ───────────────────────────── Doctors notes ───────────────────────────── */

router.get('/doctors-notes', authenticate(true), requirePermission('clinical.notes', 'encounters.view'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('n.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.encounter_id) {
      where.push('n.encounter_id = ?');
      params.push(parseInt(req.query.encounter_id, 10));
    }
    if (req.query.admission_id) {
      where.push('n.admission_id = ?');
      params.push(parseInt(req.query.admission_id, 10));
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(n.note_text LIKE ? OR n.note_type LIKE ? OR p.full_name LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM doctors_notes n JOIN patients p ON p.id = n.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT n.*, p.full_name AS patient_name, u.display_name AS author_name
       FROM doctors_notes n
       JOIN patients p ON p.id = n.patient_id
       LEFT JOIN users u ON u.id = n.created_by
       WHERE ${whereSql}
       ORDER BY n.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list doctors notes', 500, err);
  }
});

router.get('/doctors-notes/:id', authenticate(true), requirePermission('clinical.notes', 'encounters.view'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM doctors_notes WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'Note not found', 404);
    return ok(res, { note: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load note', 500, err);
  }
});

router.post('/doctors-notes', authenticate(true), requirePermission('clinical.notes'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    if (!patientId || !b.note_text) return fail(res, 'patient_id and note_text are required', 400);
    const pool = getPool();
    const [ins] = await pool.execute(
      `INSERT INTO doctors_notes
       (patient_id, encounter_id, admission_id, note_type, note_text, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [patientId, b.encounter_id || null, b.admission_id || null, b.note_type || 'PROGRESS', b.note_text, b.status || 'FINAL', req.user.id, req.user.id]
    );
    await addTimeline(null, {
      patientId,
      eventType: 'DOCTORS_NOTE',
      eventTitle: `Doctor note (${b.note_type || 'PROGRESS'})`,
      eventDetails: String(b.note_text).slice(0, 240),
      relatedEntity: 'doctors_notes',
      relatedId: ins.insertId,
      departmentId: req.user.primary_department?.id || null,
      createdBy: req.user.id
    });
    await writeAudit(req, { action: 'DOCTORS_NOTE_CREATE', entity: 'doctors_notes', entityId: ins.insertId, patientId, description: 'Created doctor note' });
    await writeActivity({ userId: req.user.id, activityType: 'CLINICAL_NOTE', title: 'Doctor note recorded', patientId, departmentId: req.user.primary_department?.id || null });
    return ok(res, { id: ins.insertId }, 'Doctor note created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to create doctor note', 500, err);
  }
});

router.put('/doctors-notes/:id', authenticate(true), requirePermission('clinical.notes'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM doctors_notes WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Note not found', 404);
    const note = existing[0];
    const b = req.body || {};
    await pool.execute(
      `UPDATE doctors_notes SET
         note_type = COALESCE(?, note_type),
         note_text = COALESCE(?, note_text),
         status = COALESCE(?, status),
         version = version + IF(?, 1, 0),
         previous_value = COALESCE(?, previous_value),
         correction_reason = COALESCE(?, correction_reason),
         updated_by = ?
       WHERE id = ?`,
      [
        b.note_type !== undefined ? b.note_type : null,
        b.note_text !== undefined ? b.note_text : null,
        b.status !== undefined ? b.status : null,
        b.correction_reason ? 1 : 0,
        b.correction_reason ? note.note_text : null,
        b.correction_reason !== undefined ? b.correction_reason : null,
        req.user.id,
        id
      ]
    );
    await writeAudit(req, {
      action: 'DOCTORS_NOTE_UPDATE',
      entity: 'doctors_notes',
      entityId: id,
      patientId: note.patient_id,
      description: 'Updated doctor note',
      oldValue: { note_text: note.note_text },
      newValue: b,
      severity: b.correction_reason ? 'IMPORTANT' : 'INFO'
    });
    await writeActivity({ userId: req.user.id, activityType: 'CLINICAL_NOTE', title: 'Doctor note updated', patientId: note.patient_id });
    const [rows] = await pool.execute(`SELECT * FROM doctors_notes WHERE id = ?`, [id]);
    return ok(res, { note: rows[0] }, 'Doctor note updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update doctor note', 500, err);
  }
});

/* ───────────────────────────── Referrals ───────────────────────────── */

router.get('/referrals', authenticate(true), requirePermission('encounters.view', 'clinical.notes'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('r.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.status) {
      where.push('r.status = ?');
      params.push(req.query.status);
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(r.referral_number LIKE ? OR r.reason LIKE ? OR p.full_name LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM referrals r JOIN patients p ON p.id = r.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT r.*, p.full_name AS patient_name, p.patient_number,
              fd.name AS from_department_name, td.name AS to_department_name
       FROM referrals r
       JOIN patients p ON p.id = r.patient_id
       LEFT JOIN departments fd ON fd.id = r.from_department_id
       LEFT JOIN departments td ON td.id = r.to_department_id
       WHERE ${whereSql}
       ORDER BY r.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list referrals', 500, err);
  }
});

router.get('/referrals/:id', authenticate(true), requirePermission('encounters.view', 'clinical.notes'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM referrals WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'Referral not found', 404);
    return ok(res, { referral: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load referral', 500, err);
  }
});

router.post('/referrals', authenticate(true), requirePermission('clinical.notes', 'encounters.manage'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    if (!patientId) return fail(res, 'patient_id is required', 400);

    const result = await withTransaction(async (conn) => {
      const referralNumber = await generateId(conn, 'REFERRAL');
      const fromDept = b.from_department_id != null ? parseInt(b.from_department_id, 10) : (req.user.primary_department?.id || null);
      const toDept = b.to_department_id != null ? parseInt(b.to_department_id, 10) : null;
      const [ins] = await conn.execute(
        `INSERT INTO referrals
         (referral_number, patient_id, from_department_id, to_department_id, from_staff_id, to_staff_id, reason, urgency, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          referralNumber,
          patientId,
          fromDept,
          toDept,
          b.from_staff_id || req.user.staff_id || null,
          b.to_staff_id || null,
          b.reason || null,
          b.urgency || 'NORMAL',
          b.status || 'PENDING',
          req.user.id
        ]
      );
      await addTimeline(conn, {
        patientId,
        eventType: 'REFERRAL',
        eventTitle: `Referral ${referralNumber}`,
        eventDetails: b.reason || null,
        departmentId: toDept || fromDept,
        relatedEntity: 'referrals',
        relatedId: ins.insertId,
        createdBy: req.user.id
      });
      return { id: ins.insertId, referral_number: referralNumber, to_department_id: toDept };
    });

    if (result.to_department_id) {
      await notifyDepartmentUsers(result.to_department_id, {
        patientId,
        category: 'CLINICAL',
        priority: b.urgency === 'URGENT' || b.urgency === 'CRITICAL' ? b.urgency : 'NORMAL',
        title: `New referral ${result.referral_number}`,
        message: b.reason || 'Patient referral received',
        relatedEntity: 'referrals',
        relatedId: result.id
      }, req.user.id);
    }

    await writeAudit(req, { action: 'REFERRAL_CREATE', entity: 'referrals', entityId: result.id, patientId, description: `Created referral ${result.referral_number}` });
    await writeActivity({ userId: req.user.id, activityType: 'REFERRAL', title: `Referral ${result.referral_number}`, patientId, departmentId: result.to_department_id });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: 'referral:created',
      data: result,
      departmentIds: [result.to_department_id].filter(Boolean),
      roles: ['DOCTOR', 'HOD'],
      globalAdmin: true
    });

    return ok(res, result, 'Referral created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to create referral', 500, err);
  }
});

router.put('/referrals/:id', authenticate(true), requirePermission('clinical.notes', 'encounters.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM referrals WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Referral not found', 404);
    const ref = existing[0];
    const b = req.body || {};
    await pool.execute(
      `UPDATE referrals SET
         to_department_id = COALESCE(?, to_department_id),
         to_staff_id = COALESCE(?, to_staff_id),
         reason = COALESCE(?, reason),
         urgency = COALESCE(?, urgency),
         status = COALESCE(?, status)
       WHERE id = ?`,
      [
        b.to_department_id !== undefined ? b.to_department_id : null,
        b.to_staff_id !== undefined ? b.to_staff_id : null,
        b.reason !== undefined ? b.reason : null,
        b.urgency !== undefined ? b.urgency : null,
        b.status !== undefined ? b.status : null,
        id
      ]
    );
    await writeAudit(req, { action: 'REFERRAL_UPDATE', entity: 'referrals', entityId: id, patientId: ref.patient_id, description: `Updated referral ${ref.referral_number}`, oldValue: ref, newValue: b });
    await writeActivity({ userId: req.user.id, activityType: 'REFERRAL', title: `Referral updated ${ref.referral_number}`, patientId: ref.patient_id });
    const [rows] = await pool.execute(`SELECT * FROM referrals WHERE id = ?`, [id]);
    return ok(res, { referral: rows[0] }, 'Referral updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update referral', 500, err);
  }
});

/* ───────────────────────────── Consultations ───────────────────────────── */

router.get('/consultations', authenticate(true), requirePermission('encounters.view', 'clinical.notes'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('c.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.status) {
      where.push('c.status = ?');
      params.push(req.query.status);
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(c.reason LIKE ? OR c.opinion LIKE ? OR p.full_name LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM consultations c JOIN patients p ON p.id = c.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT c.*, p.full_name AS patient_name, d.name AS department_name
       FROM consultations c
       JOIN patients p ON p.id = c.patient_id
       LEFT JOIN departments d ON d.id = c.department_id
       WHERE ${whereSql}
       ORDER BY c.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list consultations', 500, err);
  }
});

router.get('/consultations/:id', authenticate(true), requirePermission('encounters.view', 'clinical.notes'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM consultations WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'Consultation not found', 404);
    return ok(res, { consultation: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load consultation', 500, err);
  }
});

router.post('/consultations', authenticate(true), requirePermission('clinical.notes', 'encounters.manage'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    if (!patientId) return fail(res, 'patient_id is required', 400);
    const pool = getPool();
    const deptId = b.department_id != null ? parseInt(b.department_id, 10) : (req.user.primary_department?.id || null);
    const [ins] = await pool.execute(
      `INSERT INTO consultations
       (patient_id, encounter_id, requesting_staff_id, consulting_staff_id, department_id, reason, opinion, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        patientId,
        b.encounter_id || null,
        b.requesting_staff_id || req.user.staff_id || null,
        b.consulting_staff_id || null,
        deptId,
        b.reason || null,
        b.opinion || null,
        b.status || 'PENDING',
        req.user.id
      ]
    );
    await addTimeline(null, {
      patientId,
      eventType: 'CONSULTATION',
      eventTitle: 'Consultation requested',
      eventDetails: b.reason || null,
      departmentId: deptId,
      relatedEntity: 'consultations',
      relatedId: ins.insertId,
      createdBy: req.user.id
    });
    if (deptId) {
      await notifyDepartmentUsers(deptId, {
        patientId,
        category: 'CLINICAL',
        priority: 'NORMAL',
        title: 'New consultation request',
        message: b.reason || 'Consultation requested',
        relatedEntity: 'consultations',
        relatedId: ins.insertId
      }, req.user.id);
    }
    await writeAudit(req, { action: 'CONSULTATION_CREATE', entity: 'consultations', entityId: ins.insertId, patientId, description: 'Consultation requested' });
    await writeActivity({ userId: req.user.id, activityType: 'CONSULTATION', title: 'Consultation requested', patientId, departmentId: deptId });
    return ok(res, { id: ins.insertId }, 'Consultation created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to create consultation', 500, err);
  }
});

router.put('/consultations/:id', authenticate(true), requirePermission('clinical.notes', 'encounters.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM consultations WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Consultation not found', 404);
    const c = existing[0];
    const b = req.body || {};
    await pool.execute(
      `UPDATE consultations SET
         consulting_staff_id = COALESCE(?, consulting_staff_id),
         department_id = COALESCE(?, department_id),
         reason = COALESCE(?, reason),
         opinion = COALESCE(?, opinion),
         status = COALESCE(?, status)
       WHERE id = ?`,
      [
        b.consulting_staff_id !== undefined ? b.consulting_staff_id : null,
        b.department_id !== undefined ? b.department_id : null,
        b.reason !== undefined ? b.reason : null,
        b.opinion !== undefined ? b.opinion : null,
        b.status !== undefined ? b.status : null,
        id
      ]
    );
    if (b.opinion && !c.opinion) {
      await addTimeline(null, {
        patientId: c.patient_id,
        eventType: 'CONSULTATION',
        eventTitle: 'Consultation opinion recorded',
        eventDetails: String(b.opinion).slice(0, 240),
        relatedEntity: 'consultations',
        relatedId: id,
        createdBy: req.user.id
      });
    }
    await writeAudit(req, { action: 'CONSULTATION_UPDATE', entity: 'consultations', entityId: id, patientId: c.patient_id, description: 'Updated consultation', oldValue: c, newValue: b });
    await writeActivity({ userId: req.user.id, activityType: 'CONSULTATION', title: 'Consultation updated', patientId: c.patient_id });
    const [rows] = await pool.execute(`SELECT * FROM consultations WHERE id = ?`, [id]);
    return ok(res, { consultation: rows[0] }, 'Consultation updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update consultation', 500, err);
  }
});

/* ───────────────────────────── Procedures ───────────────────────────── */

router.get('/procedures', authenticate(true), requirePermission('encounters.view', 'clinical.notes'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('pr.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.status) {
      where.push('pr.status = ?');
      params.push(req.query.status);
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(pr.procedure_number LIKE ? OR pr.procedure_name LIKE ? OR p.full_name LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM procedures pr JOIN patients p ON p.id = pr.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT pr.*, p.full_name AS patient_name, s.full_name AS performed_by_name
       FROM procedures pr
       JOIN patients p ON p.id = pr.patient_id
       LEFT JOIN staff s ON s.id = pr.performed_by
       WHERE ${whereSql}
       ORDER BY pr.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list procedures', 500, err);
  }
});

router.get('/procedures/:id', authenticate(true), requirePermission('encounters.view', 'clinical.notes'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM procedures WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'Procedure not found', 404);
    return ok(res, { procedure: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load procedure', 500, err);
  }
});

router.post('/procedures', authenticate(true), requirePermission('clinical.notes', 'encounters.manage'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    if (!patientId || !b.procedure_name) return fail(res, 'patient_id and procedure_name are required', 400);

    const result = await withTransaction(async (conn) => {
      const procedureNumber = await generateId(conn, 'PROCEDURE');
      const [ins] = await conn.execute(
        `INSERT INTO procedures
         (procedure_number, patient_id, encounter_id, admission_id, procedure_name, performed_by, performed_at, notes, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          procedureNumber,
          patientId,
          b.encounter_id || null,
          b.admission_id || null,
          b.procedure_name,
          b.performed_by || req.user.staff_id || null,
          b.performed_at || null,
          b.notes || null,
          b.status || 'SCHEDULED',
          req.user.id
        ]
      );
      await addTimeline(conn, {
        patientId,
        eventType: 'PROCEDURE',
        eventTitle: `Procedure ${procedureNumber}: ${b.procedure_name}`,
        eventDetails: b.notes || b.status || null,
        relatedEntity: 'procedures',
        relatedId: ins.insertId,
        createdBy: req.user.id
      });
      return { id: ins.insertId, procedure_number: procedureNumber };
    });

    await writeAudit(req, { action: 'PROCEDURE_CREATE', entity: 'procedures', entityId: result.id, patientId, description: `Created procedure ${result.procedure_number}` });
    await writeActivity({ userId: req.user.id, activityType: 'PROCEDURE', title: `Procedure ${result.procedure_number}`, patientId });
    const io = req.app.get('io');
    broadcastAuthorized(io, { event: 'procedure:created', data: result, roles: ['DOCTOR', 'STAFF_NURSE'], globalAdmin: true });
    return ok(res, result, 'Procedure created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to create procedure', 500, err);
  }
});

router.put('/procedures/:id', authenticate(true), requirePermission('clinical.notes', 'encounters.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM procedures WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Procedure not found', 404);
    const pr = existing[0];
    const b = req.body || {};
    await pool.execute(
      `UPDATE procedures SET
         procedure_name = COALESCE(?, procedure_name),
         performed_by = COALESCE(?, performed_by),
         performed_at = COALESCE(?, performed_at),
         notes = COALESCE(?, notes),
         status = COALESCE(?, status)
       WHERE id = ?`,
      [
        b.procedure_name !== undefined ? b.procedure_name : null,
        b.performed_by !== undefined ? b.performed_by : null,
        b.performed_at !== undefined ? b.performed_at : null,
        b.notes !== undefined ? b.notes : null,
        b.status !== undefined ? b.status : null,
        id
      ]
    );
    if (b.status === 'COMPLETED' && pr.status !== 'COMPLETED') {
      await addTimeline(null, {
        patientId: pr.patient_id,
        eventType: 'PROCEDURE',
        eventTitle: `Procedure completed: ${pr.procedure_name}`,
        relatedEntity: 'procedures',
        relatedId: id,
        createdBy: req.user.id
      });
    }
    await writeAudit(req, { action: 'PROCEDURE_UPDATE', entity: 'procedures', entityId: id, patientId: pr.patient_id, description: `Updated procedure ${pr.procedure_number}`, oldValue: pr, newValue: b });
    await writeActivity({ userId: req.user.id, activityType: 'PROCEDURE', title: `Procedure updated ${pr.procedure_number}`, patientId: pr.patient_id });
    const [rows] = await pool.execute(`SELECT * FROM procedures WHERE id = ?`, [id]);
    return ok(res, { procedure: rows[0] }, 'Procedure updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update procedure', 500, err);
  }
});

/* ───────────────────────────── Vitals (doctor-facing) ───────────────────────────── */

router.get('/vitals', authenticate(true), requirePermission('encounters.view', 'nursing.vitals', 'clinical.view_results'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('v.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.encounter_id) {
      where.push('v.encounter_id = ?');
      params.push(parseInt(req.query.encounter_id, 10));
    }
    if (req.query.admission_id) {
      where.push('v.admission_id = ?');
      params.push(parseInt(req.query.admission_id, 10));
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(`SELECT COUNT(*) AS c FROM vital_signs v WHERE ${whereSql}`, params);
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT v.*, p.full_name AS patient_name
       FROM vital_signs v JOIN patients p ON p.id = v.patient_id
       WHERE ${whereSql}
       ORDER BY v.recorded_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list vitals', 500, err);
  }
});

router.get('/vitals/:id', authenticate(true), requirePermission('encounters.view', 'nursing.vitals', 'clinical.view_results'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM vital_signs WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'Vital signs record not found', 404);
    return ok(res, { vital: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load vitals', 500, err);
  }
});

router.post('/vitals', authenticate(true), requirePermission('nursing.vitals', 'encounters.manage', 'clinical.notes'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    if (!patientId) return fail(res, 'patient_id is required', 400);
    const pool = getPool();
    const [ins] = await pool.execute(
      `INSERT INTO vital_signs
       (patient_id, encounter_id, admission_id, temperature, pulse, respiration, systolic_bp, diastolic_bp,
        spo2, weight_kg, height_cm, pain_score, notes, recorded_at, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()), ?, ?)`,
      [
        patientId,
        b.encounter_id || null,
        b.admission_id || null,
        b.temperature ?? null,
        b.pulse ?? null,
        b.respiration ?? null,
        b.systolic_bp ?? null,
        b.diastolic_bp ?? null,
        b.spo2 ?? null,
        b.weight_kg ?? null,
        b.height_cm ?? null,
        b.pain_score ?? null,
        b.notes || null,
        b.recorded_at || null,
        b.status || 'ACTIVE',
        req.user.id
      ]
    );

    const criticalBits = [];
    if (b.temperature != null && (Number(b.temperature) >= 39.5 || Number(b.temperature) <= 35)) criticalBits.push('temperature');
    if (b.spo2 != null && Number(b.spo2) < 90) criticalBits.push('spo2');
    if (b.systolic_bp != null && (Number(b.systolic_bp) >= 180 || Number(b.systolic_bp) <= 80)) criticalBits.push('blood pressure');
    if (criticalBits.length) {
      await createAlert({
        patientId,
        alertType: 'VITALS',
        severity: 'CRITICAL',
        title: 'Critical vital signs',
        message: `Abnormal: ${criticalBits.join(', ')}`,
        relatedEntity: 'vital_signs',
        relatedId: ins.insertId,
        createdBy: req.user.id
      });
    }

    await addTimeline(null, {
      patientId,
      eventType: 'VITALS',
      eventTitle: 'Vital signs recorded',
      eventDetails: criticalBits.length ? `Critical: ${criticalBits.join(', ')}` : null,
      relatedEntity: 'vital_signs',
      relatedId: ins.insertId,
      createdBy: req.user.id
    });
    await writeAudit(req, { action: 'VITALS_CREATE', entity: 'vital_signs', entityId: ins.insertId, patientId, description: 'Recorded vital signs' });
    await writeActivity({ userId: req.user.id, activityType: 'VITALS', title: 'Vital signs recorded', patientId });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: 'vitals:created',
      data: { id: ins.insertId, patient_id: patientId, critical: criticalBits.length > 0 },
      roles: ['DOCTOR', 'STAFF_NURSE', 'HOD_NURSING'],
      globalAdmin: true
    });

    return ok(res, { id: ins.insertId }, 'Vital signs recorded', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to record vitals', 500, err);
  }
});

router.put('/vitals/:id', authenticate(true), requirePermission('nursing.vitals', 'encounters.manage', 'clinical.notes'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM vital_signs WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Vital signs record not found', 404);
    const v = existing[0];
    const b = req.body || {};
    await pool.execute(
      `UPDATE vital_signs SET
         temperature = COALESCE(?, temperature),
         pulse = COALESCE(?, pulse),
         respiration = COALESCE(?, respiration),
         systolic_bp = COALESCE(?, systolic_bp),
         diastolic_bp = COALESCE(?, diastolic_bp),
         spo2 = COALESCE(?, spo2),
         weight_kg = COALESCE(?, weight_kg),
         height_cm = COALESCE(?, height_cm),
         pain_score = COALESCE(?, pain_score),
         notes = COALESCE(?, notes),
         status = COALESCE(?, status)
       WHERE id = ?`,
      [
        b.temperature !== undefined ? b.temperature : null,
        b.pulse !== undefined ? b.pulse : null,
        b.respiration !== undefined ? b.respiration : null,
        b.systolic_bp !== undefined ? b.systolic_bp : null,
        b.diastolic_bp !== undefined ? b.diastolic_bp : null,
        b.spo2 !== undefined ? b.spo2 : null,
        b.weight_kg !== undefined ? b.weight_kg : null,
        b.height_cm !== undefined ? b.height_cm : null,
        b.pain_score !== undefined ? b.pain_score : null,
        b.notes !== undefined ? b.notes : null,
        b.status !== undefined ? b.status : null,
        id
      ]
    );
    await writeAudit(req, { action: 'VITALS_UPDATE', entity: 'vital_signs', entityId: id, patientId: v.patient_id, description: 'Updated vital signs', oldValue: v, newValue: b });
    const [rows] = await pool.execute(`SELECT * FROM vital_signs WHERE id = ?`, [id]);
    return ok(res, { vital: rows[0] }, 'Vital signs updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update vitals', 500, err);
  }
});

module.exports = router;
