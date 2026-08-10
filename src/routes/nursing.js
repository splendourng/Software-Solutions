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

/* ───────────────────────────── Assessments ───────────────────────────── */

router.get('/assessments', authenticate(true), requirePermission('nursing.view', 'nursing.assess'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('a.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.admission_id) {
      where.push('a.admission_id = ?');
      params.push(parseInt(req.query.admission_id, 10));
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(a.assessment_type LIKE ? OR p.full_name LIKE ? OR a.fall_risk LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM nursing_assessments a JOIN patients p ON p.id = a.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT a.*, p.full_name AS patient_name, p.patient_number
       FROM nursing_assessments a JOIN patients p ON p.id = a.patient_id
       WHERE ${whereSql}
       ORDER BY a.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list nursing assessments', 500, err);
  }
});

router.get('/assessments/:id', authenticate(true), requirePermission('nursing.view', 'nursing.assess'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM nursing_assessments WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'Assessment not found', 404);
    return ok(res, { assessment: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load assessment', 500, err);
  }
});

router.post('/assessments', authenticate(true), requirePermission('nursing.assess'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    if (!patientId) return fail(res, 'patient_id is required', 400);
    const pool = getPool();
    const assessmentData = typeof b.assessment_data === 'object' && b.assessment_data !== null
      ? JSON.stringify(b.assessment_data)
      : (b.assessment_data || null);

    const [ins] = await pool.execute(
      `INSERT INTO nursing_assessments
       (patient_id, admission_id, assessment_type, assessment_data, fall_risk, pressure_injury_risk, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        patientId,
        b.admission_id || null,
        b.assessment_type || 'GENERAL',
        assessmentData,
        b.fall_risk || null,
        b.pressure_injury_risk || null,
        b.status || 'FINAL',
        req.user.id,
        req.user.id
      ]
    );

    if (b.fall_risk === 'HIGH' || b.pressure_injury_risk === 'HIGH') {
      await createAlert({
        patientId,
        alertType: 'NURSING_RISK',
        severity: 'IMPORTANT',
        title: 'Elevated nursing risk',
        message: `Fall risk: ${b.fall_risk || 'n/a'}; Pressure injury: ${b.pressure_injury_risk || 'n/a'}`,
        relatedEntity: 'nursing_assessments',
        relatedId: ins.insertId,
        createdBy: req.user.id
      });
    }

    await addTimeline(null, {
      patientId,
      eventType: 'NURSING_ASSESSMENT',
      eventTitle: `Nursing assessment (${b.assessment_type || 'GENERAL'})`,
      relatedEntity: 'nursing_assessments',
      relatedId: ins.insertId,
      createdBy: req.user.id
    });
    await writeAudit(req, { action: 'NURSING_ASSESSMENT_CREATE', entity: 'nursing_assessments', entityId: ins.insertId, patientId, description: 'Created nursing assessment' });
    await writeActivity({ userId: req.user.id, activityType: 'NURSING', title: 'Nursing assessment recorded', patientId, departmentId: await getDepartmentIdByCode('NURS') });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: 'nursing:assessment_created',
      data: { id: ins.insertId, patient_id: patientId },
      roles: ['STAFF_NURSE', 'HOD_NURSING', 'WARD_MANAGER'],
      globalAdmin: true
    });

    return ok(res, { id: ins.insertId }, 'Assessment created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to create assessment', 500, err);
  }
});

router.put('/assessments/:id', authenticate(true), requirePermission('nursing.assess'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM nursing_assessments WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Assessment not found', 404);
    const a = existing[0];
    const b = req.body || {};
    const assessmentData = b.assessment_data !== undefined
      ? (typeof b.assessment_data === 'object' && b.assessment_data !== null ? JSON.stringify(b.assessment_data) : b.assessment_data)
      : null;

    await pool.execute(
      `UPDATE nursing_assessments SET
         assessment_type = COALESCE(?, assessment_type),
         assessment_data = COALESCE(?, assessment_data),
         fall_risk = COALESCE(?, fall_risk),
         pressure_injury_risk = COALESCE(?, pressure_injury_risk),
         status = COALESCE(?, status),
         updated_by = ?
       WHERE id = ?`,
      [
        b.assessment_type !== undefined ? b.assessment_type : null,
        assessmentData,
        b.fall_risk !== undefined ? b.fall_risk : null,
        b.pressure_injury_risk !== undefined ? b.pressure_injury_risk : null,
        b.status !== undefined ? b.status : null,
        req.user.id,
        id
      ]
    );
    await writeAudit(req, { action: 'NURSING_ASSESSMENT_UPDATE', entity: 'nursing_assessments', entityId: id, patientId: a.patient_id, description: 'Updated nursing assessment', oldValue: a, newValue: b });
    await writeActivity({ userId: req.user.id, activityType: 'NURSING', title: 'Nursing assessment updated', patientId: a.patient_id });
    const [rows] = await pool.execute(`SELECT * FROM nursing_assessments WHERE id = ?`, [id]);
    return ok(res, { assessment: rows[0] }, 'Assessment updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update assessment', 500, err);
  }
});

/* ───────────────────────────── Nursing notes ───────────────────────────── */

router.get('/notes', authenticate(true), requirePermission('nursing.view', 'nursing.notes'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('n.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.admission_id) {
      where.push('n.admission_id = ?');
      params.push(parseInt(req.query.admission_id, 10));
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(n.note_text LIKE ? OR n.shift_label LIKE ? OR p.full_name LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM nursing_notes n JOIN patients p ON p.id = n.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT n.*, p.full_name AS patient_name, u.display_name AS author_name
       FROM nursing_notes n
       JOIN patients p ON p.id = n.patient_id
       LEFT JOIN users u ON u.id = n.created_by
       WHERE ${whereSql}
       ORDER BY n.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list nursing notes', 500, err);
  }
});

router.get('/notes/:id', authenticate(true), requirePermission('nursing.view', 'nursing.notes'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM nursing_notes WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'Nursing note not found', 404);
    return ok(res, { note: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load nursing note', 500, err);
  }
});

router.post('/notes', authenticate(true), requirePermission('nursing.notes'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    if (!patientId || !b.note_text) return fail(res, 'patient_id and note_text are required', 400);
    const pool = getPool();
    const [ins] = await pool.execute(
      `INSERT INTO nursing_notes (patient_id, admission_id, note_text, shift_label, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [patientId, b.admission_id || null, b.note_text, b.shift_label || null, b.status || 'FINAL', req.user.id, req.user.id]
    );
    await addTimeline(null, {
      patientId,
      eventType: 'NURSING_NOTE',
      eventTitle: 'Nursing note recorded',
      eventDetails: String(b.note_text).slice(0, 240),
      relatedEntity: 'nursing_notes',
      relatedId: ins.insertId,
      createdBy: req.user.id
    });
    await writeAudit(req, { action: 'NURSING_NOTE_CREATE', entity: 'nursing_notes', entityId: ins.insertId, patientId, description: 'Created nursing note' });
    await writeActivity({ userId: req.user.id, activityType: 'NURSING', title: 'Nursing note recorded', patientId });
    return ok(res, { id: ins.insertId }, 'Nursing note created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to create nursing note', 500, err);
  }
});

router.put('/notes/:id', authenticate(true), requirePermission('nursing.notes'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM nursing_notes WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Nursing note not found', 404);
    const note = existing[0];
    const b = req.body || {};
    await pool.execute(
      `UPDATE nursing_notes SET
         note_text = COALESCE(?, note_text),
         shift_label = COALESCE(?, shift_label),
         status = COALESCE(?, status),
         updated_by = ?
       WHERE id = ?`,
      [
        b.note_text !== undefined ? b.note_text : null,
        b.shift_label !== undefined ? b.shift_label : null,
        b.status !== undefined ? b.status : null,
        req.user.id,
        id
      ]
    );
    await writeAudit(req, { action: 'NURSING_NOTE_UPDATE', entity: 'nursing_notes', entityId: id, patientId: note.patient_id, description: 'Updated nursing note', oldValue: note, newValue: b });
    await writeActivity({ userId: req.user.id, activityType: 'NURSING', title: 'Nursing note updated', patientId: note.patient_id });
    const [rows] = await pool.execute(`SELECT * FROM nursing_notes WHERE id = ?`, [id]);
    return ok(res, { note: rows[0] }, 'Nursing note updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update nursing note', 500, err);
  }
});

/* ───────────────────────────── Care plans ───────────────────────────── */

router.get('/care-plans', authenticate(true), requirePermission('nursing.view', 'nursing.careplan'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('c.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.admission_id) {
      where.push('c.admission_id = ?');
      params.push(parseInt(req.query.admission_id, 10));
    }
    if (req.query.status) {
      where.push('c.status = ?');
      params.push(req.query.status);
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(c.nursing_diagnosis LIKE ? OR c.goals LIKE ? OR p.full_name LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM care_plans c JOIN patients p ON p.id = c.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT c.*, p.full_name AS patient_name FROM care_plans c
       JOIN patients p ON p.id = c.patient_id
       WHERE ${whereSql}
       ORDER BY c.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list care plans', 500, err);
  }
});

router.get('/care-plans/:id', authenticate(true), requirePermission('nursing.view', 'nursing.careplan'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM care_plans WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'Care plan not found', 404);
    return ok(res, { care_plan: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load care plan', 500, err);
  }
});

router.post('/care-plans', authenticate(true), requirePermission('nursing.careplan'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    if (!patientId) return fail(res, 'patient_id is required', 400);
    const pool = getPool();
    const [ins] = await pool.execute(
      `INSERT INTO care_plans
       (patient_id, admission_id, nursing_diagnosis, goals, interventions, evaluation, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        patientId,
        b.admission_id || null,
        b.nursing_diagnosis || null,
        b.goals || null,
        b.interventions || null,
        b.evaluation || null,
        b.status || 'ACTIVE',
        req.user.id,
        req.user.id
      ]
    );
    await addTimeline(null, {
      patientId,
      eventType: 'CARE_PLAN',
      eventTitle: 'Care plan created',
      eventDetails: b.nursing_diagnosis || null,
      relatedEntity: 'care_plans',
      relatedId: ins.insertId,
      createdBy: req.user.id
    });
    await writeAudit(req, { action: 'CARE_PLAN_CREATE', entity: 'care_plans', entityId: ins.insertId, patientId, description: 'Created care plan' });
    await writeActivity({ userId: req.user.id, activityType: 'NURSING', title: 'Care plan created', patientId });
    return ok(res, { id: ins.insertId }, 'Care plan created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to create care plan', 500, err);
  }
});

router.put('/care-plans/:id', authenticate(true), requirePermission('nursing.careplan'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM care_plans WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Care plan not found', 404);
    const cp = existing[0];
    const b = req.body || {};
    await pool.execute(
      `UPDATE care_plans SET
         nursing_diagnosis = COALESCE(?, nursing_diagnosis),
         goals = COALESCE(?, goals),
         interventions = COALESCE(?, interventions),
         evaluation = COALESCE(?, evaluation),
         status = COALESCE(?, status),
         updated_by = ?
       WHERE id = ?`,
      [
        b.nursing_diagnosis !== undefined ? b.nursing_diagnosis : null,
        b.goals !== undefined ? b.goals : null,
        b.interventions !== undefined ? b.interventions : null,
        b.evaluation !== undefined ? b.evaluation : null,
        b.status !== undefined ? b.status : null,
        req.user.id,
        id
      ]
    );
    await writeAudit(req, { action: 'CARE_PLAN_UPDATE', entity: 'care_plans', entityId: id, patientId: cp.patient_id, description: 'Updated care plan', oldValue: cp, newValue: b });
    await writeActivity({ userId: req.user.id, activityType: 'NURSING', title: 'Care plan updated', patientId: cp.patient_id });
    const [rows] = await pool.execute(`SELECT * FROM care_plans WHERE id = ?`, [id]);
    return ok(res, { care_plan: rows[0] }, 'Care plan updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update care plan', 500, err);
  }
});

/* ───────────────────────────── Nursing tasks ───────────────────────────── */

router.get('/tasks', authenticate(true), requirePermission('nursing.view', 'tasks.view'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('t.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.status) {
      where.push('t.status = ?');
      params.push(req.query.status);
    }
    if (req.query.ward_id) {
      where.push('t.ward_id = ?');
      params.push(parseInt(req.query.ward_id, 10));
    }
    if (req.query.assigned_to) {
      where.push('t.assigned_to = ?');
      params.push(parseInt(req.query.assigned_to, 10));
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(t.title LIKE ? OR t.description LIKE ? OR p.full_name LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM nursing_tasks t LEFT JOIN patients p ON p.id = t.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT t.*, p.full_name AS patient_name
       FROM nursing_tasks t LEFT JOIN patients p ON p.id = t.patient_id
       WHERE ${whereSql}
       ORDER BY t.due_at IS NULL, t.due_at ASC, t.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list nursing tasks', 500, err);
  }
});

router.get('/tasks/:id', authenticate(true), requirePermission('nursing.view', 'tasks.view'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM nursing_tasks WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'Nursing task not found', 404);
    return ok(res, { task: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load nursing task', 500, err);
  }
});

router.post('/tasks', authenticate(true), requirePermission('nursing.notes', 'tasks.manage'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return fail(res, 'title is required', 400);
    const patientId = b.patient_id ? parseInt(b.patient_id, 10) : null;
    const nursingDeptId = await getDepartmentIdByCode('NURS');

    const result = await withTransaction(async (conn) => {
      // Use TASK sequence for general task number if also creating a linked tasks row; nursing_tasks has no number field
      const taskNumber = await generateId(conn, 'TASK');
      const [ins] = await conn.execute(
        `INSERT INTO nursing_tasks
         (patient_id, admission_id, assigned_to, department_id, ward_id, title, description, priority, due_at, status, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
        [
          patientId,
          b.admission_id || null,
          b.assigned_to || null,
          b.department_id || nursingDeptId,
          b.ward_id || null,
          b.title,
          b.description || null,
          b.priority || 'NORMAL',
          b.due_at || null,
          req.user.id,
          req.user.id
        ]
      );

      await conn.execute(
        `INSERT INTO tasks
         (task_number, title, description, creator_user_id, assigned_user_id, department_id, patient_id,
          related_entity, related_id, priority, due_at, status, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'nursing_tasks', ?, ?, ?, 'PENDING', ?, ?)`,
        [
          taskNumber,
          b.title,
          b.description || null,
          req.user.id,
          b.assigned_user_id || null,
          b.department_id || nursingDeptId,
          patientId,
          ins.insertId,
          b.priority || 'NORMAL',
          b.due_at || null,
          req.user.id,
          req.user.id
        ]
      );

      if (patientId) {
        await addTimeline(conn, {
          patientId,
          eventType: 'NURSING_TASK',
          eventTitle: `Nursing task: ${b.title}`,
          relatedEntity: 'nursing_tasks',
          relatedId: ins.insertId,
          createdBy: req.user.id
        });
      }

      return { id: ins.insertId, task_number: taskNumber, patient_id: patientId };
    });

    if (nursingDeptId) {
      await notifyDepartmentUsers(nursingDeptId, {
        patientId,
        category: 'NURSING',
        priority: b.priority || 'NORMAL',
        title: `Nursing task: ${b.title}`,
        message: b.description || null,
        relatedEntity: 'nursing_tasks',
        relatedId: result.id
      }, req.user.id);
    }

    await writeAudit(req, { action: 'NURSING_TASK_CREATE', entity: 'nursing_tasks', entityId: result.id, patientId, description: `Created nursing task ${b.title}` });
    await writeActivity({ userId: req.user.id, activityType: 'NURSING_TASK', title: b.title, patientId, departmentId: nursingDeptId });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: 'nursing:task_created',
      data: result,
      departmentIds: [nursingDeptId].filter(Boolean),
      roles: ['STAFF_NURSE', 'HOD_NURSING'],
      globalAdmin: true
    });

    return ok(res, result, 'Nursing task created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to create nursing task', 500, err);
  }
});

router.put('/tasks/:id', authenticate(true), requirePermission('nursing.notes', 'tasks.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM nursing_tasks WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Nursing task not found', 404);
    const task = existing[0];
    const b = req.body || {};
    const completedAt = b.status === 'COMPLETED' ? new Date() : null;

    await pool.execute(
      `UPDATE nursing_tasks SET
         assigned_to = COALESCE(?, assigned_to),
         title = COALESCE(?, title),
         description = COALESCE(?, description),
         priority = COALESCE(?, priority),
         due_at = COALESCE(?, due_at),
         status = COALESCE(?, status),
         completed_at = COALESCE(?, completed_at),
         updated_by = ?
       WHERE id = ?`,
      [
        b.assigned_to !== undefined ? b.assigned_to : null,
        b.title !== undefined ? b.title : null,
        b.description !== undefined ? b.description : null,
        b.priority !== undefined ? b.priority : null,
        b.due_at !== undefined ? b.due_at : null,
        b.status !== undefined ? b.status : null,
        completedAt,
        req.user.id,
        id
      ]
    );

    if (b.status) {
      await pool.execute(
        `UPDATE tasks SET status = ?, completed_at = COALESCE(?, completed_at), updated_by = ?
         WHERE related_entity = 'nursing_tasks' AND related_id = ?`,
        [b.status, completedAt, req.user.id, id]
      );
    }

    await writeAudit(req, { action: 'NURSING_TASK_UPDATE', entity: 'nursing_tasks', entityId: id, patientId: task.patient_id, description: 'Updated nursing task', oldValue: task, newValue: b });
    await writeActivity({ userId: req.user.id, activityType: 'NURSING_TASK', title: `Task updated: ${b.title || task.title}`, patientId: task.patient_id });
    const [rows] = await pool.execute(`SELECT * FROM nursing_tasks WHERE id = ?`, [id]);
    return ok(res, { task: rows[0] }, 'Nursing task updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update nursing task', 500, err);
  }
});

/* ───────────────────────────── Intake / output ───────────────────────────── */

router.get('/intake-output', authenticate(true), requirePermission('nursing.view', 'nursing.notes'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('io.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.admission_id) {
      where.push('io.admission_id = ?');
      params.push(parseInt(req.query.admission_id, 10));
    }
    if (req.query.record_type) {
      where.push('io.record_type = ?');
      params.push(req.query.record_type);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(`SELECT COUNT(*) AS c FROM intake_output io WHERE ${whereSql}`, params);
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT io.*, p.full_name AS patient_name
       FROM intake_output io JOIN patients p ON p.id = io.patient_id
       WHERE ${whereSql}
       ORDER BY io.recorded_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list intake/output', 500, err);
  }
});

router.get('/intake-output/:id', authenticate(true), requirePermission('nursing.view', 'nursing.notes'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM intake_output WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'Intake/output record not found', 404);
    return ok(res, { record: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load intake/output', 500, err);
  }
});

router.post('/intake-output', authenticate(true), requirePermission('nursing.notes'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    if (!patientId || !b.record_type || b.amount_ml == null) {
      return fail(res, 'patient_id, record_type and amount_ml are required', 400);
    }
    const pool = getPool();
    const [ins] = await pool.execute(
      `INSERT INTO intake_output
       (patient_id, admission_id, record_type, amount_ml, description, recorded_at, status, created_by)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, NOW()), ?, ?)`,
      [
        patientId,
        b.admission_id || null,
        b.record_type,
        b.amount_ml,
        b.description || null,
        b.recorded_at || null,
        b.status || 'ACTIVE',
        req.user.id
      ]
    );
    await addTimeline(null, {
      patientId,
      eventType: 'INTAKE_OUTPUT',
      eventTitle: `${b.record_type} ${b.amount_ml}ml`,
      relatedEntity: 'intake_output',
      relatedId: ins.insertId,
      createdBy: req.user.id
    });
    await writeAudit(req, { action: 'INTAKE_OUTPUT_CREATE', entity: 'intake_output', entityId: ins.insertId, patientId, description: `Recorded ${b.record_type}` });
    await writeActivity({ userId: req.user.id, activityType: 'NURSING', title: `I/O recorded: ${b.record_type}`, patientId });
    return ok(res, { id: ins.insertId }, 'Intake/output recorded', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to record intake/output', 500, err);
  }
});

router.put('/intake-output/:id', authenticate(true), requirePermission('nursing.notes'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM intake_output WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Intake/output record not found', 404);
    const rec = existing[0];
    const b = req.body || {};
    await pool.execute(
      `UPDATE intake_output SET
         record_type = COALESCE(?, record_type),
         amount_ml = COALESCE(?, amount_ml),
         description = COALESCE(?, description),
         status = COALESCE(?, status)
       WHERE id = ?`,
      [
        b.record_type !== undefined ? b.record_type : null,
        b.amount_ml !== undefined ? b.amount_ml : null,
        b.description !== undefined ? b.description : null,
        b.status !== undefined ? b.status : null,
        id
      ]
    );
    await writeAudit(req, { action: 'INTAKE_OUTPUT_UPDATE', entity: 'intake_output', entityId: id, patientId: rec.patient_id, description: 'Updated intake/output', oldValue: rec, newValue: b });
    const [rows] = await pool.execute(`SELECT * FROM intake_output WHERE id = ?`, [id]);
    return ok(res, { record: rows[0] }, 'Intake/output updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update intake/output', 500, err);
  }
});

/* ───────────────────────────── MAR ───────────────────────────── */

router.get('/mar', authenticate(true), requirePermission('nursing.view', 'nursing.mar'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('m.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.admission_id) {
      where.push('m.admission_id = ?');
      params.push(parseInt(req.query.admission_id, 10));
    }
    if (req.query.status) {
      where.push('m.status = ?');
      params.push(req.query.status);
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(m.medication_name LIKE ? OR p.full_name LIKE ?)');
      params.push(like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM medication_administration m JOIN patients p ON p.id = m.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT m.*, p.full_name AS patient_name
       FROM medication_administration m JOIN patients p ON p.id = m.patient_id
       WHERE ${whereSql}
       ORDER BY COALESCE(m.scheduled_at, m.created_at) DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list MAR records', 500, err);
  }
});

router.get('/mar/:id', authenticate(true), requirePermission('nursing.view', 'nursing.mar'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM medication_administration WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'MAR record not found', 404);
    return ok(res, { mar: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load MAR record', 500, err);
  }
});

router.post('/mar', authenticate(true), requirePermission('nursing.mar'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    if (!patientId || !b.medication_name) return fail(res, 'patient_id and medication_name are required', 400);
    const pool = getPool();
    const status = b.status || (b.administered_at ? 'GIVEN' : 'PENDING');
    const [ins] = await pool.execute(
      `INSERT INTO medication_administration
       (patient_id, admission_id, prescription_item_id, medication_name, dose, route, scheduled_at,
        administered_at, administered_by, status, omission_reason, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        patientId,
        b.admission_id || null,
        b.prescription_item_id || null,
        b.medication_name,
        b.dose || null,
        b.route || null,
        b.scheduled_at || null,
        b.administered_at || (status === 'GIVEN' ? new Date() : null),
        b.administered_by || (status === 'GIVEN' ? (req.user.staff_id || null) : null),
        status,
        b.omission_reason || null,
        b.notes || null,
        req.user.id
      ]
    );
    await addTimeline(null, {
      patientId,
      eventType: 'MAR',
      eventTitle: `MAR: ${b.medication_name} (${status})`,
      relatedEntity: 'medication_administration',
      relatedId: ins.insertId,
      createdBy: req.user.id
    });
    await writeAudit(req, { action: 'MAR_CREATE', entity: 'medication_administration', entityId: ins.insertId, patientId, description: `MAR entry for ${b.medication_name}` });
    await writeActivity({ userId: req.user.id, activityType: 'MAR', title: `MAR ${b.medication_name}`, patientId });
    return ok(res, { id: ins.insertId }, 'MAR record created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to create MAR record', 500, err);
  }
});

router.put('/mar/:id', authenticate(true), requirePermission('nursing.mar'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM medication_administration WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'MAR record not found', 404);
    const mar = existing[0];
    const b = req.body || {};
    const status = b.status !== undefined ? b.status : null;
    await pool.execute(
      `UPDATE medication_administration SET
         medication_name = COALESCE(?, medication_name),
         dose = COALESCE(?, dose),
         route = COALESCE(?, route),
         scheduled_at = COALESCE(?, scheduled_at),
         administered_at = COALESCE(?, administered_at),
         administered_by = COALESCE(?, administered_by),
         status = COALESCE(?, status),
         omission_reason = COALESCE(?, omission_reason),
         notes = COALESCE(?, notes)
       WHERE id = ?`,
      [
        b.medication_name !== undefined ? b.medication_name : null,
        b.dose !== undefined ? b.dose : null,
        b.route !== undefined ? b.route : null,
        b.scheduled_at !== undefined ? b.scheduled_at : null,
        b.administered_at !== undefined ? b.administered_at : (status === 'GIVEN' ? new Date() : null),
        b.administered_by !== undefined ? b.administered_by : (status === 'GIVEN' ? (req.user.staff_id || null) : null),
        status,
        b.omission_reason !== undefined ? b.omission_reason : null,
        b.notes !== undefined ? b.notes : null,
        id
      ]
    );
    if (status === 'GIVEN' && mar.status !== 'GIVEN') {
      await addTimeline(null, {
        patientId: mar.patient_id,
        eventType: 'MAR',
        eventTitle: `Medication given: ${mar.medication_name}`,
        relatedEntity: 'medication_administration',
        relatedId: id,
        createdBy: req.user.id
      });
    }
    await writeAudit(req, { action: 'MAR_UPDATE', entity: 'medication_administration', entityId: id, patientId: mar.patient_id, description: 'Updated MAR record', oldValue: mar, newValue: b });
    await writeActivity({ userId: req.user.id, activityType: 'MAR', title: `MAR updated: ${mar.medication_name}`, patientId: mar.patient_id });
    const [rows] = await pool.execute(`SELECT * FROM medication_administration WHERE id = ?`, [id]);
    return ok(res, { mar: rows[0] }, 'MAR record updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update MAR record', 500, err);
  }
});

/* ───────────────────────────── Handovers ───────────────────────────── */

router.get('/handovers', authenticate(true), requirePermission('nursing.view', 'nursing.handover'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.ward_id) {
      where.push('h.ward_id = ?');
      params.push(parseInt(req.query.ward_id, 10));
    }
    if (req.query.unit_id) {
      where.push('h.unit_id = ?');
      params.push(parseInt(req.query.unit_id, 10));
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(`SELECT COUNT(*) AS c FROM handovers h WHERE ${whereSql}`, params);
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT h.*, w.name AS ward_name, fs.full_name AS from_staff_name, ts.full_name AS to_staff_name
       FROM handovers h
       LEFT JOIN wards w ON w.id = h.ward_id
       LEFT JOIN staff fs ON fs.id = h.from_staff_id
       LEFT JOIN staff ts ON ts.id = h.to_staff_id
       WHERE ${whereSql}
       ORDER BY h.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list handovers', 500, err);
  }
});

router.get('/handovers/:id', authenticate(true), requirePermission('nursing.view', 'nursing.handover'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM handovers WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'Handover not found', 404);
    const [patients] = await pool.execute(
      `SELECT hp.*, p.full_name AS patient_name, p.patient_number
       FROM handover_patients hp JOIN patients p ON p.id = hp.patient_id
       WHERE hp.handover_id = ?`,
      [req.params.id]
    );
    return ok(res, { handover: rows[0], patients });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load handover', 500, err);
  }
});

router.post('/handovers', authenticate(true), requirePermission('nursing.handover'), async (req, res) => {
  try {
    const b = req.body || {};
    const patients = Array.isArray(b.patients) ? b.patients : [];
    const nursingDeptId = await getDepartmentIdByCode('NURS');
    const io = req.app.get('io');

    const result = await withTransaction(async (conn) => {
      const [ins] = await conn.execute(
        `INSERT INTO handovers
         (ward_id, unit_id, from_staff_id, to_staff_id, shift_label, summary, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          b.ward_id || null,
          b.unit_id || null,
          b.from_staff_id || req.user.staff_id || null,
          b.to_staff_id || null,
          b.shift_label || null,
          b.summary || null,
          b.status || 'COMPLETED',
          req.user.id
        ]
      );
      const handoverId = ins.insertId;
      for (const p of patients) {
        const patientId = parseInt(p.patient_id, 10);
        if (!patientId) continue;
        await conn.execute(
          `INSERT INTO handover_patients
           (handover_id, patient_id, condition_summary, pending_tasks, alerts, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [handoverId, patientId, p.condition_summary || null, p.pending_tasks || null, p.alerts || null, p.notes || null]
        );
        await addTimeline(conn, {
          patientId,
          eventType: 'HANDOVER',
          eventTitle: `Shift handover${b.shift_label ? ' (' + b.shift_label + ')' : ''}`,
          eventDetails: p.condition_summary || null,
          departmentId: nursingDeptId,
          relatedEntity: 'handovers',
          relatedId: handoverId,
          createdBy: req.user.id
        });
      }
      return { id: handoverId, patient_count: patients.length };
    });

    if (nursingDeptId) {
      await notifyDepartmentUsers(nursingDeptId, {
        category: 'NURSING',
        priority: 'NORMAL',
        title: `Handover completed${b.shift_label ? ' - ' + b.shift_label : ''}`,
        message: b.summary || `${result.patient_count} patient(s) handed over`,
        relatedEntity: 'handovers',
        relatedId: result.id
      }, req.user.id);
    }

    await writeAudit(req, { action: 'HANDOVER_CREATE', entity: 'handovers', entityId: result.id, description: 'Created nursing handover', newValue: result });
    await writeActivity({ userId: req.user.id, activityType: 'HANDOVER', title: 'Nursing handover recorded', departmentId: nursingDeptId });

    broadcastAuthorized(io, {
      event: 'nursing:handover_created',
      data: result,
      departmentIds: [nursingDeptId].filter(Boolean),
      roles: ['STAFF_NURSE', 'HOD_NURSING', 'WARD_MANAGER'],
      globalAdmin: true
    });

    return ok(res, result, 'Handover created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to create handover', 500, err);
  }
});

router.put('/handovers/:id', authenticate(true), requirePermission('nursing.handover'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM handovers WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Handover not found', 404);
    const h = existing[0];
    const b = req.body || {};
    await pool.execute(
      `UPDATE handovers SET
         to_staff_id = COALESCE(?, to_staff_id),
         shift_label = COALESCE(?, shift_label),
         summary = COALESCE(?, summary),
         status = COALESCE(?, status)
       WHERE id = ?`,
      [
        b.to_staff_id !== undefined ? b.to_staff_id : null,
        b.shift_label !== undefined ? b.shift_label : null,
        b.summary !== undefined ? b.summary : null,
        b.status !== undefined ? b.status : null,
        id
      ]
    );
    await writeAudit(req, { action: 'HANDOVER_UPDATE', entity: 'handovers', entityId: id, description: 'Updated handover', oldValue: h, newValue: b });
    const [rows] = await pool.execute(`SELECT * FROM handovers WHERE id = ?`, [id]);
    return ok(res, { handover: rows[0] }, 'Handover updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update handover', 500, err);
  }
});

/* ───────────────────────────── Vitals (nursing) ───────────────────────────── */

router.get('/vitals', authenticate(true), requirePermission('nursing.view', 'nursing.vitals'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('v.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
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

router.get('/vitals/:id', authenticate(true), requirePermission('nursing.view', 'nursing.vitals'), async (req, res) => {
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

router.post('/vitals', authenticate(true), requirePermission('nursing.vitals'), async (req, res) => {
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
      const nursingDeptId = await getDepartmentIdByCode('NURS');
      if (nursingDeptId) {
        await notifyDepartmentUsers(nursingDeptId, {
          patientId,
          category: 'CLINICAL',
          priority: 'CRITICAL',
          title: 'Critical vital signs',
          message: `Abnormal: ${criticalBits.join(', ')}`,
          relatedEntity: 'vital_signs',
          relatedId: ins.insertId
        }, req.user.id);
      }
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
    await writeAudit(req, { action: 'VITALS_CREATE', entity: 'vital_signs', entityId: ins.insertId, patientId, description: 'Recorded vital signs (nursing)' });
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

router.put('/vitals/:id', authenticate(true), requirePermission('nursing.vitals'), async (req, res) => {
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
