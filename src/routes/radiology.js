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

async function resolveStaffUserId(staffId) {
  if (!staffId) return null;
  const pool = getPool();
  const [rows] = await pool.execute(`SELECT id FROM users WHERE staff_id = ? AND status = 'ACTIVE' LIMIT 1`, [staffId]);
  return rows[0]?.id || null;
}

/* ───────────────────────────── Imaging requests ───────────────────────────── */

router.get('/requests', authenticate(true), requirePermission('radiology.view', 'clinical.order_rad', 'clinical.view_results'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search, sort, order } = pageParams(req.query);
    const allowedSort = new Set(['created_at', 'request_number', 'status', 'priority', 'scheduled_at', 'updated_at']);
    const sortCol = allowedSort.has(sort) ? sort : 'created_at';
    const where = ['1=1'];
    const params = [];

    if (req.query.patient_id) {
      where.push('rr.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.status) {
      where.push('rr.status = ?');
      params.push(req.query.status);
    }
    if (req.query.modality) {
      where.push('rr.modality = ?');
      params.push(req.query.modality);
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(rr.request_number LIKE ? OR p.full_name LIKE ? OR rr.modality LIKE ? OR rr.body_part LIKE ? OR rr.clinical_indication LIKE ?)');
      params.push(like, like, like, like, like);
    }

    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM radiology_requests rr JOIN patients p ON p.id = rr.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT rr.*, p.full_name AS patient_name, p.patient_number, s.full_name AS requested_by_name
       FROM radiology_requests rr
       JOIN patients p ON p.id = rr.patient_id
       LEFT JOIN staff s ON s.id = rr.requested_by
       WHERE ${whereSql}
       ORDER BY rr.${sortCol} ${order}
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list radiology requests', 500, err);
  }
});

router.get('/requests/:id', authenticate(true), requirePermission('radiology.view', 'clinical.order_rad', 'clinical.view_results'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT rr.*, p.full_name AS patient_name, p.patient_number
       FROM radiology_requests rr JOIN patients p ON p.id = rr.patient_id
       WHERE rr.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return fail(res, 'Radiology request not found', 404);
    const [results] = await pool.execute(`SELECT * FROM radiology_results WHERE request_id = ? ORDER BY id DESC`, [req.params.id]);
    return ok(res, { request: rows[0], results });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load radiology request', 500, err);
  }
});

router.post('/requests', authenticate(true), requirePermission('clinical.order_rad'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    if (!patientId || !b.modality) return fail(res, 'patient_id and modality are required', 400);

    const radDeptId = await getDepartmentIdByCode('RAD');
    const io = req.app.get('io');

    const result = await withTransaction(async (conn) => {
      const requestNumber = await generateId(conn, 'RAD');
      const [ins] = await conn.execute(
        `INSERT INTO radiology_requests
         (request_number, patient_id, encounter_id, admission_id, requested_by, modality, body_part,
          clinical_indication, priority, scheduled_at, status, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
        [
          requestNumber,
          patientId,
          b.encounter_id || null,
          b.admission_id || null,
          b.requested_by || req.user.staff_id || null,
          b.modality,
          b.body_part || null,
          b.clinical_indication || null,
          b.priority || 'NORMAL',
          b.scheduled_at || null,
          req.user.id,
          req.user.id
        ]
      );

      await addTimeline(conn, {
        patientId,
        eventType: 'RAD_REQUEST',
        eventTitle: `Imaging request ${requestNumber}`,
        eventDetails: `${b.modality}${b.body_part ? ' - ' + b.body_part : ''}`,
        departmentId: radDeptId,
        relatedEntity: 'radiology_requests',
        relatedId: ins.insertId,
        createdBy: req.user.id
      });

      return { id: ins.insertId, request_number: requestNumber, patient_id: patientId, modality: b.modality };
    });

    if (radDeptId) {
      await notifyDepartmentUsers(radDeptId, {
        patientId,
        category: 'RADIOLOGY',
        priority: b.priority || 'NORMAL',
        title: `New imaging request ${result.request_number}`,
        message: `${b.modality}${b.body_part ? ' / ' + b.body_part : ''}`,
        relatedEntity: 'radiology_requests',
        relatedId: result.id
      }, req.user.id);
    }

    await writeAudit(req, {
      action: 'RAD_REQUEST_CREATE',
      entity: 'radiology_requests',
      entityId: result.id,
      patientId,
      description: `Created radiology request ${result.request_number}`,
      newValue: result
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'RAD_REQUEST',
      title: `Imaging request ${result.request_number}`,
      patientId,
      departmentId: radDeptId
    });

    broadcastAuthorized(io, {
      event: 'radiology:request_created',
      data: result,
      departmentIds: [radDeptId].filter(Boolean),
      roles: ['RADIOGRAPHER', 'DOCTOR'],
      globalAdmin: true
    });

    return ok(res, result, 'Radiology request created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to create radiology request', 500, err);
  }
});

router.put('/requests/:id', authenticate(true), requirePermission('clinical.order_rad', 'radiology.process'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM radiology_requests WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Radiology request not found', 404);
    const rr = existing[0];
    const b = req.body || {};

    await pool.execute(
      `UPDATE radiology_requests SET
         modality = COALESCE(?, modality),
         body_part = COALESCE(?, body_part),
         clinical_indication = COALESCE(?, clinical_indication),
         priority = COALESCE(?, priority),
         scheduled_at = COALESCE(?, scheduled_at),
         status = COALESCE(?, status),
         updated_by = ?
       WHERE id = ?`,
      [
        b.modality !== undefined ? b.modality : null,
        b.body_part !== undefined ? b.body_part : null,
        b.clinical_indication !== undefined ? b.clinical_indication : null,
        b.priority !== undefined ? b.priority : null,
        b.scheduled_at !== undefined ? b.scheduled_at : null,
        b.status !== undefined ? b.status : null,
        req.user.id,
        id
      ]
    );

    await writeAudit(req, {
      action: 'RAD_REQUEST_UPDATE',
      entity: 'radiology_requests',
      entityId: id,
      patientId: rr.patient_id,
      description: `Updated radiology request ${rr.request_number}`,
      oldValue: rr,
      newValue: b
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'RAD_REQUEST',
      title: `Imaging request updated ${rr.request_number}`,
      patientId: rr.patient_id
    });

    const [rows] = await pool.execute(`SELECT * FROM radiology_requests WHERE id = ?`, [id]);
    return ok(res, { request: rows[0] }, 'Radiology request updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update radiology request', 500, err);
  }
});

router.post('/requests/:id/process', authenticate(true), requirePermission('radiology.process'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM radiology_requests WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Radiology request not found', 404);
    const rr = existing[0];
    const status = req.body?.status || 'PROCESSING';

    await pool.execute(
      `UPDATE radiology_requests SET status = ?, scheduled_at = COALESCE(?, scheduled_at), updated_by = ? WHERE id = ?`,
      [status, req.body?.scheduled_at || null, req.user.id, id]
    );

    await addTimeline(null, {
      patientId: rr.patient_id,
      eventType: 'RAD_PROCESS',
      eventTitle: `Imaging ${status.toLowerCase()} ${rr.request_number}`,
      relatedEntity: 'radiology_requests',
      relatedId: id,
      createdBy: req.user.id
    });
    await writeAudit(req, {
      action: 'RAD_PROCESS',
      entity: 'radiology_requests',
      entityId: id,
      patientId: rr.patient_id,
      description: `Radiology request ${rr.request_number} set to ${status}`
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'RAD_PROCESS',
      title: `Imaging processing ${rr.request_number}`,
      patientId: rr.patient_id,
      departmentId: await getDepartmentIdByCode('RAD')
    });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: 'radiology:processing',
      data: { id, status, request_number: rr.request_number, patient_id: rr.patient_id },
      roles: ['RADIOGRAPHER', 'DOCTOR'],
      globalAdmin: true
    });

    return ok(res, { id, status }, 'Radiology request processing updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to process radiology request', 500, err);
  }
});

/* ───────────────────────────── Results ───────────────────────────── */

router.get('/results', authenticate(true), requirePermission('radiology.view', 'clinical.view_results'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('r.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.request_id) {
      where.push('r.request_id = ?');
      params.push(parseInt(req.query.request_id, 10));
    }
    if (req.query.status) {
      where.push('r.status = ?');
      params.push(req.query.status);
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(p.full_name LIKE ? OR rr.request_number LIKE ? OR r.findings LIKE ? OR r.impression LIKE ?)');
      params.push(like, like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c
       FROM radiology_results r
       JOIN patients p ON p.id = r.patient_id
       JOIN radiology_requests rr ON rr.id = r.request_id
       WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT r.*, p.full_name AS patient_name, rr.request_number, rr.modality, rr.body_part
       FROM radiology_results r
       JOIN patients p ON p.id = r.patient_id
       JOIN radiology_requests rr ON rr.id = r.request_id
       WHERE ${whereSql}
       ORDER BY r.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list radiology results', 500, err);
  }
});

router.get('/results/:id', authenticate(true), requirePermission('radiology.view', 'clinical.view_results'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT r.*, rr.request_number, rr.modality, p.full_name AS patient_name
       FROM radiology_results r
       JOIN radiology_requests rr ON rr.id = r.request_id
       JOIN patients p ON p.id = r.patient_id
       WHERE r.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return fail(res, 'Radiology result not found', 404);
    return ok(res, { result: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load radiology result', 500, err);
  }
});

router.post('/results', authenticate(true), requirePermission('radiology.report'), async (req, res) => {
  try {
    const b = req.body || {};
    const requestId = parseInt(b.request_id, 10);
    if (!requestId) return fail(res, 'request_id is required', 400);

    const pool = getPool();
    const [reqs] = await pool.execute(`SELECT * FROM radiology_requests WHERE id = ?`, [requestId]);
    if (!reqs.length) return fail(res, 'Radiology request not found', 404);
    const rr = reqs[0];

    const [ins] = await pool.execute(
      `INSERT INTO radiology_results
       (request_id, patient_id, findings, impression, report_text, status, performed_by, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        requestId,
        rr.patient_id,
        b.findings || null,
        b.impression || null,
        b.report_text || null,
        b.status || 'DRAFT',
        b.performed_by || req.user.staff_id || null,
        req.user.id,
        req.user.id
      ]
    );

    if (['PENDING', 'SCHEDULED'].includes(rr.status)) {
      await pool.execute(`UPDATE radiology_requests SET status = 'PROCESSING', updated_by = ? WHERE id = ?`, [req.user.id, requestId]);
    }

    await addTimeline(null, {
      patientId: rr.patient_id,
      eventType: 'RAD_RESULT',
      eventTitle: `Imaging report drafted for ${rr.request_number}`,
      relatedEntity: 'radiology_results',
      relatedId: ins.insertId,
      createdBy: req.user.id
    });
    await writeAudit(req, {
      action: 'RAD_RESULT_CREATE',
      entity: 'radiology_results',
      entityId: ins.insertId,
      patientId: rr.patient_id,
      description: `Entered radiology report for ${rr.request_number}`
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'RAD_RESULT',
      title: `Imaging report ${rr.request_number}`,
      patientId: rr.patient_id,
      departmentId: await getDepartmentIdByCode('RAD')
    });

    return ok(res, { id: ins.insertId }, 'Radiology result created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to create radiology result', 500, err);
  }
});

router.put('/results/:id', authenticate(true), requirePermission('radiology.report'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM radiology_results WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Radiology result not found', 404);
    const result = existing[0];
    if (['RELEASED', 'VERIFIED'].includes(result.status) && !req.body?.amendment_reason) {
      return fail(res, 'Verified/released reports require amendment_reason to update', 400);
    }
    const b = req.body || {};

    await pool.execute(
      `UPDATE radiology_results SET
         findings = COALESCE(?, findings),
         impression = COALESCE(?, impression),
         report_text = COALESCE(?, report_text),
         status = COALESCE(?, status),
         previous_value = IF(?, CONCAT_WS('\\n---\\n', previous_value, report_text), previous_value),
         amendment_reason = COALESCE(?, amendment_reason),
         version = version + IF(?, 1, 0),
         updated_by = ?
       WHERE id = ?`,
      [
        b.findings !== undefined ? b.findings : null,
        b.impression !== undefined ? b.impression : null,
        b.report_text !== undefined ? b.report_text : null,
        b.status !== undefined ? b.status : null,
        b.amendment_reason ? 1 : 0,
        b.amendment_reason !== undefined ? b.amendment_reason : null,
        b.amendment_reason ? 1 : 0,
        req.user.id,
        id
      ]
    );

    await writeAudit(req, {
      action: 'RAD_RESULT_UPDATE',
      entity: 'radiology_results',
      entityId: id,
      patientId: result.patient_id,
      description: 'Updated radiology result',
      oldValue: result,
      newValue: b,
      severity: b.amendment_reason ? 'IMPORTANT' : 'INFO'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'RAD_RESULT',
      title: 'Imaging report updated',
      patientId: result.patient_id
    });

    const [rows] = await pool.execute(`SELECT * FROM radiology_results WHERE id = ?`, [id]);
    return ok(res, { result: rows[0] }, 'Radiology result updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update radiology result', 500, err);
  }
});

router.post('/results/:id/verify', authenticate(true), requirePermission('radiology.verify'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM radiology_results WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Radiology result not found', 404);
    const result = existing[0];
    if (result.status === 'RELEASED') return fail(res, 'Result already released', 400);

    const [reqs] = await pool.execute(`SELECT * FROM radiology_requests WHERE id = ?`, [result.request_id]);
    const rr = reqs[0];
    const releaseAlso = !!req.body?.release;
    const newStatus = releaseAlso ? 'RELEASED' : 'VERIFIED';

    await pool.execute(
      `UPDATE radiology_results SET
         status = ?, verified_by = ?, verified_at = NOW(),
         released_at = IF(?, NOW(), released_at),
         updated_by = ?
       WHERE id = ?`,
      [newStatus, req.user.staff_id || req.user.id, releaseAlso ? 1 : 0, req.user.id, id]
    );

    if (releaseAlso) {
      await pool.execute(`UPDATE radiology_requests SET status = 'COMPLETED', updated_by = ? WHERE id = ?`, [req.user.id, result.request_id]);
    }

    const clinicianUserId = await resolveStaffUserId(rr?.requested_by);
    const radDeptId = await getDepartmentIdByCode('RAD');
    const notifyPayload = {
      patientId: result.patient_id,
      category: 'RADIOLOGY',
      priority: 'IMPORTANT',
      title: releaseAlso
        ? `Imaging report released (${rr?.request_number || result.request_id})`
        : `Imaging report verified (${rr?.request_number || result.request_id})`,
      message: rr ? `${rr.modality}${rr.body_part ? ' / ' + rr.body_part : ''}` : 'Radiology result available',
      relatedEntity: 'radiology_results',
      relatedId: id
    };

    if (clinicianUserId) await createNotification({ ...notifyPayload, userId: clinicianUserId });
    if (radDeptId) await notifyDepartmentUsers(radDeptId, notifyPayload, req.user.id);

    if (req.body?.is_critical) {
      await createAlert({
        patientId: result.patient_id,
        alertType: 'RAD_CRITICAL',
        severity: 'CRITICAL',
        title: 'Critical imaging finding',
        message: `Critical radiology result for ${rr?.request_number || result.request_id}`,
        relatedEntity: 'radiology_results',
        relatedId: id,
        createdBy: req.user.id
      });
    }

    await addTimeline(null, {
      patientId: result.patient_id,
      eventType: releaseAlso ? 'RAD_RELEASE' : 'RAD_VERIFY',
      eventTitle: releaseAlso ? 'Imaging report released' : 'Imaging report verified',
      eventDetails: rr?.request_number || null,
      relatedEntity: 'radiology_results',
      relatedId: id,
      createdBy: req.user.id
    });
    await writeAudit(req, {
      action: releaseAlso ? 'RAD_RESULT_RELEASE' : 'RAD_RESULT_VERIFY',
      entity: 'radiology_results',
      entityId: id,
      patientId: result.patient_id,
      description: `${newStatus} imaging report for ${rr?.request_number}`,
      severity: 'IMPORTANT'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'RAD_RESULT',
      title: `Imaging report ${newStatus.toLowerCase()}`,
      patientId: result.patient_id,
      departmentId: radDeptId
    });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: releaseAlso ? 'radiology:result_released' : 'radiology:result_verified',
      data: { id, patient_id: result.patient_id, request_number: rr?.request_number },
      userIds: [clinicianUserId].filter(Boolean),
      departmentIds: [radDeptId].filter(Boolean),
      roles: ['RADIOGRAPHER', 'DOCTOR'],
      globalAdmin: true
    });

    const [rows] = await pool.execute(`SELECT * FROM radiology_results WHERE id = ?`, [id]);
    return ok(res, { result: rows[0] }, releaseAlso ? 'Report verified and released' : 'Report verified');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to verify radiology result', 500, err);
  }
});

router.post('/results/:id/release', authenticate(true), requirePermission('radiology.verify'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM radiology_results WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Radiology result not found', 404);
    const result = existing[0];
    if (result.status === 'RELEASED') return fail(res, 'Result already released', 400);

    const [reqs] = await pool.execute(`SELECT * FROM radiology_requests WHERE id = ?`, [result.request_id]);
    const rr = reqs[0];

    await pool.execute(
      `UPDATE radiology_results SET
         status = 'RELEASED',
         verified_by = COALESCE(verified_by, ?),
         verified_at = COALESCE(verified_at, NOW()),
         released_at = NOW(),
         updated_by = ?
       WHERE id = ?`,
      [req.user.staff_id || req.user.id, req.user.id, id]
    );
    await pool.execute(`UPDATE radiology_requests SET status = 'COMPLETED', updated_by = ? WHERE id = ?`, [req.user.id, result.request_id]);

    const clinicianUserId = await resolveStaffUserId(rr?.requested_by);
    const radDeptId = await getDepartmentIdByCode('RAD');
    const notifyPayload = {
      patientId: result.patient_id,
      category: 'RADIOLOGY',
      priority: 'IMPORTANT',
      title: `Imaging report released (${rr?.request_number || result.request_id})`,
      message: rr ? `${rr.modality}${rr.body_part ? ' / ' + rr.body_part : ''}` : 'Radiology result released',
      relatedEntity: 'radiology_results',
      relatedId: id
    };
    if (clinicianUserId) await createNotification({ ...notifyPayload, userId: clinicianUserId });
    if (radDeptId) await notifyDepartmentUsers(radDeptId, notifyPayload, req.user.id);

    if (req.body?.is_critical) {
      await createAlert({
        patientId: result.patient_id,
        alertType: 'RAD_CRITICAL',
        severity: 'CRITICAL',
        title: 'Critical imaging finding',
        message: `Critical radiology result for ${rr?.request_number || result.request_id}`,
        relatedEntity: 'radiology_results',
        relatedId: id,
        createdBy: req.user.id
      });
    }

    await addTimeline(null, {
      patientId: result.patient_id,
      eventType: 'RAD_RELEASE',
      eventTitle: 'Imaging report released',
      eventDetails: rr?.request_number || null,
      relatedEntity: 'radiology_results',
      relatedId: id,
      createdBy: req.user.id
    });
    await writeAudit(req, {
      action: 'RAD_RESULT_RELEASE',
      entity: 'radiology_results',
      entityId: id,
      patientId: result.patient_id,
      description: `Released imaging report for ${rr?.request_number}`,
      severity: 'IMPORTANT'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'RAD_RESULT',
      title: 'Imaging report released',
      patientId: result.patient_id,
      departmentId: radDeptId
    });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: 'radiology:result_released',
      data: { id, patient_id: result.patient_id, request_number: rr?.request_number },
      userIds: [clinicianUserId].filter(Boolean),
      departmentIds: [radDeptId].filter(Boolean),
      roles: ['RADIOGRAPHER', 'DOCTOR'],
      globalAdmin: true
    });

    const [rows] = await pool.execute(`SELECT * FROM radiology_results WHERE id = ?`, [id]);
    return ok(res, { result: rows[0] }, 'Report released');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to release radiology result', 500, err);
  }
});

module.exports = router;
