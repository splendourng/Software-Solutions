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

/* ───────────────────────────── Lab test catalog ───────────────────────────── */

router.get('/tests', authenticate(true), requirePermission('laboratory.view', 'clinical.order_lab', 'clinical.view_results'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ["status = 'ACTIVE'"];
    const params = [];
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(code LIKE ? OR name LIKE ? OR category LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(`SELECT COUNT(*) AS c FROM laboratory_tests WHERE ${whereSql}`, params);
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT * FROM laboratory_tests WHERE ${whereSql} ORDER BY name ASC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list lab tests', 500, err);
  }
});

/* ───────────────────────────── Lab requests ───────────────────────────── */

router.get('/requests', authenticate(true), requirePermission('laboratory.view', 'clinical.order_lab', 'clinical.view_results'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search, sort, order } = pageParams(req.query);
    const allowedSort = new Set(['created_at', 'request_number', 'status', 'priority', 'updated_at']);
    const sortCol = allowedSort.has(sort) ? sort : 'created_at';
    const where = ['1=1'];
    const params = [];

    if (req.query.patient_id) {
      where.push('lr.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.status) {
      where.push('lr.status = ?');
      params.push(req.query.status);
    }
    if (req.query.priority) {
      where.push('lr.priority = ?');
      params.push(req.query.priority);
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(lr.request_number LIKE ? OR p.full_name LIKE ? OR p.patient_number LIKE ? OR lr.clinical_notes LIKE ?)');
      params.push(like, like, like, like);
    }

    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM laboratory_requests lr JOIN patients p ON p.id = lr.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT lr.*, p.full_name AS patient_name, p.patient_number, s.full_name AS requested_by_name
       FROM laboratory_requests lr
       JOIN patients p ON p.id = lr.patient_id
       LEFT JOIN staff s ON s.id = lr.requested_by
       WHERE ${whereSql}
       ORDER BY FIELD(lr.priority,'CRITICAL','URGENT','IMPORTANT','NORMAL','INFO'), lr.${sortCol} ${order}
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list laboratory requests', 500, err);
  }
});

router.get('/requests/:id', authenticate(true), requirePermission('laboratory.view', 'clinical.order_lab', 'clinical.view_results'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT lr.*, p.full_name AS patient_name, p.patient_number, s.full_name AS requested_by_name
       FROM laboratory_requests lr
       JOIN patients p ON p.id = lr.patient_id
       LEFT JOIN staff s ON s.id = lr.requested_by
       WHERE lr.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return fail(res, 'Laboratory request not found', 404);
    const [items] = await pool.execute(
      `SELECT * FROM laboratory_request_items WHERE request_id = ? ORDER BY id ASC`,
      [req.params.id]
    );
    const [results] = await pool.execute(
      `SELECT * FROM laboratory_results WHERE request_id = ? ORDER BY id ASC`,
      [req.params.id]
    );
    return ok(res, { request: rows[0], items, results });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load laboratory request', 500, err);
  }
});

router.post('/requests', authenticate(true), requirePermission('clinical.order_lab'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    const items = Array.isArray(b.items) ? b.items : [];
    if (!patientId) return fail(res, 'patient_id is required', 400);
    if (!items.length) return fail(res, 'At least one test item is required', 400);

    const labDeptId = await getDepartmentIdByCode('LAB');
    const io = req.app.get('io');

    const result = await withTransaction(async (conn) => {
      const requestNumber = await generateId(conn, 'LAB');
      const [ins] = await conn.execute(
        `INSERT INTO laboratory_requests
         (request_number, patient_id, encounter_id, admission_id, requested_by, department_id,
          clinical_notes, priority, status, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
        [
          requestNumber,
          patientId,
          b.encounter_id || null,
          b.admission_id || null,
          b.requested_by || req.user.staff_id || null,
          b.department_id || req.user.primary_department?.id || null,
          b.clinical_notes || null,
          b.priority || 'NORMAL',
          req.user.id,
          req.user.id
        ]
      );
      const requestId = ins.insertId;
      const createdItems = [];

      for (const item of items) {
        let testName = item.test_name;
        let specimenType = item.specimen_type || null;
        let testId = item.test_id || null;
        if (testId && !testName) {
          const [tests] = await conn.execute(`SELECT * FROM laboratory_tests WHERE id = ?`, [testId]);
          if (tests.length) {
            testName = tests[0].name;
            specimenType = specimenType || tests[0].specimen_type;
          }
        }
        if (!testName) continue;
        const [itemIns] = await conn.execute(
          `INSERT INTO laboratory_request_items
           (request_id, test_id, test_name, specimen_type, specimen_status, status)
           VALUES (?, ?, ?, ?, 'PENDING', 'PENDING')`,
          [requestId, testId, testName, specimenType]
        );
        createdItems.push({ id: itemIns.insertId, test_name: testName });
      }

      if (!createdItems.length) throw Object.assign(new Error('No valid test items provided'), { status: 400 });

      await addTimeline(conn, {
        patientId,
        eventType: 'LAB_REQUEST',
        eventTitle: `Lab request ${requestNumber}`,
        eventDetails: createdItems.map(i => i.test_name).join(', '),
        departmentId: labDeptId || b.department_id || null,
        relatedEntity: 'laboratory_requests',
        relatedId: requestId,
        createdBy: req.user.id
      });

      return { id: requestId, request_number: requestNumber, items: createdItems, patient_id: patientId };
    });

    if (labDeptId) {
      await notifyDepartmentUsers(labDeptId, {
        patientId,
        category: 'LABORATORY',
        priority: b.priority || 'NORMAL',
        title: `New lab request ${result.request_number}`,
        message: result.items.map(i => i.test_name).join(', '),
        relatedEntity: 'laboratory_requests',
        relatedId: result.id
      }, req.user.id);
    }

    await writeAudit(req, {
      action: 'LAB_REQUEST_CREATE',
      entity: 'laboratory_requests',
      entityId: result.id,
      patientId,
      description: `Created lab request ${result.request_number}`,
      newValue: result
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'LAB_REQUEST',
      title: `Lab request ${result.request_number}`,
      patientId,
      departmentId: labDeptId
    });

    broadcastAuthorized(io, {
      event: 'lab:request_created',
      data: result,
      departmentIds: [labDeptId].filter(Boolean),
      roles: ['LAB_SCIENTIST', 'DOCTOR'],
      globalAdmin: true
    });

    return ok(res, result, 'Laboratory request created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, err.message || 'Unable to create laboratory request', err.status || 500, err);
  }
});

router.put('/requests/:id', authenticate(true), requirePermission('clinical.order_lab', 'laboratory.process'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM laboratory_requests WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Laboratory request not found', 404);
    const lr = existing[0];
    const b = req.body || {};

    // Clinicians may update notes/priority while pending; lab may update status via process endpoints preferably
    await pool.execute(
      `UPDATE laboratory_requests SET
         clinical_notes = COALESCE(?, clinical_notes),
         priority = COALESCE(?, priority),
         status = COALESCE(?, status),
         updated_by = ?
       WHERE id = ?`,
      [
        b.clinical_notes !== undefined ? b.clinical_notes : null,
        b.priority !== undefined ? b.priority : null,
        b.status !== undefined ? b.status : null,
        req.user.id,
        id
      ]
    );

    await writeAudit(req, {
      action: 'LAB_REQUEST_UPDATE',
      entity: 'laboratory_requests',
      entityId: id,
      patientId: lr.patient_id,
      description: `Updated lab request ${lr.request_number}`,
      oldValue: lr,
      newValue: b
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'LAB_REQUEST',
      title: `Lab request updated ${lr.request_number}`,
      patientId: lr.patient_id
    });

    const [rows] = await pool.execute(`SELECT * FROM laboratory_requests WHERE id = ?`, [id]);
    return ok(res, { request: rows[0] }, 'Laboratory request updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update laboratory request', 500, err);
  }
});

/* ───────────────────────────── Specimen processing ───────────────────────────── */

router.post('/requests/:id/process', authenticate(true), requirePermission('laboratory.process'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM laboratory_requests WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Laboratory request not found', 404);
    const lr = existing[0];
    if (!['PENDING', 'PROCESSING'].includes(lr.status)) {
      return fail(res, 'Request cannot be processed in its current status', 400);
    }

    const itemIds = Array.isArray(req.body?.item_ids) ? req.body.item_ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
    const specimenStatus = req.body?.specimen_status || 'COLLECTED';

    await withTransaction(async (conn) => {
      await conn.execute(
        `UPDATE laboratory_requests SET status = 'PROCESSING', updated_by = ? WHERE id = ?`,
        [req.user.id, id]
      );

      if (itemIds.length) {
        await conn.execute(
          `UPDATE laboratory_request_items SET
             specimen_status = ?, collected_at = COALESCE(collected_at, NOW()), collected_by = COALESCE(collected_by, ?), status = 'PROCESSING'
           WHERE request_id = ? AND id IN (${itemIds.map(() => '?').join(',')})`,
          [specimenStatus, req.user.staff_id || req.user.id, id, ...itemIds]
        );
      } else {
        await conn.execute(
          `UPDATE laboratory_request_items SET
             specimen_status = ?, collected_at = COALESCE(collected_at, NOW()), collected_by = COALESCE(collected_by, ?), status = 'PROCESSING'
           WHERE request_id = ? AND status IN ('PENDING','PROCESSING')`,
          [specimenStatus, req.user.staff_id || req.user.id, id]
        );
      }

      await addTimeline(conn, {
        patientId: lr.patient_id,
        eventType: 'LAB_PROCESS',
        eventTitle: `Lab specimen processing ${lr.request_number}`,
        eventDetails: specimenStatus,
        relatedEntity: 'laboratory_requests',
        relatedId: id,
        createdBy: req.user.id
      });
    });

    await writeAudit(req, {
      action: 'LAB_PROCESS',
      entity: 'laboratory_requests',
      entityId: id,
      patientId: lr.patient_id,
      description: `Processing started for ${lr.request_number}`
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'LAB_PROCESS',
      title: `Lab processing ${lr.request_number}`,
      patientId: lr.patient_id,
      departmentId: await getDepartmentIdByCode('LAB')
    });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: 'lab:processing',
      data: { id, request_number: lr.request_number, patient_id: lr.patient_id },
      roles: ['LAB_SCIENTIST', 'DOCTOR'],
      globalAdmin: true
    });

    return ok(res, { id, status: 'PROCESSING' }, 'Specimen processing started');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to process specimen', 500, err);
  }
});

router.put('/request-items/:id/specimen', authenticate(true), requirePermission('laboratory.process'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [items] = await pool.execute(`SELECT * FROM laboratory_request_items WHERE id = ?`, [id]);
    if (!items.length) return fail(res, 'Request item not found', 404);
    const item = items[0];
    const b = req.body || {};

    await pool.execute(
      `UPDATE laboratory_request_items SET
         specimen_type = COALESCE(?, specimen_type),
         specimen_status = COALESCE(?, specimen_status),
         collected_at = COALESCE(?, collected_at, NOW()),
         collected_by = COALESCE(?, collected_by),
         status = COALESCE(?, status)
       WHERE id = ?`,
      [
        b.specimen_type !== undefined ? b.specimen_type : null,
        b.specimen_status !== undefined ? b.specimen_status : null,
        b.collected_at !== undefined ? b.collected_at : null,
        b.collected_by !== undefined ? b.collected_by : (req.user.staff_id || null),
        b.status !== undefined ? b.status : null,
        id
      ]
    );

    const [reqs] = await pool.execute(`SELECT * FROM laboratory_requests WHERE id = ?`, [item.request_id]);
    const lr = reqs[0];
    if (lr && lr.status === 'PENDING') {
      await pool.execute(`UPDATE laboratory_requests SET status = 'PROCESSING', updated_by = ? WHERE id = ?`, [req.user.id, lr.id]);
    }

    await writeAudit(req, {
      action: 'LAB_SPECIMEN_UPDATE',
      entity: 'laboratory_request_items',
      entityId: id,
      patientId: lr?.patient_id || null,
      description: `Updated specimen for item ${id}`,
      newValue: b
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'LAB_SPECIMEN',
      title: `Specimen updated for ${lr?.request_number || item.request_id}`,
      patientId: lr?.patient_id || null
    });

    const [rows] = await pool.execute(`SELECT * FROM laboratory_request_items WHERE id = ?`, [id]);
    return ok(res, { item: rows[0] }, 'Specimen updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update specimen', 500, err);
  }
});

/* ───────────────────────────── Results ───────────────────────────── */

router.get('/results', authenticate(true), requirePermission('laboratory.view', 'clinical.view_results'), async (req, res) => {
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
      where.push('(p.full_name LIKE ? OR lr.request_number LIKE ? OR r.result_value LIKE ? OR r.result_text LIKE ?)');
      params.push(like, like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c
       FROM laboratory_results r
       JOIN patients p ON p.id = r.patient_id
       JOIN laboratory_requests lr ON lr.id = r.request_id
       WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT r.*, p.full_name AS patient_name, lr.request_number, lri.test_name
       FROM laboratory_results r
       JOIN patients p ON p.id = r.patient_id
       JOIN laboratory_requests lr ON lr.id = r.request_id
       JOIN laboratory_request_items lri ON lri.id = r.request_item_id
       WHERE ${whereSql}
       ORDER BY r.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list laboratory results', 500, err);
  }
});

router.get('/results/:id', authenticate(true), requirePermission('laboratory.view', 'clinical.view_results'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT r.*, lr.request_number, lri.test_name, p.full_name AS patient_name
       FROM laboratory_results r
       JOIN laboratory_requests lr ON lr.id = r.request_id
       JOIN laboratory_request_items lri ON lri.id = r.request_item_id
       JOIN patients p ON p.id = r.patient_id
       WHERE r.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return fail(res, 'Laboratory result not found', 404);
    return ok(res, { result: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load laboratory result', 500, err);
  }
});

router.post('/results', authenticate(true), requirePermission('laboratory.result'), async (req, res) => {
  try {
    const b = req.body || {};
    const requestId = parseInt(b.request_id, 10);
    const requestItemId = parseInt(b.request_item_id, 10);
    if (!requestId || !requestItemId) return fail(res, 'request_id and request_item_id are required', 400);

    const pool = getPool();
    const [reqs] = await pool.execute(`SELECT * FROM laboratory_requests WHERE id = ?`, [requestId]);
    if (!reqs.length) return fail(res, 'Laboratory request not found', 404);
    const lr = reqs[0];
    const [items] = await pool.execute(`SELECT * FROM laboratory_request_items WHERE id = ? AND request_id = ?`, [requestItemId, requestId]);
    if (!items.length) return fail(res, 'Request item not found', 404);

    const [ins] = await pool.execute(
      `INSERT INTO laboratory_results
       (request_id, request_item_id, patient_id, result_value, result_text, unit, reference_range,
        abnormal_flag, is_critical, status, performed_by, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        requestId,
        requestItemId,
        lr.patient_id,
        b.result_value || null,
        b.result_text || null,
        b.unit || null,
        b.reference_range || null,
        b.abnormal_flag || null,
        b.is_critical ? 1 : 0,
        b.status || 'DRAFT',
        b.performed_by || req.user.staff_id || null,
        req.user.id,
        req.user.id
      ]
    );

    await pool.execute(
      `UPDATE laboratory_request_items SET status = 'RESULTED' WHERE id = ?`,
      [requestItemId]
    );
    if (['PENDING', 'PROCESSING'].includes(lr.status)) {
      await pool.execute(`UPDATE laboratory_requests SET status = 'PROCESSING', updated_by = ? WHERE id = ?`, [req.user.id, requestId]);
    }

    await addTimeline(null, {
      patientId: lr.patient_id,
      eventType: 'LAB_RESULT',
      eventTitle: `Lab result entered for ${lr.request_number}`,
      eventDetails: items[0].test_name,
      relatedEntity: 'laboratory_results',
      relatedId: ins.insertId,
      createdBy: req.user.id
    });
    await writeAudit(req, {
      action: 'LAB_RESULT_CREATE',
      entity: 'laboratory_results',
      entityId: ins.insertId,
      patientId: lr.patient_id,
      description: `Entered result for ${lr.request_number}`
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'LAB_RESULT',
      title: `Lab result entered ${lr.request_number}`,
      patientId: lr.patient_id,
      departmentId: await getDepartmentIdByCode('LAB')
    });

    return ok(res, { id: ins.insertId }, 'Laboratory result entered', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to enter laboratory result', 500, err);
  }
});

router.put('/results/:id', authenticate(true), requirePermission('laboratory.result'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM laboratory_results WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Laboratory result not found', 404);
    const result = existing[0];
    if (['RELEASED', 'VERIFIED'].includes(result.status) && !req.body?.amendment_reason) {
      return fail(res, 'Verified/released results require amendment_reason to update', 400);
    }
    const b = req.body || {};

    await pool.execute(
      `UPDATE laboratory_results SET
         result_value = COALESCE(?, result_value),
         result_text = COALESCE(?, result_text),
         unit = COALESCE(?, unit),
         reference_range = COALESCE(?, reference_range),
         abnormal_flag = COALESCE(?, abnormal_flag),
         is_critical = COALESCE(?, is_critical),
         status = COALESCE(?, status),
         previous_value = IF(?, CONCAT_WS(' | ', previous_value, result_value), previous_value),
         amendment_reason = COALESCE(?, amendment_reason),
         version = version + IF(?, 1, 0),
         updated_by = ?
       WHERE id = ?`,
      [
        b.result_value !== undefined ? b.result_value : null,
        b.result_text !== undefined ? b.result_text : null,
        b.unit !== undefined ? b.unit : null,
        b.reference_range !== undefined ? b.reference_range : null,
        b.abnormal_flag !== undefined ? b.abnormal_flag : null,
        b.is_critical !== undefined ? (b.is_critical ? 1 : 0) : null,
        b.status !== undefined ? b.status : null,
        b.amendment_reason ? 1 : 0,
        b.amendment_reason !== undefined ? b.amendment_reason : null,
        b.amendment_reason ? 1 : 0,
        req.user.id,
        id
      ]
    );

    await writeAudit(req, {
      action: 'LAB_RESULT_UPDATE',
      entity: 'laboratory_results',
      entityId: id,
      patientId: result.patient_id,
      description: 'Updated laboratory result',
      oldValue: result,
      newValue: b,
      severity: b.amendment_reason ? 'IMPORTANT' : 'INFO'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'LAB_RESULT',
      title: 'Laboratory result updated',
      patientId: result.patient_id
    });

    const [rows] = await pool.execute(`SELECT * FROM laboratory_results WHERE id = ?`, [id]);
    return ok(res, { result: rows[0] }, 'Laboratory result updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update laboratory result', 500, err);
  }
});

router.post('/results/:id/verify', authenticate(true), requirePermission('laboratory.verify'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM laboratory_results WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Laboratory result not found', 404);
    const result = existing[0];
    if (result.status === 'RELEASED') return fail(res, 'Result already released', 400);

    const [reqs] = await pool.execute(`SELECT * FROM laboratory_requests WHERE id = ?`, [result.request_id]);
    const lr = reqs[0];
    const releaseAlso = !!req.body?.release;
    const newStatus = releaseAlso ? 'RELEASED' : 'VERIFIED';

    await pool.execute(
      `UPDATE laboratory_results SET
         status = ?, verified_by = ?, verified_at = NOW(),
         released_at = IF(?, NOW(), released_at),
         updated_by = ?
       WHERE id = ?`,
      [newStatus, req.user.staff_id || req.user.id, releaseAlso ? 1 : 0, req.user.id, id]
    );

    if (releaseAlso) {
      await pool.execute(`UPDATE laboratory_request_items SET status = 'COMPLETED' WHERE id = ?`, [result.request_item_id]);
      const [pending] = await pool.execute(
        `SELECT COUNT(*) AS c FROM laboratory_request_items WHERE request_id = ? AND status NOT IN ('COMPLETED','CANCELLED')`,
        [result.request_id]
      );
      if (Number(pending[0].c) === 0) {
        await pool.execute(`UPDATE laboratory_requests SET status = 'COMPLETED', updated_by = ? WHERE id = ?`, [req.user.id, result.request_id]);
      } else {
        await pool.execute(`UPDATE laboratory_requests SET status = 'PARTIAL', updated_by = ? WHERE id = ?`, [req.user.id, result.request_id]);
      }
    }

    const clinicianUserId = await resolveStaffUserId(lr?.requested_by);
    const labDeptId = await getDepartmentIdByCode('LAB');
    const notifyPayload = {
      patientId: result.patient_id,
      category: 'LABORATORY',
      priority: result.is_critical ? 'CRITICAL' : 'IMPORTANT',
      title: releaseAlso
        ? `Lab result released (${lr?.request_number || result.request_id})`
        : `Lab result verified (${lr?.request_number || result.request_id})`,
      message: result.is_critical ? 'Critical laboratory result' : 'Laboratory result available',
      relatedEntity: 'laboratory_results',
      relatedId: id
    };

    if (clinicianUserId) {
      await createNotification({ ...notifyPayload, userId: clinicianUserId });
    }
    if (lr?.department_id) {
      await notifyDepartmentUsers(lr.department_id, notifyPayload, req.user.id);
    } else if (labDeptId) {
      await notifyDepartmentUsers(labDeptId, notifyPayload, req.user.id);
    }

    if (result.is_critical || req.body?.is_critical) {
      await createAlert({
        patientId: result.patient_id,
        alertType: 'LAB_CRITICAL',
        severity: 'CRITICAL',
        title: 'Critical laboratory result',
        message: `Critical result for request ${lr?.request_number || result.request_id}`,
        relatedEntity: 'laboratory_results',
        relatedId: id,
        createdBy: req.user.id
      });
      if (clinicianUserId) {
        await createNotification({
          ...notifyPayload,
          userId: clinicianUserId,
          priority: 'CRITICAL',
          title: `CRITICAL lab result ${lr?.request_number || ''}`
        });
      }
    }

    await addTimeline(null, {
      patientId: result.patient_id,
      eventType: releaseAlso ? 'LAB_RELEASE' : 'LAB_VERIFY',
      eventTitle: releaseAlso ? `Lab result released` : `Lab result verified`,
      eventDetails: lr?.request_number || null,
      relatedEntity: 'laboratory_results',
      relatedId: id,
      createdBy: req.user.id
    });
    await writeAudit(req, {
      action: releaseAlso ? 'LAB_RESULT_RELEASE' : 'LAB_RESULT_VERIFY',
      entity: 'laboratory_results',
      entityId: id,
      patientId: result.patient_id,
      description: `${newStatus} result for ${lr?.request_number}`,
      severity: result.is_critical ? 'CRITICAL' : 'IMPORTANT'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'LAB_RESULT',
      title: `Lab result ${newStatus.toLowerCase()}`,
      patientId: result.patient_id,
      departmentId: labDeptId
    });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: releaseAlso ? 'lab:result_released' : 'lab:result_verified',
      data: { id, patient_id: result.patient_id, is_critical: !!result.is_critical, request_number: lr?.request_number },
      userIds: [clinicianUserId].filter(Boolean),
      departmentIds: [lr?.department_id, labDeptId].filter(Boolean),
      roles: ['DOCTOR', 'LAB_SCIENTIST'],
      globalAdmin: true
    });

    const [rows] = await pool.execute(`SELECT * FROM laboratory_results WHERE id = ?`, [id]);
    return ok(res, { result: rows[0] }, releaseAlso ? 'Result verified and released' : 'Result verified');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to verify laboratory result', 500, err);
  }
});

router.post('/results/:id/release', authenticate(true), requirePermission('laboratory.verify'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM laboratory_results WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Laboratory result not found', 404);
    const result = existing[0];
    if (result.status === 'RELEASED') return fail(res, 'Result already released', 400);
    if (!['VERIFIED', 'DRAFT', 'ENTERED'].includes(result.status) && result.status !== 'VERIFIED') {
      // allow VERIFIED or already verified path; also allow direct release after verify permission
    }

    const [reqs] = await pool.execute(`SELECT * FROM laboratory_requests WHERE id = ?`, [result.request_id]);
    const lr = reqs[0];

    await pool.execute(
      `UPDATE laboratory_results SET
         status = 'RELEASED',
         verified_by = COALESCE(verified_by, ?),
         verified_at = COALESCE(verified_at, NOW()),
         released_at = NOW(),
         updated_by = ?
       WHERE id = ?`,
      [req.user.staff_id || req.user.id, req.user.id, id]
    );

    await pool.execute(`UPDATE laboratory_request_items SET status = 'COMPLETED' WHERE id = ?`, [result.request_item_id]);
    const [pending] = await pool.execute(
      `SELECT COUNT(*) AS c FROM laboratory_request_items WHERE request_id = ? AND status NOT IN ('COMPLETED','CANCELLED')`,
      [result.request_id]
    );
    await pool.execute(
      `UPDATE laboratory_requests SET status = ?, updated_by = ? WHERE id = ?`,
      [Number(pending[0].c) === 0 ? 'COMPLETED' : 'PARTIAL', req.user.id, result.request_id]
    );

    const clinicianUserId = await resolveStaffUserId(lr?.requested_by);
    const labDeptId = await getDepartmentIdByCode('LAB');
    const notifyPayload = {
      patientId: result.patient_id,
      category: 'LABORATORY',
      priority: result.is_critical ? 'CRITICAL' : 'IMPORTANT',
      title: `Lab result released (${lr?.request_number || result.request_id})`,
      message: result.is_critical ? 'Critical laboratory result released' : 'Laboratory result released',
      relatedEntity: 'laboratory_results',
      relatedId: id
    };
    if (clinicianUserId) await createNotification({ ...notifyPayload, userId: clinicianUserId });
    if (lr?.department_id) await notifyDepartmentUsers(lr.department_id, notifyPayload, req.user.id);

    if (result.is_critical) {
      await createAlert({
        patientId: result.patient_id,
        alertType: 'LAB_CRITICAL',
        severity: 'CRITICAL',
        title: 'Critical laboratory result',
        message: `Critical result released for ${lr?.request_number || result.request_id}`,
        relatedEntity: 'laboratory_results',
        relatedId: id,
        createdBy: req.user.id
      });
      if (clinicianUserId) {
        await createNotification({ ...notifyPayload, userId: clinicianUserId, priority: 'CRITICAL', title: `CRITICAL lab result ${lr?.request_number || ''}` });
      }
    }

    await addTimeline(null, {
      patientId: result.patient_id,
      eventType: 'LAB_RELEASE',
      eventTitle: `Lab result released`,
      eventDetails: lr?.request_number || null,
      relatedEntity: 'laboratory_results',
      relatedId: id,
      createdBy: req.user.id
    });
    await writeAudit(req, {
      action: 'LAB_RESULT_RELEASE',
      entity: 'laboratory_results',
      entityId: id,
      patientId: result.patient_id,
      description: `Released result for ${lr?.request_number}`,
      severity: result.is_critical ? 'CRITICAL' : 'IMPORTANT'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'LAB_RESULT',
      title: 'Lab result released',
      patientId: result.patient_id,
      departmentId: labDeptId
    });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: 'lab:result_released',
      data: { id, patient_id: result.patient_id, is_critical: !!result.is_critical, request_number: lr?.request_number },
      userIds: [clinicianUserId].filter(Boolean),
      departmentIds: [lr?.department_id, labDeptId].filter(Boolean),
      roles: ['DOCTOR', 'LAB_SCIENTIST'],
      globalAdmin: true
    });

    const [rows] = await pool.execute(`SELECT * FROM laboratory_results WHERE id = ?`, [id]);
    return ok(res, { result: rows[0] }, 'Result released');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to release laboratory result', 500, err);
  }
});

module.exports = router;
