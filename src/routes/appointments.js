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

router.get('/', authenticate(true), requirePermission('appointments.view'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search, sort, order } = pageParams(req.query);
    const allowedSort = new Set(['appointment_date', 'appointment_time', 'created_at', 'appointment_number', 'status']);
    const sortCol = allowedSort.has(sort) ? sort : 'appointment_date';
    const where = ['1=1'];
    const params = [];

    if (req.query.patient_id) {
      where.push('a.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.clinician_staff_id) {
      where.push('a.clinician_staff_id = ?');
      params.push(parseInt(req.query.clinician_staff_id, 10));
    }
    if (req.query.department_id) {
      where.push('a.department_id = ?');
      params.push(parseInt(req.query.department_id, 10));
    }
    if (req.query.status) {
      where.push('a.status = ?');
      params.push(req.query.status);
    }
    if (req.query.date) {
      where.push('a.appointment_date = ?');
      params.push(req.query.date);
    } else if (req.query.from_date && req.query.to_date) {
      where.push('a.appointment_date BETWEEN ? AND ?');
      params.push(req.query.from_date, req.query.to_date);
    } else if (req.query.today === '1' || req.query.today === 'true') {
      where.push('a.appointment_date = CURDATE()');
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(a.appointment_number LIKE ? OR p.full_name LIKE ? OR p.patient_number LIKE ? OR a.reason LIKE ?)');
      params.push(like, like, like, like);
    }

    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT a.*, p.full_name AS patient_name, p.patient_number, p.phone AS patient_phone,
              s.full_name AS clinician_name, d.name AS department_name, sv.name AS service_name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       LEFT JOIN staff s ON s.id = a.clinician_staff_id
       LEFT JOIN departments d ON d.id = a.department_id
       LEFT JOIN services sv ON sv.id = a.service_id
       WHERE ${whereSql}
       ORDER BY a.${sortCol} ${order}, a.appointment_time ${order}
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list appointments', 500, err);
  }
});

router.get('/:id', authenticate(true), requirePermission('appointments.view'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT a.*, p.full_name AS patient_name, p.patient_number, s.full_name AS clinician_name, d.name AS department_name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       LEFT JOIN staff s ON s.id = a.clinician_staff_id
       LEFT JOIN departments d ON d.id = a.department_id
       WHERE a.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return fail(res, 'Appointment not found', 404);
    return ok(res, { appointment: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load appointment', 500, err);
  }
});

router.post('/', authenticate(true), requirePermission('appointments.manage'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    if (!patientId || !b.appointment_date || !b.appointment_time) {
      return fail(res, 'patient_id, appointment_date and appointment_time are required', 400);
    }

    const io = req.app.get('io');
    const result = await withTransaction(async (conn) => {
      const appointmentNumber = await generateId(conn, 'APPT');
      const departmentId = b.department_id != null
        ? parseInt(b.department_id, 10)
        : (req.user.primary_department?.id || null);
      const clinicianId = b.clinician_staff_id != null
        ? parseInt(b.clinician_staff_id, 10)
        : null;

      const [ins] = await conn.execute(
        `INSERT INTO appointments
         (appointment_number, patient_id, clinician_staff_id, department_id, service_id,
          appointment_date, appointment_time, reason, notes, status, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          appointmentNumber,
          patientId,
          clinicianId,
          departmentId,
          b.service_id || null,
          b.appointment_date,
          b.appointment_time,
          b.reason || null,
          b.notes || null,
          b.status || 'PENDING',
          req.user.id,
          req.user.id
        ]
      );

      await addTimeline(conn, {
        patientId,
        eventType: 'APPOINTMENT',
        eventTitle: `Appointment ${appointmentNumber}`,
        eventDetails: `${b.appointment_date} ${b.appointment_time}${b.reason ? ' - ' + b.reason : ''}`,
        departmentId,
        relatedEntity: 'appointments',
        relatedId: ins.insertId,
        createdBy: req.user.id
      });

      return {
        id: ins.insertId,
        appointment_number: appointmentNumber,
        patient_id: patientId,
        department_id: departmentId,
        clinician_staff_id: clinicianId,
        appointment_date: b.appointment_date,
        appointment_time: b.appointment_time
      };
    });

    if (result.department_id) {
      await notifyDepartmentUsers(result.department_id, {
        patientId,
        category: 'APPOINTMENT',
        priority: 'NORMAL',
        title: `New appointment ${result.appointment_number}`,
        message: `${result.appointment_date} ${result.appointment_time}`,
        relatedEntity: 'appointments',
        relatedId: result.id
      }, req.user.id);
    }

    if (result.clinician_staff_id) {
      const pool = getPool();
      const [users] = await pool.execute(
        `SELECT id FROM users WHERE staff_id = ? AND status = 'ACTIVE' LIMIT 1`,
        [result.clinician_staff_id]
      );
      if (users.length) {
        await createNotification({
          userId: users[0].id,
          patientId,
          category: 'APPOINTMENT',
          priority: 'NORMAL',
          title: `Appointment scheduled ${result.appointment_number}`,
          message: `${result.appointment_date} ${result.appointment_time}`,
          relatedEntity: 'appointments',
          relatedId: result.id
        });
      }
    }

    await writeAudit(req, {
      action: 'APPOINTMENT_CREATE',
      entity: 'appointments',
      entityId: result.id,
      patientId,
      description: `Created appointment ${result.appointment_number}`,
      newValue: result
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'APPOINTMENT',
      title: `Appointment ${result.appointment_number}`,
      patientId,
      departmentId: result.department_id
    });

    broadcastAuthorized(io, {
      event: 'appointment:created',
      data: result,
      departmentIds: [result.department_id].filter(Boolean),
      roles: ['DOCTOR', 'RECEPTIONIST', 'MEDICAL_RECORDS'],
      globalAdmin: true
    });

    return ok(res, result, 'Appointment created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to create appointment', 500, err);
  }
});

router.put('/:id', authenticate(true), requirePermission('appointments.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM appointments WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Appointment not found', 404);
    const appt = existing[0];
    const b = req.body || {};

    await pool.execute(
      `UPDATE appointments SET
         clinician_staff_id = COALESCE(?, clinician_staff_id),
         department_id = COALESCE(?, department_id),
         service_id = COALESCE(?, service_id),
         appointment_date = COALESCE(?, appointment_date),
         appointment_time = COALESCE(?, appointment_time),
         reason = COALESCE(?, reason),
         notes = COALESCE(?, notes),
         status = COALESCE(?, status),
         updated_by = ?
       WHERE id = ?`,
      [
        b.clinician_staff_id !== undefined ? b.clinician_staff_id : null,
        b.department_id !== undefined ? b.department_id : null,
        b.service_id !== undefined ? b.service_id : null,
        b.appointment_date !== undefined ? b.appointment_date : null,
        b.appointment_time !== undefined ? b.appointment_time : null,
        b.reason !== undefined ? b.reason : null,
        b.notes !== undefined ? b.notes : null,
        b.status !== undefined ? b.status : null,
        req.user.id,
        id
      ]
    );

    if (b.status && b.status !== appt.status) {
      await addTimeline(null, {
        patientId: appt.patient_id,
        eventType: 'APPOINTMENT',
        eventTitle: `Appointment ${appt.appointment_number} → ${b.status}`,
        relatedEntity: 'appointments',
        relatedId: id,
        departmentId: appt.department_id,
        createdBy: req.user.id
      });
    }

    await writeAudit(req, {
      action: 'APPOINTMENT_UPDATE',
      entity: 'appointments',
      entityId: id,
      patientId: appt.patient_id,
      description: `Updated appointment ${appt.appointment_number}`,
      oldValue: appt,
      newValue: b
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'APPOINTMENT',
      title: `Appointment updated ${appt.appointment_number}`,
      patientId: appt.patient_id,
      departmentId: appt.department_id
    });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: 'appointment:updated',
      data: { id, status: b.status || appt.status, appointment_number: appt.appointment_number },
      departmentIds: [appt.department_id].filter(Boolean),
      roles: ['DOCTOR', 'RECEPTIONIST'],
      globalAdmin: true
    });

    const [rows] = await pool.execute(`SELECT * FROM appointments WHERE id = ?`, [id]);
    return ok(res, { appointment: rows[0] }, 'Appointment updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update appointment', 500, err);
  }
});

router.post('/:id/cancel', authenticate(true), requirePermission('appointments.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM appointments WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Appointment not found', 404);
    const appt = existing[0];
    if (appt.status === 'CANCELLED') return fail(res, 'Appointment already cancelled', 400);

    await pool.execute(
      `UPDATE appointments SET status = 'CANCELLED', notes = CONCAT(COALESCE(notes,''), ?), updated_by = ? WHERE id = ?`,
      [req.body?.reason ? `\n[Cancelled] ${req.body.reason}` : '\n[Cancelled]', req.user.id, id]
    );

    await addTimeline(null, {
      patientId: appt.patient_id,
      eventType: 'APPOINTMENT',
      eventTitle: `Appointment ${appt.appointment_number} cancelled`,
      eventDetails: req.body?.reason || null,
      relatedEntity: 'appointments',
      relatedId: id,
      createdBy: req.user.id
    });
    await writeAudit(req, {
      action: 'APPOINTMENT_CANCEL',
      entity: 'appointments',
      entityId: id,
      patientId: appt.patient_id,
      description: `Cancelled appointment ${appt.appointment_number}`,
      severity: 'IMPORTANT'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'APPOINTMENT',
      title: `Appointment cancelled ${appt.appointment_number}`,
      patientId: appt.patient_id
    });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: 'appointment:cancelled',
      data: { id, appointment_number: appt.appointment_number, patient_id: appt.patient_id },
      departmentIds: [appt.department_id].filter(Boolean),
      roles: ['DOCTOR', 'RECEPTIONIST'],
      globalAdmin: true
    });

    return ok(res, { id, status: 'CANCELLED' }, 'Appointment cancelled');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to cancel appointment', 500, err);
  }
});

router.post('/:id/check-in', authenticate(true), requirePermission('appointments.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM appointments WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Appointment not found', 404);
    const appt = existing[0];
    if (['CANCELLED', 'COMPLETED'].includes(appt.status)) {
      return fail(res, 'Cannot check in this appointment', 400);
    }

    await pool.execute(`UPDATE appointments SET status = 'CHECKED_IN', updated_by = ? WHERE id = ?`, [req.user.id, id]);
    await addTimeline(null, {
      patientId: appt.patient_id,
      eventType: 'APPOINTMENT',
      eventTitle: `Checked in for ${appt.appointment_number}`,
      relatedEntity: 'appointments',
      relatedId: id,
      createdBy: req.user.id
    });
    await writeAudit(req, {
      action: 'APPOINTMENT_CHECKIN',
      entity: 'appointments',
      entityId: id,
      patientId: appt.patient_id,
      description: `Checked in ${appt.appointment_number}`
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'APPOINTMENT',
      title: `Checked in ${appt.appointment_number}`,
      patientId: appt.patient_id
    });

    return ok(res, { id, status: 'CHECKED_IN' }, 'Patient checked in');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to check in appointment', 500, err);
  }
});

module.exports = router;
