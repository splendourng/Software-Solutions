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

const TRIAGE_PRIORITY = {
  RED: 'CRITICAL',
  ORANGE: 'URGENT',
  YELLOW: 'IMPORTANT',
  GREEN: 'NORMAL',
  BLUE: 'INFO'
};

router.get('/', authenticate(true), requirePermission('emergency.view'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search, sort, order } = pageParams(req.query);
    const allowedSort = new Set(['arrived_at', 'created_at', 'emergency_number', 'status', 'triage_level', 'updated_at']);
    const sortCol = allowedSort.has(sort) ? sort : 'arrived_at';
    const where = ['1=1'];
    const params = [];

    if (req.query.patient_id) {
      where.push('e.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.status) {
      where.push('e.status = ?');
      params.push(req.query.status);
    } else if (req.query.active_only === '1' || req.query.active_only === 'true') {
      where.push("e.status = 'ACTIVE'");
    }
    if (req.query.triage_level) {
      where.push('e.triage_level = ?');
      params.push(req.query.triage_level);
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(e.emergency_number LIKE ? OR p.full_name LIKE ? OR p.patient_number LIKE ? OR e.presenting_complaint LIKE ?)');
      params.push(like, like, like, like);
    }

    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM emergency_records e JOIN patients p ON p.id = e.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT e.*, p.full_name AS patient_name, p.patient_number, p.sex, p.date_of_birth, p.phone,
              s.full_name AS assigned_clinician_name
       FROM emergency_records e
       JOIN patients p ON p.id = e.patient_id
       LEFT JOIN staff s ON s.id = e.assigned_clinician_id
       WHERE ${whereSql}
       ORDER BY FIELD(e.triage_level,'RED','ORANGE','YELLOW','GREEN','BLUE'), e.${sortCol} ${order}
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list emergency records', 500, err);
  }
});

router.get('/:id', authenticate(true), requirePermission('emergency.view'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT e.*, p.full_name AS patient_name, p.patient_number, p.hospital_number,
              s.full_name AS assigned_clinician_name
       FROM emergency_records e
       JOIN patients p ON p.id = e.patient_id
       LEFT JOIN staff s ON s.id = e.assigned_clinician_id
       WHERE e.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return fail(res, 'Emergency record not found', 404);
    return ok(res, { emergency: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load emergency record', 500, err);
  }
});

router.post('/', authenticate(true), requirePermission('emergency.manage'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    if (!patientId) return fail(res, 'patient_id is required', 400);

    const erDeptId = await getDepartmentIdByCode('ER');
    const io = req.app.get('io');
    const triageLevel = (b.triage_level || 'YELLOW').toUpperCase();

    const result = await withTransaction(async (conn) => {
      const [patients] = await conn.execute(`SELECT * FROM patients WHERE id = ?`, [patientId]);
      if (!patients.length) throw Object.assign(new Error('Patient not found'), { status: 404 });

      const emergencyNumber = await generateId(conn, 'EMR');
      const [ins] = await conn.execute(
        `INSERT INTO emergency_records
         (emergency_number, patient_id, triage_level, presenting_complaint, arrival_mode,
          assigned_clinician_id, disposition, status, arrived_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', COALESCE(?, NOW()), ?, ?)`,
        [
          emergencyNumber,
          patientId,
          triageLevel,
          b.presenting_complaint || null,
          b.arrival_mode || null,
          b.assigned_clinician_id || req.user.staff_id || null,
          b.disposition || null,
          b.arrived_at || null,
          req.user.id,
          req.user.id
        ]
      );

      await conn.execute(
        `UPDATE patients SET patient_status = IF(patient_status = 'INPATIENT', patient_status, 'EMERGENCY'), updated_by = ? WHERE id = ?`,
        [req.user.id, patientId]
      );

      await addTimeline(conn, {
        patientId,
        eventType: 'EMERGENCY',
        eventTitle: `Emergency ${emergencyNumber} (${triageLevel})`,
        eventDetails: b.presenting_complaint || null,
        departmentId: erDeptId,
        relatedEntity: 'emergency_records',
        relatedId: ins.insertId,
        createdBy: req.user.id
      });

      return {
        id: ins.insertId,
        emergency_number: emergencyNumber,
        patient_id: patientId,
        triage_level: triageLevel
      };
    });

    const priority = TRIAGE_PRIORITY[triageLevel] || 'IMPORTANT';
    if (erDeptId) {
      await notifyDepartmentUsers(erDeptId, {
        patientId,
        category: 'EMERGENCY',
        priority,
        title: `Emergency arrival ${result.emergency_number}`,
        message: `${triageLevel}: ${b.presenting_complaint || 'New emergency patient'}`,
        relatedEntity: 'emergency_records',
        relatedId: result.id
      }, req.user.id);
    }

    if (['RED', 'ORANGE'].includes(triageLevel)) {
      await createAlert({
        patientId,
        alertType: 'EMERGENCY_TRIAGE',
        severity: triageLevel === 'RED' ? 'CRITICAL' : 'URGENT',
        title: `${triageLevel} triage emergency`,
        message: b.presenting_complaint || `Emergency ${result.emergency_number}`,
        relatedEntity: 'emergency_records',
        relatedId: result.id,
        createdBy: req.user.id
      });
    }

    await writeAudit(req, {
      action: 'EMERGENCY_CREATE',
      entity: 'emergency_records',
      entityId: result.id,
      patientId,
      description: `Created emergency ${result.emergency_number}`,
      newValue: result,
      severity: triageLevel === 'RED' ? 'CRITICAL' : 'IMPORTANT'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'EMERGENCY',
      title: `Emergency ${result.emergency_number}`,
      details: triageLevel,
      patientId,
      departmentId: erDeptId
    });

    broadcastAuthorized(io, {
      event: 'emergency:created',
      data: result,
      departmentIds: [erDeptId].filter(Boolean),
      roles: ['EMERGENCY_OFFICER', 'DOCTOR', 'STAFF_NURSE', 'CMD'],
      globalAdmin: true
    });

    return ok(res, result, 'Emergency record created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, err.message || 'Unable to create emergency record', err.status || 500, err);
  }
});

router.put('/:id', authenticate(true), requirePermission('emergency.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM emergency_records WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Emergency record not found', 404);
    const er = existing[0];
    const b = req.body || {};
    const triageLevel = b.triage_level !== undefined ? String(b.triage_level).toUpperCase() : null;

    await pool.execute(
      `UPDATE emergency_records SET
         triage_level = COALESCE(?, triage_level),
         presenting_complaint = COALESCE(?, presenting_complaint),
         arrival_mode = COALESCE(?, arrival_mode),
         assigned_clinician_id = COALESCE(?, assigned_clinician_id),
         disposition = COALESCE(?, disposition),
         status = COALESCE(?, status),
         updated_by = ?
       WHERE id = ?`,
      [
        triageLevel,
        b.presenting_complaint !== undefined ? b.presenting_complaint : null,
        b.arrival_mode !== undefined ? b.arrival_mode : null,
        b.assigned_clinician_id !== undefined ? b.assigned_clinician_id : null,
        b.disposition !== undefined ? b.disposition : null,
        b.status !== undefined ? b.status : null,
        req.user.id,
        id
      ]
    );

    if (triageLevel && triageLevel !== er.triage_level && ['RED', 'ORANGE'].includes(triageLevel)) {
      await createAlert({
        patientId: er.patient_id,
        alertType: 'EMERGENCY_TRIAGE',
        severity: triageLevel === 'RED' ? 'CRITICAL' : 'URGENT',
        title: `Triage escalated to ${triageLevel}`,
        message: `Emergency ${er.emergency_number}`,
        relatedEntity: 'emergency_records',
        relatedId: id,
        createdBy: req.user.id
      });
    }

    await writeAudit(req, {
      action: 'EMERGENCY_UPDATE',
      entity: 'emergency_records',
      entityId: id,
      patientId: er.patient_id,
      description: `Updated emergency ${er.emergency_number}`,
      oldValue: er,
      newValue: b
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'EMERGENCY',
      title: `Emergency updated ${er.emergency_number}`,
      patientId: er.patient_id
    });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: 'emergency:updated',
      data: { id, emergency_number: er.emergency_number, triage_level: triageLevel || er.triage_level, status: b.status || er.status },
      roles: ['EMERGENCY_OFFICER', 'DOCTOR'],
      globalAdmin: true
    });

    const [rows] = await pool.execute(`SELECT * FROM emergency_records WHERE id = ?`, [id]);
    return ok(res, { emergency: rows[0] }, 'Emergency record updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update emergency record', 500, err);
  }
});

router.post('/:id/triage', authenticate(true), requirePermission('emergency.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const triageLevel = String(req.body?.triage_level || '').toUpperCase();
    if (!['RED', 'ORANGE', 'YELLOW', 'GREEN', 'BLUE'].includes(triageLevel)) {
      return fail(res, 'triage_level must be RED, ORANGE, YELLOW, GREEN or BLUE', 400);
    }
    const [existing] = await pool.execute(`SELECT * FROM emergency_records WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Emergency record not found', 404);
    const er = existing[0];

    await pool.execute(
      `UPDATE emergency_records SET triage_level = ?, presenting_complaint = COALESCE(?, presenting_complaint), updated_by = ? WHERE id = ?`,
      [triageLevel, req.body?.presenting_complaint || null, req.user.id, id]
    );

    await addTimeline(null, {
      patientId: er.patient_id,
      eventType: 'EMERGENCY_TRIAGE',
      eventTitle: `Triage set to ${triageLevel}`,
      eventDetails: req.body?.presenting_complaint || er.presenting_complaint,
      relatedEntity: 'emergency_records',
      relatedId: id,
      createdBy: req.user.id
    });

    if (['RED', 'ORANGE'].includes(triageLevel)) {
      await createAlert({
        patientId: er.patient_id,
        alertType: 'EMERGENCY_TRIAGE',
        severity: triageLevel === 'RED' ? 'CRITICAL' : 'URGENT',
        title: `${triageLevel} triage`,
        message: `Emergency ${er.emergency_number}`,
        relatedEntity: 'emergency_records',
        relatedId: id,
        createdBy: req.user.id
      });
    }

    const erDeptId = await getDepartmentIdByCode('ER');
    if (erDeptId) {
      await notifyDepartmentUsers(erDeptId, {
        patientId: er.patient_id,
        category: 'EMERGENCY',
        priority: TRIAGE_PRIORITY[triageLevel] || 'IMPORTANT',
        title: `Triage ${triageLevel}: ${er.emergency_number}`,
        message: req.body?.presenting_complaint || er.presenting_complaint,
        relatedEntity: 'emergency_records',
        relatedId: id
      }, req.user.id);
    }

    await writeAudit(req, {
      action: 'EMERGENCY_TRIAGE',
      entity: 'emergency_records',
      entityId: id,
      patientId: er.patient_id,
      description: `Triage ${er.emergency_number} → ${triageLevel}`,
      severity: triageLevel === 'RED' ? 'CRITICAL' : 'IMPORTANT'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'EMERGENCY',
      title: `Triage ${triageLevel} ${er.emergency_number}`,
      patientId: er.patient_id,
      departmentId: erDeptId
    });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: 'emergency:triaged',
      data: { id, triage_level: triageLevel, emergency_number: er.emergency_number, patient_id: er.patient_id },
      departmentIds: [erDeptId].filter(Boolean),
      roles: ['EMERGENCY_OFFICER', 'DOCTOR', 'STAFF_NURSE'],
      globalAdmin: true
    });

    return ok(res, { id, triage_level: triageLevel }, 'Triage updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update triage', 500, err);
  }
});

router.post('/:id/assign', authenticate(true), requirePermission('emergency.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const clinicianId = parseInt(req.body?.assigned_clinician_id, 10);
    if (!clinicianId) return fail(res, 'assigned_clinician_id is required', 400);

    const [existing] = await pool.execute(`SELECT * FROM emergency_records WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Emergency record not found', 404);
    const er = existing[0];

    await pool.execute(
      `UPDATE emergency_records SET assigned_clinician_id = ?, updated_by = ? WHERE id = ?`,
      [clinicianId, req.user.id, id]
    );

    const [users] = await pool.execute(`SELECT id FROM users WHERE staff_id = ? AND status = 'ACTIVE' LIMIT 1`, [clinicianId]);
    if (users.length) {
      await createNotification({
        userId: users[0].id,
        patientId: er.patient_id,
        category: 'EMERGENCY',
        priority: TRIAGE_PRIORITY[er.triage_level] || 'IMPORTANT',
        title: `Assigned to emergency ${er.emergency_number}`,
        message: er.presenting_complaint || null,
        relatedEntity: 'emergency_records',
        relatedId: id
      });
    }

    await addTimeline(null, {
      patientId: er.patient_id,
      eventType: 'EMERGENCY',
      eventTitle: `Clinician assigned for ${er.emergency_number}`,
      relatedEntity: 'emergency_records',
      relatedId: id,
      createdBy: req.user.id
    });
    await writeAudit(req, {
      action: 'EMERGENCY_ASSIGN',
      entity: 'emergency_records',
      entityId: id,
      patientId: er.patient_id,
      description: `Assigned clinician ${clinicianId} to ${er.emergency_number}`
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'EMERGENCY',
      title: `Clinician assigned ${er.emergency_number}`,
      patientId: er.patient_id
    });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: 'emergency:assigned',
      data: { id, assigned_clinician_id: clinicianId, emergency_number: er.emergency_number },
      userIds: users.map(u => u.id),
      roles: ['EMERGENCY_OFFICER', 'DOCTOR'],
      globalAdmin: true
    });

    return ok(res, { id, assigned_clinician_id: clinicianId }, 'Clinician assigned');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to assign clinician', 500, err);
  }
});

router.post('/:id/dispose', authenticate(true), requirePermission('emergency.manage'), async (req, res) => {
  try {
    const b = req.body || {};
    const disposition = b.disposition;
    if (!disposition) return fail(res, 'disposition is required', 400);

    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM emergency_records WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Emergency record not found', 404);
    const er = existing[0];
    if (er.status !== 'ACTIVE') return fail(res, 'Emergency record is not active', 400);

    const erDeptId = await getDepartmentIdByCode('ER');
    const io = req.app.get('io');

    await withTransaction(async (conn) => {
      await conn.execute(
        `UPDATE emergency_records SET
           disposition = ?, status = 'COMPLETED', updated_by = ?
         WHERE id = ?`,
        [disposition, req.user.id, id]
      );

      // Clear emergency patient status if not admitted
      const [patients] = await conn.execute(`SELECT patient_status, current_admission_id FROM patients WHERE id = ?`, [er.patient_id]);
      if (patients.length && patients[0].patient_status === 'EMERGENCY' && !patients[0].current_admission_id) {
        const nextStatus = disposition.toUpperCase().includes('ADMIT') ? 'INPATIENT' : 'OUTPATIENT';
        if (nextStatus === 'OUTPATIENT') {
          await conn.execute(
            `UPDATE patients SET patient_status = 'OUTPATIENT', updated_by = ? WHERE id = ?`,
            [req.user.id, er.patient_id]
          );
        }
      }

      await addTimeline(conn, {
        patientId: er.patient_id,
        eventType: 'EMERGENCY',
        eventTitle: `Emergency completed: ${disposition}`,
        eventDetails: er.emergency_number,
        departmentId: erDeptId,
        relatedEntity: 'emergency_records',
        relatedId: id,
        createdBy: req.user.id
      });
    });

    if (erDeptId) {
      await notifyDepartmentUsers(erDeptId, {
        patientId: er.patient_id,
        category: 'EMERGENCY',
        priority: 'NORMAL',
        title: `Emergency disposed ${er.emergency_number}`,
        message: disposition,
        relatedEntity: 'emergency_records',
        relatedId: id
      }, req.user.id);
    }

    await writeAudit(req, {
      action: 'EMERGENCY_DISPOSE',
      entity: 'emergency_records',
      entityId: id,
      patientId: er.patient_id,
      description: `Disposed ${er.emergency_number}: ${disposition}`,
      severity: 'IMPORTANT'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'EMERGENCY',
      title: `Emergency disposed ${er.emergency_number}`,
      details: disposition,
      patientId: er.patient_id,
      departmentId: erDeptId
    });

    broadcastAuthorized(io, {
      event: 'emergency:disposed',
      data: { id, disposition, emergency_number: er.emergency_number, patient_id: er.patient_id },
      departmentIds: [erDeptId].filter(Boolean),
      roles: ['EMERGENCY_OFFICER', 'DOCTOR', 'STAFF_NURSE'],
      globalAdmin: true
    });

    return ok(res, { id, status: 'COMPLETED', disposition }, 'Emergency disposed');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to dispose emergency record', 500, err);
  }
});

module.exports = router;
