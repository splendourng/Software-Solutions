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

/* ───────────────────────────── Admissions ───────────────────────────── */

router.get('/', authenticate(true), requirePermission('admissions.view'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search, sort, order } = pageParams(req.query);
    const allowedSort = new Set(['admitted_at', 'created_at', 'admission_number', 'status', 'updated_at']);
    const sortCol = allowedSort.has(sort) ? sort : 'admitted_at';
    const where = ['1=1'];
    const params = [];

    if (req.query.patient_id) {
      where.push('a.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.status) {
      where.push('a.status = ?');
      params.push(req.query.status);
    } else if (!req.query.include_completed) {
      // default: all statuses unless filtered
    }
    if (req.query.ward_id) {
      where.push('a.ward_id = ?');
      params.push(parseInt(req.query.ward_id, 10));
    }
    if (req.query.department_id) {
      where.push('a.department_id = ?');
      params.push(parseInt(req.query.department_id, 10));
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(a.admission_number LIKE ? OR p.full_name LIKE ? OR p.patient_number LIKE ? OR a.diagnosis_on_admission LIKE ?)');
      params.push(like, like, like, like);
    }

    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM admissions a JOIN patients p ON p.id = a.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT a.*, p.full_name AS patient_name, p.patient_number, p.hospital_number, p.sex, p.date_of_birth,
              w.name AS ward_name, u.name AS unit_name, r.name AS room_name, b.label AS bed_label,
              d.name AS department_name, s.full_name AS admitting_doctor_name
       FROM admissions a
       JOIN patients p ON p.id = a.patient_id
       LEFT JOIN wards w ON w.id = a.ward_id
       LEFT JOIN units u ON u.id = a.unit_id
       LEFT JOIN rooms r ON r.id = a.room_id
       LEFT JOIN beds b ON b.id = a.bed_id
       LEFT JOIN departments d ON d.id = a.department_id
       LEFT JOIN staff s ON s.id = a.admitting_doctor_id
       WHERE ${whereSql}
       ORDER BY a.${sortCol} ${order}
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list admissions', 500, err);
  }
});

router.get('/:id(\\d+)', authenticate(true), requirePermission('admissions.view'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT a.*, p.full_name AS patient_name, p.patient_number, p.hospital_number,
              w.name AS ward_name, b.label AS bed_label, d.name AS department_name
       FROM admissions a
       JOIN patients p ON p.id = a.patient_id
       LEFT JOIN wards w ON w.id = a.ward_id
       LEFT JOIN beds b ON b.id = a.bed_id
       LEFT JOIN departments d ON d.id = a.department_id
       WHERE a.id = ? LIMIT 1`,
      [req.params.id]
    );
    if (!rows.length) return fail(res, 'Admission not found', 404);
    return ok(res, { admission: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load admission', 500, err);
  }
});

router.post('/', authenticate(true), requirePermission('admissions.manage'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    const bedId = parseInt(b.bed_id, 10);
    if (!patientId) return fail(res, 'patient_id is required', 400);
    if (!bedId) return fail(res, 'bed_id is required for admission', 400);

    const nursingDeptId = await getDepartmentIdByCode('NURS');
    const io = req.app.get('io');

    const result = await withTransaction(async (conn) => {
      const [patients] = await conn.execute(`SELECT * FROM patients WHERE id = ? FOR UPDATE`, [patientId]);
      if (!patients.length) throw Object.assign(new Error('Patient not found'), { status: 404 });
      const patient = patients[0];
      if (patient.status !== 'ACTIVE') throw Object.assign(new Error('Patient is not active'), { status: 400 });
      if (patient.patient_status === 'INPATIENT' && patient.current_admission_id) {
        throw Object.assign(new Error('Patient already has an active admission'), { status: 400 });
      }

      const [beds] = await conn.execute(`SELECT * FROM beds WHERE id = ? FOR UPDATE`, [bedId]);
      if (!beds.length) throw Object.assign(new Error('Bed not found'), { status: 404 });
      const bed = beds[0];
      if (bed.status !== 'ACTIVE') throw Object.assign(new Error('Bed is not active'), { status: 400 });
      if (bed.bed_status !== 'AVAILABLE') throw Object.assign(new Error('Bed is not available'), { status: 400 });

      const admissionNumber = await generateId(conn, 'ADMISSION');
      const wardId = b.ward_id != null ? parseInt(b.ward_id, 10) : bed.ward_id;
      const unitId = b.unit_id != null ? parseInt(b.unit_id, 10) : bed.unit_id;
      const roomId = b.room_id != null ? parseInt(b.room_id, 10) : bed.room_id;
      const departmentId = b.department_id != null
        ? parseInt(b.department_id, 10)
        : (req.user.primary_department?.id || null);
      const admittingDoctorId = b.admitting_doctor_id != null
        ? parseInt(b.admitting_doctor_id, 10)
        : (req.user.staff_id || null);

      const [ins] = await conn.execute(
        `INSERT INTO admissions
         (admission_number, patient_id, encounter_id, admitting_doctor_id, department_id,
          ward_id, unit_id, room_id, bed_id, admission_reason, diagnosis_on_admission,
          admitted_at, status, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()), 'ACTIVE', ?, ?)`,
        [
          admissionNumber,
          patientId,
          b.encounter_id || null,
          admittingDoctorId,
          departmentId,
          wardId,
          unitId,
          roomId,
          bedId,
          b.admission_reason || null,
          b.diagnosis_on_admission || null,
          b.admitted_at || null,
          req.user.id,
          req.user.id
        ]
      );
      const admissionId = ins.insertId;

      await conn.execute(
        `UPDATE beds SET bed_status = 'OCCUPIED', current_patient_id = ?, updated_by = ? WHERE id = ?`,
        [patientId, req.user.id, bedId]
      );

      await conn.execute(
        `UPDATE patients SET
           patient_status = 'INPATIENT',
           current_admission_id = ?,
           current_ward_id = ?,
           current_bed_id = ?,
           updated_by = ?
         WHERE id = ?`,
        [admissionId, wardId, bedId, req.user.id, patientId]
      );

      await addTimeline(conn, {
        patientId,
        eventType: 'ADMISSION',
        eventTitle: `Admitted ${admissionNumber}`,
        eventDetails: b.admission_reason || b.diagnosis_on_admission || `Bed ${bed.label}`,
        departmentId: departmentId || nursingDeptId,
        relatedEntity: 'admissions',
        relatedId: admissionId,
        createdBy: req.user.id
      });

      return {
        id: admissionId,
        admission_number: admissionNumber,
        patient_id: patientId,
        bed_id: bedId,
        ward_id: wardId,
        department_id: departmentId,
        bed_label: bed.label
      };
    });

    if (nursingDeptId) {
      await notifyDepartmentUsers(nursingDeptId, {
        patientId,
        category: 'ADMISSION',
        priority: 'IMPORTANT',
        title: `New admission ${result.admission_number}`,
        message: `Patient admitted to bed ${result.bed_label || result.bed_id}`,
        relatedEntity: 'admissions',
        relatedId: result.id
      }, req.user.id);
    }

    await writeAudit(req, {
      action: 'ADMISSION_CREATE',
      entity: 'admissions',
      entityId: result.id,
      patientId,
      description: `Admitted patient ${result.admission_number}`,
      newValue: result,
      severity: 'IMPORTANT'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'ADMISSION',
      title: `Admission ${result.admission_number}`,
      details: `Bed ${result.bed_id}`,
      patientId,
      departmentId: result.department_id || nursingDeptId
    });

    broadcastAuthorized(io, {
      event: 'admission:created',
      data: result,
      departmentIds: [nursingDeptId, result.department_id].filter(Boolean),
      roles: ['STAFF_NURSE', 'HOD_NURSING', 'WARD_MANAGER', 'DOCTOR'],
      globalAdmin: true
    });

    return ok(res, result, 'Patient admitted', 201);
  } catch (err) {
    console.error(err);
    const status = err.status || 500;
    return fail(res, err.message || 'Unable to create admission', status, err);
  }
});

router.put('/:id(\\d+)', authenticate(true), requirePermission('admissions.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM admissions WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Admission not found', 404);
    const adm = existing[0];
    if (adm.status !== 'ACTIVE') return fail(res, 'Only active admissions can be updated', 400);
    const b = req.body || {};

    await pool.execute(
      `UPDATE admissions SET
         admitting_doctor_id = COALESCE(?, admitting_doctor_id),
         department_id = COALESCE(?, department_id),
         admission_reason = COALESCE(?, admission_reason),
         diagnosis_on_admission = COALESCE(?, diagnosis_on_admission),
         updated_by = ?
       WHERE id = ?`,
      [
        b.admitting_doctor_id !== undefined ? b.admitting_doctor_id : null,
        b.department_id !== undefined ? b.department_id : null,
        b.admission_reason !== undefined ? b.admission_reason : null,
        b.diagnosis_on_admission !== undefined ? b.diagnosis_on_admission : null,
        req.user.id,
        id
      ]
    );

    await writeAudit(req, {
      action: 'ADMISSION_UPDATE',
      entity: 'admissions',
      entityId: id,
      patientId: adm.patient_id,
      description: `Updated admission ${adm.admission_number}`,
      oldValue: adm,
      newValue: b
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'ADMISSION',
      title: `Admission updated ${adm.admission_number}`,
      patientId: adm.patient_id,
      departmentId: adm.department_id
    });

    const [rows] = await pool.execute(`SELECT * FROM admissions WHERE id = ?`, [id]);
    return ok(res, { admission: rows[0] }, 'Admission updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update admission', 500, err);
  }
});

/* ───────────────────────────── Bed assignment ───────────────────────────── */

router.post('/:id(\\d+)/assign-bed', authenticate(true), requirePermission('admissions.manage', 'beds.manage'), async (req, res) => {
  try {
    const admissionId = parseInt(req.params.id, 10);
    const bedId = parseInt(req.body?.bed_id, 10);
    if (!bedId) return fail(res, 'bed_id is required', 400);
    const nursingDeptId = await getDepartmentIdByCode('NURS');
    const io = req.app.get('io');

    const result = await withTransaction(async (conn) => {
      const [admissions] = await conn.execute(`SELECT * FROM admissions WHERE id = ? FOR UPDATE`, [admissionId]);
      if (!admissions.length) throw Object.assign(new Error('Admission not found'), { status: 404 });
      const adm = admissions[0];
      if (adm.status !== 'ACTIVE') throw Object.assign(new Error('Admission is not active'), { status: 400 });

      const [beds] = await conn.execute(`SELECT * FROM beds WHERE id = ? FOR UPDATE`, [bedId]);
      if (!beds.length) throw Object.assign(new Error('Bed not found'), { status: 404 });
      const bed = beds[0];
      if (bed.bed_status !== 'AVAILABLE' || bed.status !== 'ACTIVE') {
        throw Object.assign(new Error('Bed is not available'), { status: 400 });
      }

      if (adm.bed_id && adm.bed_id !== bedId) {
        await conn.execute(
          `UPDATE beds SET bed_status = 'AVAILABLE', current_patient_id = NULL, updated_by = ? WHERE id = ?`,
          [req.user.id, adm.bed_id]
        );
      }

      await conn.execute(
        `UPDATE beds SET bed_status = 'OCCUPIED', current_patient_id = ?, updated_by = ? WHERE id = ?`,
        [adm.patient_id, req.user.id, bedId]
      );

      await conn.execute(
        `UPDATE admissions SET
           bed_id = ?, ward_id = COALESCE(?, ward_id), unit_id = COALESCE(?, unit_id), room_id = COALESCE(?, room_id),
           updated_by = ?
         WHERE id = ?`,
        [bedId, bed.ward_id, bed.unit_id, bed.room_id, req.user.id, admissionId]
      );

      await conn.execute(
        `UPDATE patients SET current_ward_id = ?, current_bed_id = ?, updated_by = ? WHERE id = ?`,
        [bed.ward_id, bedId, req.user.id, adm.patient_id]
      );

      await addTimeline(conn, {
        patientId: adm.patient_id,
        eventType: 'BED_ASSIGN',
        eventTitle: `Bed assigned: ${bed.label}`,
        eventDetails: adm.admission_number,
        departmentId: nursingDeptId || adm.department_id,
        relatedEntity: 'admissions',
        relatedId: admissionId,
        createdBy: req.user.id
      });

      return {
        admission_id: admissionId,
        patient_id: adm.patient_id,
        bed_id: bedId,
        bed_label: bed.label,
        ward_id: bed.ward_id,
        admission_number: adm.admission_number
      };
    });

    if (nursingDeptId) {
      await notifyDepartmentUsers(nursingDeptId, {
        patientId: result.patient_id,
        category: 'ADMISSION',
        priority: 'NORMAL',
        title: `Bed assigned for ${result.admission_number}`,
        message: `Assigned to bed ${result.bed_label}`,
        relatedEntity: 'admissions',
        relatedId: admissionId
      }, req.user.id);
    }

    await writeAudit(req, {
      action: 'BED_ASSIGN',
      entity: 'admissions',
      entityId: admissionId,
      patientId: result.patient_id,
      description: `Assigned bed ${result.bed_label}`,
      newValue: result
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'BED_ASSIGN',
      title: `Bed assigned ${result.bed_label}`,
      patientId: result.patient_id,
      departmentId: nursingDeptId
    });

    broadcastAuthorized(io, {
      event: 'admission:bed_assigned',
      data: result,
      departmentIds: [nursingDeptId].filter(Boolean),
      roles: ['STAFF_NURSE', 'WARD_MANAGER'],
      globalAdmin: true
    });

    return ok(res, result, 'Bed assigned');
  } catch (err) {
    console.error(err);
    return fail(res, err.message || 'Unable to assign bed', err.status || 500, err);
  }
});

/* ───────────────────────────── Transfers ───────────────────────────── */

router.get('/transfers/list', authenticate(true), requirePermission('admissions.view', 'transfers.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('t.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.admission_id) {
      where.push('t.admission_id = ?');
      params.push(parseInt(req.query.admission_id, 10));
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(t.transfer_number LIKE ? OR p.full_name LIKE ? OR t.reason LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM transfers t JOIN patients p ON p.id = t.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT t.*, p.full_name AS patient_name, p.patient_number,
              fw.name AS from_ward_name, tw.name AS to_ward_name
       FROM transfers t
       JOIN patients p ON p.id = t.patient_id
       LEFT JOIN wards fw ON fw.id = t.from_ward_id
       LEFT JOIN wards tw ON tw.id = t.to_ward_id
       WHERE ${whereSql}
       ORDER BY t.transferred_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list transfers', 500, err);
  }
});

router.get('/transfers/:id', authenticate(true), requirePermission('admissions.view', 'transfers.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM transfers WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'Transfer not found', 404);
    return ok(res, { transfer: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load transfer', 500, err);
  }
});

router.post('/transfers', authenticate(true), requirePermission('transfers.manage'), async (req, res) => {
  try {
    const b = req.body || {};
    const admissionId = parseInt(b.admission_id, 10);
    const toBedId = parseInt(b.to_bed_id, 10);
    if (!admissionId || !toBedId) return fail(res, 'admission_id and to_bed_id are required', 400);

    const nursingDeptId = await getDepartmentIdByCode('NURS');
    const io = req.app.get('io');

    const result = await withTransaction(async (conn) => {
      const [admissions] = await conn.execute(`SELECT * FROM admissions WHERE id = ? FOR UPDATE`, [admissionId]);
      if (!admissions.length) throw Object.assign(new Error('Admission not found'), { status: 404 });
      const adm = admissions[0];
      if (adm.status !== 'ACTIVE') throw Object.assign(new Error('Admission is not active'), { status: 400 });

      const [toBeds] = await conn.execute(`SELECT * FROM beds WHERE id = ? FOR UPDATE`, [toBedId]);
      if (!toBeds.length) throw Object.assign(new Error('Destination bed not found'), { status: 404 });
      const toBed = toBeds[0];
      if (toBed.bed_status !== 'AVAILABLE' || toBed.status !== 'ACTIVE') {
        throw Object.assign(new Error('Destination bed is not available'), { status: 400 });
      }

      const fromBedId = adm.bed_id;
      const fromWardId = adm.ward_id;
      const fromUnitId = adm.unit_id;

      if (fromBedId) {
        await conn.execute(
          `UPDATE beds SET bed_status = 'AVAILABLE', current_patient_id = NULL, updated_by = ? WHERE id = ?`,
          [req.user.id, fromBedId]
        );
      }

      await conn.execute(
        `UPDATE beds SET bed_status = 'OCCUPIED', current_patient_id = ?, updated_by = ? WHERE id = ?`,
        [adm.patient_id, req.user.id, toBedId]
      );

      const toWardId = b.to_ward_id != null ? parseInt(b.to_ward_id, 10) : toBed.ward_id;
      const toUnitId = b.to_unit_id != null ? parseInt(b.to_unit_id, 10) : toBed.unit_id;
      const toRoomId = toBed.room_id;

      await conn.execute(
        `UPDATE admissions SET
           ward_id = ?, unit_id = ?, room_id = ?, bed_id = ?, updated_by = ?
         WHERE id = ?`,
        [toWardId, toUnitId, toRoomId, toBedId, req.user.id, admissionId]
      );

      await conn.execute(
        `UPDATE patients SET current_ward_id = ?, current_bed_id = ?, updated_by = ? WHERE id = ?`,
        [toWardId, toBedId, req.user.id, adm.patient_id]
      );

      const transferNumber = await generateId(conn, 'TRANSFER');
      const [ins] = await conn.execute(
        `INSERT INTO transfers
         (transfer_number, patient_id, admission_id, from_ward_id, to_ward_id, from_unit_id, to_unit_id,
          from_bed_id, to_bed_id, reason, transferred_at, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()), 'COMPLETED', ?)`,
        [
          transferNumber,
          adm.patient_id,
          admissionId,
          fromWardId,
          toWardId,
          fromUnitId,
          toUnitId,
          fromBedId,
          toBedId,
          b.reason || null,
          b.transferred_at || null,
          req.user.id
        ]
      );

      await addTimeline(conn, {
        patientId: adm.patient_id,
        eventType: 'TRANSFER',
        eventTitle: `Transfer ${transferNumber}`,
        eventDetails: b.reason || `Moved to bed ${toBed.label}`,
        departmentId: nursingDeptId || adm.department_id,
        relatedEntity: 'transfers',
        relatedId: ins.insertId,
        createdBy: req.user.id
      });

      return {
        id: ins.insertId,
        transfer_number: transferNumber,
        patient_id: adm.patient_id,
        admission_id: admissionId,
        from_bed_id: fromBedId,
        to_bed_id: toBedId,
        to_bed_label: toBed.label,
        to_ward_id: toWardId
      };
    });

    if (nursingDeptId) {
      await notifyDepartmentUsers(nursingDeptId, {
        patientId: result.patient_id,
        category: 'TRANSFER',
        priority: 'IMPORTANT',
        title: `Patient transferred ${result.transfer_number}`,
        message: b.reason || `Moved to bed ${result.to_bed_label}`,
        relatedEntity: 'transfers',
        relatedId: result.id
      }, req.user.id);
    }

    await writeAudit(req, {
      action: 'TRANSFER_CREATE',
      entity: 'transfers',
      entityId: result.id,
      patientId: result.patient_id,
      description: `Transfer ${result.transfer_number}`,
      newValue: result,
      severity: 'IMPORTANT'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'TRANSFER',
      title: `Transfer ${result.transfer_number}`,
      patientId: result.patient_id,
      departmentId: nursingDeptId
    });

    broadcastAuthorized(io, {
      event: 'transfer:created',
      data: result,
      departmentIds: [nursingDeptId].filter(Boolean),
      roles: ['STAFF_NURSE', 'HOD_NURSING', 'WARD_MANAGER', 'DOCTOR'],
      globalAdmin: true
    });

    return ok(res, result, 'Transfer completed', 201);
  } catch (err) {
    console.error(err);
    return fail(res, err.message || 'Unable to transfer patient', err.status || 500, err);
  }
});

/* ───────────────────────────── Discharges ───────────────────────────── */

router.get('/discharges/list', authenticate(true), requirePermission('admissions.view', 'discharges.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('d.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.admission_id) {
      where.push('d.admission_id = ?');
      params.push(parseInt(req.query.admission_id, 10));
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(d.discharge_number LIKE ? OR p.full_name LIKE ? OR d.disposition LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM discharges d JOIN patients p ON p.id = d.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT d.*, p.full_name AS patient_name, p.patient_number
       FROM discharges d JOIN patients p ON p.id = d.patient_id
       WHERE ${whereSql}
       ORDER BY d.discharged_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list discharges', 500, err);
  }
});

router.get('/discharges/:id', authenticate(true), requirePermission('admissions.view', 'discharges.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM discharges WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'Discharge not found', 404);
    return ok(res, { discharge: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load discharge', 500, err);
  }
});

router.post('/discharges', authenticate(true), requirePermission('discharges.manage'), async (req, res) => {
  try {
    const b = req.body || {};
    const admissionId = parseInt(b.admission_id, 10);
    if (!admissionId) return fail(res, 'admission_id is required', 400);

    const nursingDeptId = await getDepartmentIdByCode('NURS');
    const io = req.app.get('io');

    const result = await withTransaction(async (conn) => {
      const [admissions] = await conn.execute(`SELECT * FROM admissions WHERE id = ? FOR UPDATE`, [admissionId]);
      if (!admissions.length) throw Object.assign(new Error('Admission not found'), { status: 404 });
      const adm = admissions[0];
      if (adm.status !== 'ACTIVE') throw Object.assign(new Error('Admission is not active'), { status: 400 });

      if (adm.bed_id) {
        await conn.execute(
          `UPDATE beds SET bed_status = 'AVAILABLE', current_patient_id = NULL, updated_by = ? WHERE id = ?`,
          [req.user.id, adm.bed_id]
        );
      }

      await conn.execute(
        `UPDATE admissions SET status = 'COMPLETED', updated_by = ? WHERE id = ?`,
        [req.user.id, admissionId]
      );

      await conn.execute(
        `UPDATE patients SET
           patient_status = 'OUTPATIENT',
           current_admission_id = NULL,
           current_ward_id = NULL,
           current_bed_id = NULL,
           updated_by = ?
         WHERE id = ?`,
        [req.user.id, adm.patient_id]
      );

      const dischargeNumber = await generateId(conn, 'DISCHARGE');
      const [ins] = await conn.execute(
        `INSERT INTO discharges
         (discharge_number, patient_id, admission_id, discharged_by, discharge_type, disposition,
          summary, follow_up_instructions, discharged_at, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()), 'COMPLETED', ?)`,
        [
          dischargeNumber,
          adm.patient_id,
          admissionId,
          b.discharged_by || req.user.staff_id || null,
          b.discharge_type || null,
          b.disposition || null,
          b.summary || null,
          b.follow_up_instructions || null,
          b.discharged_at || null,
          req.user.id
        ]
      );

      let summaryId = null;
      if (b.create_summary || b.summary_text || b.diagnoses_text || b.medications_text) {
        const [sumIns] = await conn.execute(
          `INSERT INTO discharge_summaries
           (patient_id, admission_id, discharge_id, summary_text, diagnoses_text, procedures_text, medications_text, status, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            adm.patient_id,
            admissionId,
            ins.insertId,
            b.summary_text || b.summary || null,
            b.diagnoses_text || null,
            b.procedures_text || null,
            b.medications_text || null,
            b.summary_status || 'FINAL',
            req.user.id,
            req.user.id
          ]
        );
        summaryId = sumIns.insertId;
      }

      await addTimeline(conn, {
        patientId: adm.patient_id,
        eventType: 'DISCHARGE',
        eventTitle: `Discharged ${dischargeNumber}`,
        eventDetails: b.disposition || b.discharge_type || b.summary || null,
        departmentId: nursingDeptId || adm.department_id,
        relatedEntity: 'discharges',
        relatedId: ins.insertId,
        createdBy: req.user.id
      });

      return {
        id: ins.insertId,
        discharge_number: dischargeNumber,
        patient_id: adm.patient_id,
        admission_id: admissionId,
        admission_number: adm.admission_number,
        summary_id: summaryId
      };
    });

    if (nursingDeptId) {
      await notifyDepartmentUsers(nursingDeptId, {
        patientId: result.patient_id,
        category: 'DISCHARGE',
        priority: 'IMPORTANT',
        title: `Patient discharged ${result.discharge_number}`,
        message: `Admission ${result.admission_number} completed`,
        relatedEntity: 'discharges',
        relatedId: result.id
      }, req.user.id);
    }

    await writeAudit(req, {
      action: 'DISCHARGE_CREATE',
      entity: 'discharges',
      entityId: result.id,
      patientId: result.patient_id,
      description: `Discharged ${result.discharge_number}`,
      newValue: result,
      severity: 'IMPORTANT'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'DISCHARGE',
      title: `Discharge ${result.discharge_number}`,
      patientId: result.patient_id,
      departmentId: nursingDeptId
    });

    broadcastAuthorized(io, {
      event: 'discharge:created',
      data: result,
      departmentIds: [nursingDeptId].filter(Boolean),
      roles: ['STAFF_NURSE', 'HOD_NURSING', 'WARD_MANAGER', 'DOCTOR', 'MEDICAL_RECORDS'],
      globalAdmin: true
    });

    return ok(res, result, 'Patient discharged', 201);
  } catch (err) {
    console.error(err);
    return fail(res, err.message || 'Unable to discharge patient', err.status || 500, err);
  }
});

/* ───────────────────────────── Discharge summaries ───────────────────────────── */

router.get('/discharge-summaries/list', authenticate(true), requirePermission('admissions.view', 'discharges.manage', 'medical_records.view'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('ds.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.admission_id) {
      where.push('ds.admission_id = ?');
      params.push(parseInt(req.query.admission_id, 10));
    }
    if (req.query.discharge_id) {
      where.push('ds.discharge_id = ?');
      params.push(parseInt(req.query.discharge_id, 10));
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(ds.summary_text LIKE ? OR ds.diagnoses_text LIKE ? OR p.full_name LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM discharge_summaries ds JOIN patients p ON p.id = ds.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT ds.*, p.full_name AS patient_name, p.patient_number
       FROM discharge_summaries ds JOIN patients p ON p.id = ds.patient_id
       WHERE ${whereSql}
       ORDER BY ds.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list discharge summaries', 500, err);
  }
});

router.get('/discharge-summaries/:id', authenticate(true), requirePermission('admissions.view', 'discharges.manage', 'medical_records.view'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM discharge_summaries WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'Discharge summary not found', 404);
    return ok(res, { summary: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load discharge summary', 500, err);
  }
});

router.post('/discharge-summaries', authenticate(true), requirePermission('discharges.manage', 'medical_records.manage'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    if (!patientId) return fail(res, 'patient_id is required', 400);
    const pool = getPool();
    const [ins] = await pool.execute(
      `INSERT INTO discharge_summaries
       (patient_id, admission_id, discharge_id, summary_text, diagnoses_text, procedures_text, medications_text, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        patientId,
        b.admission_id || null,
        b.discharge_id || null,
        b.summary_text || null,
        b.diagnoses_text || null,
        b.procedures_text || null,
        b.medications_text || null,
        b.status || 'DRAFT',
        req.user.id,
        req.user.id
      ]
    );
    await addTimeline(null, {
      patientId,
      eventType: 'DISCHARGE_SUMMARY',
      eventTitle: 'Discharge summary created',
      relatedEntity: 'discharge_summaries',
      relatedId: ins.insertId,
      createdBy: req.user.id
    });
    await writeAudit(req, { action: 'DISCHARGE_SUMMARY_CREATE', entity: 'discharge_summaries', entityId: ins.insertId, patientId, description: 'Created discharge summary' });
    await writeActivity({ userId: req.user.id, activityType: 'DISCHARGE_SUMMARY', title: 'Discharge summary created', patientId });
    return ok(res, { id: ins.insertId }, 'Discharge summary created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to create discharge summary', 500, err);
  }
});

router.put('/discharge-summaries/:id', authenticate(true), requirePermission('discharges.manage', 'medical_records.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM discharge_summaries WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Discharge summary not found', 404);
    const ds = existing[0];
    const b = req.body || {};
    await pool.execute(
      `UPDATE discharge_summaries SET
         summary_text = COALESCE(?, summary_text),
         diagnoses_text = COALESCE(?, diagnoses_text),
         procedures_text = COALESCE(?, procedures_text),
         medications_text = COALESCE(?, medications_text),
         status = COALESCE(?, status),
         updated_by = ?
       WHERE id = ?`,
      [
        b.summary_text !== undefined ? b.summary_text : null,
        b.diagnoses_text !== undefined ? b.diagnoses_text : null,
        b.procedures_text !== undefined ? b.procedures_text : null,
        b.medications_text !== undefined ? b.medications_text : null,
        b.status !== undefined ? b.status : null,
        req.user.id,
        id
      ]
    );
    await writeAudit(req, { action: 'DISCHARGE_SUMMARY_UPDATE', entity: 'discharge_summaries', entityId: id, patientId: ds.patient_id, description: 'Updated discharge summary', oldValue: ds, newValue: b });
    await writeActivity({ userId: req.user.id, activityType: 'DISCHARGE_SUMMARY', title: 'Discharge summary updated', patientId: ds.patient_id });
    const [rows] = await pool.execute(`SELECT * FROM discharge_summaries WHERE id = ?`, [id]);
    return ok(res, { summary: rows[0] }, 'Discharge summary updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update discharge summary', 500, err);
  }
});

module.exports = router;
