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

/* ───────────────────────────── Medication catalog ───────────────────────────── */

router.get('/medications', authenticate(true), requirePermission('pharmacy.view', 'pharmacy.catalog', 'clinical.prescribe'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.status) {
      where.push('status = ?');
      params.push(req.query.status);
    } else {
      where.push("status = 'ACTIVE'");
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(code LIKE ? OR name LIKE ? OR generic_name LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(`SELECT COUNT(*) AS c FROM medications WHERE ${whereSql}`, params);
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT * FROM medications WHERE ${whereSql} ORDER BY name ASC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list medications', 500, err);
  }
});

router.get('/medications/:id', authenticate(true), requirePermission('pharmacy.view', 'pharmacy.catalog', 'clinical.prescribe'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM medications WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'Medication not found', 404);
    return ok(res, { medication: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load medication', 500, err);
  }
});

router.post('/medications', authenticate(true), requirePermission('pharmacy.catalog'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.code || !b.name) return fail(res, 'code and name are required', 400);
    const pool = getPool();
    const [ins] = await pool.execute(
      `INSERT INTO medications
       (code, name, generic_name, form, strength, unit, stock_quantity, reorder_level, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        b.code,
        b.name,
        b.generic_name || null,
        b.form || null,
        b.strength || null,
        b.unit || null,
        b.stock_quantity ?? 0,
        b.reorder_level ?? 0,
        b.status || 'ACTIVE',
        req.user.id,
        req.user.id
      ]
    );
    await writeAudit(req, { action: 'MEDICATION_CREATE', entity: 'medications', entityId: ins.insertId, description: `Created medication ${b.code}` });
    await writeActivity({ userId: req.user.id, activityType: 'PHARMACY', title: `Medication added ${b.name}`, departmentId: await getDepartmentIdByCode('PHARM') });
    return ok(res, { id: ins.insertId }, 'Medication created', 201);
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') return fail(res, 'Medication code already exists', 409, err);
    return fail(res, 'Unable to create medication', 500, err);
  }
});

router.put('/medications/:id', authenticate(true), requirePermission('pharmacy.catalog'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM medications WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Medication not found', 404);
    const med = existing[0];
    const b = req.body || {};
    await pool.execute(
      `UPDATE medications SET
         name = COALESCE(?, name),
         generic_name = COALESCE(?, generic_name),
         form = COALESCE(?, form),
         strength = COALESCE(?, strength),
         unit = COALESCE(?, unit),
         stock_quantity = COALESCE(?, stock_quantity),
         reorder_level = COALESCE(?, reorder_level),
         status = COALESCE(?, status),
         updated_by = ?
       WHERE id = ?`,
      [
        b.name !== undefined ? b.name : null,
        b.generic_name !== undefined ? b.generic_name : null,
        b.form !== undefined ? b.form : null,
        b.strength !== undefined ? b.strength : null,
        b.unit !== undefined ? b.unit : null,
        b.stock_quantity !== undefined ? b.stock_quantity : null,
        b.reorder_level !== undefined ? b.reorder_level : null,
        b.status !== undefined ? b.status : null,
        req.user.id,
        id
      ]
    );
    await writeAudit(req, { action: 'MEDICATION_UPDATE', entity: 'medications', entityId: id, description: `Updated medication ${med.code}`, oldValue: med, newValue: b });
    await writeActivity({ userId: req.user.id, activityType: 'PHARMACY', title: `Medication updated ${med.name}` });
    const [rows] = await pool.execute(`SELECT * FROM medications WHERE id = ?`, [id]);
    return ok(res, { medication: rows[0] }, 'Medication updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update medication', 500, err);
  }
});

/* ───────────────────────────── Prescriptions ───────────────────────────── */

router.get('/prescriptions', authenticate(true), requirePermission('pharmacy.view', 'clinical.prescribe', 'clinical.view_results'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search, sort, order } = pageParams(req.query);
    const allowedSort = new Set(['created_at', 'prescription_number', 'status', 'updated_at']);
    const sortCol = allowedSort.has(sort) ? sort : 'created_at';
    const where = ['1=1'];
    const params = [];
    if (req.query.patient_id) {
      where.push('rx.patient_id = ?');
      params.push(parseInt(req.query.patient_id, 10));
    }
    if (req.query.status) {
      where.push('rx.status = ?');
      params.push(req.query.status);
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(rx.prescription_number LIKE ? OR p.full_name LIKE ? OR p.patient_number LIKE ? OR rx.notes LIKE ?)');
      params.push(like, like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM prescriptions rx JOIN patients p ON p.id = rx.patient_id WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT rx.*, p.full_name AS patient_name, p.patient_number, s.full_name AS prescribed_by_name
       FROM prescriptions rx
       JOIN patients p ON p.id = rx.patient_id
       LEFT JOIN staff s ON s.id = rx.prescribed_by
       WHERE ${whereSql}
       ORDER BY rx.${sortCol} ${order}
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list prescriptions', 500, err);
  }
});

router.get('/prescriptions/:id', authenticate(true), requirePermission('pharmacy.view', 'clinical.prescribe', 'clinical.view_results'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT rx.*, p.full_name AS patient_name, p.patient_number, s.full_name AS prescribed_by_name
       FROM prescriptions rx
       JOIN patients p ON p.id = rx.patient_id
       LEFT JOIN staff s ON s.id = rx.prescribed_by
       WHERE rx.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return fail(res, 'Prescription not found', 404);
    const [items] = await pool.execute(`SELECT * FROM prescription_items WHERE prescription_id = ? ORDER BY id ASC`, [req.params.id]);
    const [dispensings] = await pool.execute(`SELECT * FROM medication_dispensing WHERE prescription_id = ? ORDER BY id ASC`, [req.params.id]);
    return ok(res, { prescription: rows[0], items, dispensings });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load prescription', 500, err);
  }
});

router.post('/prescriptions', authenticate(true), requirePermission('clinical.prescribe'), async (req, res) => {
  try {
    const b = req.body || {};
    const patientId = parseInt(b.patient_id, 10);
    const items = Array.isArray(b.items) ? b.items : [];
    if (!patientId) return fail(res, 'patient_id is required', 400);
    if (!items.length) return fail(res, 'At least one prescription item is required', 400);

    const pharmDeptId = await getDepartmentIdByCode('PHARM');
    const io = req.app.get('io');

    const result = await withTransaction(async (conn) => {
      const prescriptionNumber = await generateId(conn, 'RX');
      const [ins] = await conn.execute(
        `INSERT INTO prescriptions
         (prescription_number, patient_id, encounter_id, admission_id, prescribed_by, department_id, notes, status, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
        [
          prescriptionNumber,
          patientId,
          b.encounter_id || null,
          b.admission_id || null,
          b.prescribed_by || req.user.staff_id || null,
          b.department_id || req.user.primary_department?.id || null,
          b.notes || null,
          req.user.id,
          req.user.id
        ]
      );
      const rxId = ins.insertId;
      const createdItems = [];

      for (const item of items) {
        let medicationName = item.medication_name;
        let medicationId = item.medication_id || null;
        if (medicationId && !medicationName) {
          const [meds] = await conn.execute(`SELECT * FROM medications WHERE id = ?`, [medicationId]);
          if (meds.length) medicationName = meds[0].name;
        }
        if (!medicationName) continue;
        const [itemIns] = await conn.execute(
          `INSERT INTO prescription_items
           (prescription_id, medication_id, medication_name, dosage, route, frequency, duration, quantity, instructions, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
          [
            rxId,
            medicationId,
            medicationName,
            item.dosage || null,
            item.route || null,
            item.frequency || null,
            item.duration || null,
            item.quantity ?? null,
            item.instructions || null
          ]
        );
        createdItems.push({ id: itemIns.insertId, medication_name: medicationName });
      }

      if (!createdItems.length) throw Object.assign(new Error('No valid prescription items provided'), { status: 400 });

      await addTimeline(conn, {
        patientId,
        eventType: 'PRESCRIPTION',
        eventTitle: `Prescription ${prescriptionNumber}`,
        eventDetails: createdItems.map(i => i.medication_name).join(', '),
        departmentId: pharmDeptId || b.department_id || null,
        relatedEntity: 'prescriptions',
        relatedId: rxId,
        createdBy: req.user.id
      });

      return { id: rxId, prescription_number: prescriptionNumber, items: createdItems, patient_id: patientId };
    });

    if (pharmDeptId) {
      await notifyDepartmentUsers(pharmDeptId, {
        patientId,
        category: 'PHARMACY',
        priority: 'IMPORTANT',
        title: `New prescription ${result.prescription_number}`,
        message: result.items.map(i => i.medication_name).join(', '),
        relatedEntity: 'prescriptions',
        relatedId: result.id
      }, req.user.id);
    }

    await writeAudit(req, {
      action: 'PRESCRIPTION_CREATE',
      entity: 'prescriptions',
      entityId: result.id,
      patientId,
      description: `Created prescription ${result.prescription_number}`,
      newValue: result
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'PRESCRIPTION',
      title: `Prescription ${result.prescription_number}`,
      patientId,
      departmentId: pharmDeptId
    });

    broadcastAuthorized(io, {
      event: 'prescription:created',
      data: result,
      departmentIds: [pharmDeptId].filter(Boolean),
      roles: ['PHARMACIST', 'DOCTOR'],
      globalAdmin: true
    });

    return ok(res, result, 'Prescription created', 201);
  } catch (err) {
    console.error(err);
    return fail(res, err.message || 'Unable to create prescription', err.status || 500, err);
  }
});

router.put('/prescriptions/:id', authenticate(true), requirePermission('clinical.prescribe'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM prescriptions WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Prescription not found', 404);
    const rx = existing[0];
    if (['DISPENSED', 'CANCELLED'].includes(rx.status)) {
      return fail(res, 'Cannot update a dispensed or cancelled prescription', 400);
    }
    const b = req.body || {};
    await pool.execute(
      `UPDATE prescriptions SET
         notes = COALESCE(?, notes),
         status = COALESCE(?, status),
         updated_by = ?
       WHERE id = ?`,
      [
        b.notes !== undefined ? b.notes : null,
        b.status !== undefined ? b.status : null,
        req.user.id,
        id
      ]
    );
    await writeAudit(req, { action: 'PRESCRIPTION_UPDATE', entity: 'prescriptions', entityId: id, patientId: rx.patient_id, description: `Updated prescription ${rx.prescription_number}`, oldValue: rx, newValue: b });
    await writeActivity({ userId: req.user.id, activityType: 'PRESCRIPTION', title: `Prescription updated ${rx.prescription_number}`, patientId: rx.patient_id });
    const [rows] = await pool.execute(`SELECT * FROM prescriptions WHERE id = ?`, [id]);
    return ok(res, { prescription: rows[0] }, 'Prescription updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update prescription', 500, err);
  }
});

/* ───────────────────────────── Dispensing ───────────────────────────── */

router.get('/dispensing', authenticate(true), requirePermission('pharmacy.view', 'pharmacy.dispense'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search } = pageParams(req.query);
    const where = ['1=1'];
    const params = [];
    if (req.query.prescription_id) {
      where.push('md.prescription_id = ?');
      params.push(parseInt(req.query.prescription_id, 10));
    }
    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push('(rx.prescription_number LIKE ? OR p.full_name LIKE ? OR md.batch_number LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c
       FROM medication_dispensing md
       JOIN prescriptions rx ON rx.id = md.prescription_id
       JOIN patients p ON p.id = rx.patient_id
       WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0].c);
    const [rows] = await pool.execute(
      `SELECT md.*, rx.prescription_number, p.full_name AS patient_name, p.patient_number
       FROM medication_dispensing md
       JOIN prescriptions rx ON rx.id = md.prescription_id
       JOIN patients p ON p.id = rx.patient_id
       WHERE ${whereSql}
       ORDER BY md.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return ok(res, { items: rows, ...listMeta(page, limit, total) });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list dispensing records', 500, err);
  }
});

router.get('/dispensing/:id', authenticate(true), requirePermission('pharmacy.view', 'pharmacy.dispense'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM medication_dispensing WHERE id = ?`, [req.params.id]);
    if (!rows.length) return fail(res, 'Dispensing record not found', 404);
    return ok(res, { dispensing: rows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load dispensing record', 500, err);
  }
});

router.post('/dispensing', authenticate(true), requirePermission('pharmacy.dispense'), async (req, res) => {
  try {
    const b = req.body || {};
    const prescriptionId = parseInt(b.prescription_id, 10);
    const quantity = Number(b.quantity_dispensed);
    if (!prescriptionId || !quantity || quantity <= 0) {
      return fail(res, 'prescription_id and positive quantity_dispensed are required', 400);
    }

    const pharmDeptId = await getDepartmentIdByCode('PHARM');
    const io = req.app.get('io');

    const result = await withTransaction(async (conn) => {
      const [rxRows] = await conn.execute(`SELECT * FROM prescriptions WHERE id = ? FOR UPDATE`, [prescriptionId]);
      if (!rxRows.length) throw Object.assign(new Error('Prescription not found'), { status: 404 });
      const rx = rxRows[0];
      if (['CANCELLED', 'DISPENSED'].includes(rx.status)) {
        throw Object.assign(new Error('Prescription cannot be dispensed'), { status: 400 });
      }

      let medicationId = b.medication_id || null;
      const itemId = b.prescription_item_id ? parseInt(b.prescription_item_id, 10) : null;
      if (itemId) {
        const [items] = await conn.execute(`SELECT * FROM prescription_items WHERE id = ? AND prescription_id = ?`, [itemId, prescriptionId]);
        if (!items.length) throw Object.assign(new Error('Prescription item not found'), { status: 404 });
        medicationId = medicationId || items[0].medication_id;
        await conn.execute(`UPDATE prescription_items SET status = 'DISPENSED' WHERE id = ?`, [itemId]);
      }

      if (medicationId) {
        const [meds] = await conn.execute(`SELECT * FROM medications WHERE id = ? FOR UPDATE`, [medicationId]);
        if (meds.length) {
          const med = meds[0];
          const newQty = Number(med.stock_quantity) - quantity;
          if (newQty < 0) throw Object.assign(new Error('Insufficient medication stock'), { status: 400 });
          await conn.execute(
            `UPDATE medications SET stock_quantity = ?, updated_by = ? WHERE id = ?`,
            [newQty, req.user.id, medicationId]
          );
          if (newQty <= Number(med.reorder_level)) {
            await createAlert({
              patientId: null,
              alertType: 'PHARMACY_STOCK',
              severity: 'IMPORTANT',
              title: `Low stock: ${med.name}`,
              message: `Stock is ${newQty} (reorder level ${med.reorder_level})`,
              relatedEntity: 'medications',
              relatedId: medicationId,
              createdBy: req.user.id
            });
          }
        }
      }

      const [ins] = await conn.execute(
        `INSERT INTO medication_dispensing
         (prescription_id, prescription_item_id, medication_id, quantity_dispensed, batch_number, expiry_date,
          dispensed_by, notes, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DISPENSED', ?)`,
        [
          prescriptionId,
          itemId,
          medicationId,
          quantity,
          b.batch_number || null,
          b.expiry_date || null,
          b.dispensed_by || req.user.staff_id || null,
          b.notes || null,
          req.user.id
        ]
      );

      const [pendingItems] = await conn.execute(
        `SELECT COUNT(*) AS c FROM prescription_items WHERE prescription_id = ? AND status = 'PENDING'`,
        [prescriptionId]
      );
      const rxStatus = Number(pendingItems[0].c) === 0 ? 'DISPENSED' : 'PARTIAL';
      await conn.execute(`UPDATE prescriptions SET status = ?, updated_by = ? WHERE id = ?`, [rxStatus, req.user.id, prescriptionId]);

      await addTimeline(conn, {
        patientId: rx.patient_id,
        eventType: 'DISPENSE',
        eventTitle: `Medication dispensed for ${rx.prescription_number}`,
        eventDetails: `Qty ${quantity}`,
        departmentId: pharmDeptId,
        relatedEntity: 'medication_dispensing',
        relatedId: ins.insertId,
        createdBy: req.user.id
      });

      return {
        id: ins.insertId,
        prescription_id: prescriptionId,
        prescription_number: rx.prescription_number,
        patient_id: rx.patient_id,
        quantity_dispensed: quantity,
        prescription_status: rxStatus
      };
    });

    await writeAudit(req, {
      action: 'MEDICATION_DISPENSE',
      entity: 'medication_dispensing',
      entityId: result.id,
      patientId: result.patient_id,
      description: `Dispensed for ${result.prescription_number}`,
      newValue: result
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'DISPENSE',
      title: `Dispensed ${result.prescription_number}`,
      patientId: result.patient_id,
      departmentId: pharmDeptId
    });

    broadcastAuthorized(io, {
      event: 'pharmacy:dispensed',
      data: result,
      departmentIds: [pharmDeptId].filter(Boolean),
      roles: ['PHARMACIST', 'DOCTOR', 'STAFF_NURSE'],
      globalAdmin: true
    });

    return ok(res, result, 'Medication dispensed', 201);
  } catch (err) {
    console.error(err);
    return fail(res, err.message || 'Unable to dispense medication', err.status || 500, err);
  }
});

router.put('/dispensing/:id', authenticate(true), requirePermission('pharmacy.dispense'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const [existing] = await pool.execute(`SELECT * FROM medication_dispensing WHERE id = ?`, [id]);
    if (!existing.length) return fail(res, 'Dispensing record not found', 404);
    const md = existing[0];
    const b = req.body || {};
    await pool.execute(
      `UPDATE medication_dispensing SET
         batch_number = COALESCE(?, batch_number),
         expiry_date = COALESCE(?, expiry_date),
         notes = COALESCE(?, notes),
         status = COALESCE(?, status)
       WHERE id = ?`,
      [
        b.batch_number !== undefined ? b.batch_number : null,
        b.expiry_date !== undefined ? b.expiry_date : null,
        b.notes !== undefined ? b.notes : null,
        b.status !== undefined ? b.status : null,
        id
      ]
    );
    const [rxRows] = await pool.execute(`SELECT patient_id, prescription_number FROM prescriptions WHERE id = ?`, [md.prescription_id]);
    await writeAudit(req, {
      action: 'MEDICATION_DISPENSE_UPDATE',
      entity: 'medication_dispensing',
      entityId: id,
      patientId: rxRows[0]?.patient_id || null,
      description: 'Updated dispensing record',
      oldValue: md,
      newValue: b
    });
    const [rows] = await pool.execute(`SELECT * FROM medication_dispensing WHERE id = ?`, [id]);
    return ok(res, { dispensing: rows[0] }, 'Dispensing record updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update dispensing record', 500, err);
  }
});

module.exports = router;
