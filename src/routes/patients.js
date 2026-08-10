'use strict';

const express = require('express');
const { getPool, withTransaction } = require('../db/pool');
const { ok, fail } = require('../utils/response');
const { authenticate, requirePermission } = require('../middleware/auth');
const { writeAudit, writeActivity } = require('../middleware/audit');
const { pageParams, sanitizeLike, calcAge, pick } = require('../utils/helpers');
const { randomToken } = require('../utils/crypto');
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

const PATIENT_SORT = new Set([
  'created_at',
  'updated_at',
  'full_name',
  'patient_number',
  'hospital_number',
  'date_of_birth',
  'last_name',
  'first_name',
  'patient_status',
  'sex',
  'phone'
]);

function buildFullName(firstName, middleName, lastName) {
  return [firstName, middleName, lastName]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' ');
}

async function findDuplicatePatients(poolOrConn, { first_name, last_name, date_of_birth, phone }) {
  const runner = poolOrConn;
  const params = [
    String(first_name || '').trim(),
    String(last_name || '').trim(),
    date_of_birth,
    phone ? String(phone).trim() : null,
    date_of_birth
  ];
  const [rows] = await runner.execute(
    `SELECT id, patient_number, hospital_number, first_name, middle_name, last_name, full_name,
            date_of_birth, phone, sex, patient_status, status, created_at
     FROM patients
     WHERE status != 'ARCHIVED'
       AND (
         (LOWER(TRIM(first_name)) = LOWER(TRIM(?))
          AND LOWER(TRIM(last_name)) = LOWER(TRIM(?))
          AND date_of_birth = ?)
         OR (
           ? IS NOT NULL AND TRIM(?) != ''
           AND phone IS NOT NULL AND TRIM(phone) != ''
           AND phone = ?
           AND date_of_birth = ?
         )
       )
     ORDER BY created_at DESC
     LIMIT 25`,
    [
      params[0],
      params[1],
      params[2],
      params[3],
      params[3],
      params[3],
      params[4]
    ]
  );
  return rows;
}

async function touchRecentItem(pool, userId, patient) {
  const [existing] = await pool.execute(
    `SELECT id FROM recent_items
     WHERE user_id = ? AND entity_type = 'patient' AND entity_id = ?
     LIMIT 1`,
    [userId, patient.id]
  );
  if (existing.length) {
    await pool.execute(
      `UPDATE recent_items SET title = ?, accessed_at = NOW() WHERE id = ?`,
      [patient.full_name || patient.patient_number, existing[0].id]
    );
  } else {
    await pool.execute(
      `INSERT INTO recent_items (user_id, entity_type, entity_id, title, accessed_at)
       VALUES (?, 'patient', ?, ?, NOW())`,
      [userId, patient.id, patient.full_name || patient.patient_number]
    );
  }
  await pool.execute(
    `DELETE FROM recent_items
     WHERE user_id = ?
       AND entity_type = 'patient'
       AND id NOT IN (
         SELECT id FROM (
           SELECT id FROM recent_items
           WHERE user_id = ? AND entity_type = 'patient'
           ORDER BY accessed_at DESC
           LIMIT 30
         ) keep_rows
       )`,
    [userId, userId]
  );
}

router.get('/', authenticate(true), requirePermission('patients.view'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search, sort, order } = pageParams(req.query);
    const sortCol = PATIENT_SORT.has(sort) ? sort : 'created_at';

    const where = ['p.status != \'ARCHIVED\''];
    const params = [];

    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push(`(
        p.full_name LIKE ? OR p.first_name LIKE ? OR p.last_name LIKE ?
        OR p.patient_number LIKE ? OR p.hospital_number LIKE ?
        OR p.phone LIKE ? OR CAST(p.date_of_birth AS CHAR) LIKE ?
      )`);
      params.push(like, like, like, like, like, like, like);
    }

    if (req.query.status) {
      where.push('p.status = ?');
      params.push(String(req.query.status));
    } else {
      where.push('p.status = \'ACTIVE\'');
    }
    if (req.query.patient_status) {
      where.push('p.patient_status = ?');
      params.push(String(req.query.patient_status));
    }
    if (req.query.sex) {
      where.push('p.sex = ?');
      params.push(String(req.query.sex));
    }
    if (req.query.blood_group) {
      where.push('p.blood_group = ?');
      params.push(String(req.query.blood_group));
    }
    if (req.query.ward_id) {
      where.push('p.current_ward_id = ?');
      params.push(parseInt(req.query.ward_id, 10));
    }
    if (req.query.department_id) {
      where.push(`EXISTS (
        SELECT 1 FROM admissions a
        WHERE a.patient_id = p.id AND a.status = 'ACTIVE' AND a.department_id = ?
      )`);
      params.push(parseInt(req.query.department_id, 10));
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM patients p ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await pool.execute(
      `SELECT p.id, p.patient_number, p.hospital_number, p.first_name, p.middle_name, p.last_name,
              p.full_name, p.date_of_birth, p.sex, p.phone, p.email, p.blood_group, p.genotype,
              p.patient_status, p.current_ward_id, p.current_bed_id, p.status, p.created_at, p.updated_at,
              w.name AS ward_name, b.label AS bed_label
       FROM patients p
       LEFT JOIN wards w ON w.id = p.current_ward_id
       LEFT JOIN beds b ON b.id = p.current_bed_id
       ${whereSql}
       ORDER BY p.${sortCol} ${order}
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const patients = rows.map((p) => ({ ...p, age: calcAge(p.date_of_birth) }));
    return ok(res, {
      patients,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit))
      }
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list patients', 500, err);
  }
});

router.get('/search', authenticate(true), requirePermission('patients.search', 'patients.view'), async (req, res) => {
  try {
    const q = String(req.query.q || req.query.search || '').trim();
    if (!q || q.length < 1) return ok(res, { patients: [] });

    const pool = getPool();
    const like = `%${sanitizeLike(q)}%`;
    const limit = Math.min(25, Math.max(1, parseInt(req.query.limit || '15', 10) || 15));
    const [rows] = await pool.execute(
      `SELECT id, patient_number, hospital_number, full_name, date_of_birth, sex, phone,
              blood_group, patient_status, status
       FROM patients
       WHERE status = 'ACTIVE'
         AND (
           full_name LIKE ? OR patient_number LIKE ? OR hospital_number LIKE ?
           OR phone LIKE ? OR first_name LIKE ? OR last_name LIKE ?
         )
       ORDER BY
         CASE
           WHEN patient_number = ? OR hospital_number = ? THEN 0
           WHEN full_name LIKE ? THEN 1
           ELSE 2
         END,
         full_name ASC
       LIMIT ${limit}`,
      [like, like, like, like, like, like, q, q, `${sanitizeLike(q)}%`]
    );
    return ok(res, {
      patients: rows.map((p) => ({ ...p, age: calcAge(p.date_of_birth) }))
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to search patients', 500, err);
  }
});

router.get('/lookup/qr/:token', authenticate(true), requirePermission('patients.search', 'patients.view'), async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return fail(res, 'QR token required', 400);

    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT id, patient_number, hospital_number, full_name, first_name, middle_name, last_name,
              date_of_birth, sex, phone, blood_group, genotype, patient_status, status, qr_token,
              photo_path, created_at
       FROM patients
       WHERE qr_token = ?
       LIMIT 1`,
      [token]
    );
    if (!rows.length) return fail(res, 'Patient not found for QR token', 404);

    const patient = { ...rows[0], age: calcAge(rows[0].date_of_birth) };
    await writeAudit(req, {
      action: 'PATIENT_QR_LOOKUP',
      entity: 'patients',
      entityId: patient.id,
      patientId: patient.id,
      description: `QR lookup for ${patient.patient_number}`
    });
    return ok(res, { patient });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to lookup patient by QR', 500, err);
  }
});

router.get('/:id', authenticate(true), requirePermission('patients.view'), async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    if (!patientId) return fail(res, 'Invalid patient id', 400);

    const pool = getPool();
    const [rows] = await pool.execute(`SELECT * FROM patients WHERE id = ? LIMIT 1`, [patientId]);
    if (!rows.length) return fail(res, 'Patient not found', 404);

    const patient = { ...rows[0], age: calcAge(rows[0].date_of_birth) };

    const [[allergies], [bloodRows], [admissionRows], [alerts], [vitals], [identifiers], [cardRows]] = await Promise.all([
      pool.execute(
        `SELECT * FROM allergies WHERE patient_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC`,
        [patientId]
      ),
      pool.execute(`SELECT * FROM blood_information WHERE patient_id = ? LIMIT 1`, [patientId]),
      pool.execute(
        `SELECT a.*, d.name AS department_name, w.name AS ward_name, b.label AS bed_label,
                s.full_name AS admitting_doctor_name
         FROM admissions a
         LEFT JOIN departments d ON d.id = a.department_id
         LEFT JOIN wards w ON w.id = a.ward_id
         LEFT JOIN beds b ON b.id = a.bed_id
         LEFT JOIN staff s ON s.id = a.admitting_doctor_id
         WHERE a.patient_id = ? AND a.status = 'ACTIVE'
         ORDER BY a.admitted_at DESC
         LIMIT 1`,
        [patientId]
      ),
      pool.execute(
        `SELECT * FROM clinical_alerts
         WHERE patient_id = ? AND status = 'ACTIVE'
         ORDER BY FIELD(severity,'CRITICAL','URGENT','IMPORTANT','NORMAL','INFO'), created_at DESC
         LIMIT 20`,
        [patientId]
      ),
      pool.execute(
        `SELECT * FROM vital_signs
         WHERE patient_id = ? AND status = 'ACTIVE'
         ORDER BY recorded_at DESC
         LIMIT 10`,
        [patientId]
      ),
      pool.execute(
        `SELECT * FROM patient_identifiers WHERE patient_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC`,
        [patientId]
      ),
      pool.execute(
        `SELECT * FROM patient_cards WHERE patient_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`,
        [patientId]
      )
    ]);

    await touchRecentItem(pool, req.user.id, patient);
    await writeAudit(req, {
      action: 'PATIENT_VIEW',
      entity: 'patients',
      entityId: patient.id,
      patientId: patient.id,
      description: `Viewed patient ${patient.patient_number}`
    });

    return ok(res, {
      patient,
      allergies,
      blood: bloodRows[0] || null,
      currentAdmission: admissionRows[0] || null,
      alerts,
      recentVitals: vitals,
      identifiers,
      card: cardRows[0] || null
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load patient', 500, err);
  }
});

router.get('/:id/timeline', authenticate(true), requirePermission('patients.view'), async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    if (!patientId) return fail(res, 'Invalid patient id', 400);

    const pool = getPool();
    const [patients] = await pool.execute(`SELECT id FROM patients WHERE id = ? LIMIT 1`, [patientId]);
    if (!patients.length) return fail(res, 'Patient not found', 404);

    const { page, limit, offset } = pageParams(req.query);
    const where = ['patient_id = ?'];
    const params = [patientId];
    if (req.query.event_type) {
      where.push('event_type = ?');
      params.push(String(req.query.event_type));
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM patient_timeline ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);
    const [events] = await pool.execute(
      `SELECT t.*, d.name AS department_name
       FROM patient_timeline t
       LEFT JOIN departments d ON d.id = t.department_id
       ${whereSql}
       ORDER BY t.event_at DESC, t.id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    return ok(res, {
      events,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit))
      }
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load patient timeline', 500, err);
  }
});

router.post('/duplicate-check', authenticate(true), requirePermission('patients.create', 'patients.view'), async (req, res) => {
  try {
    const first_name = String(req.body.first_name || '').trim();
    const last_name = String(req.body.last_name || '').trim();
    const date_of_birth = req.body.date_of_birth;
    const phone = req.body.phone ? String(req.body.phone).trim() : null;

    if (!first_name || !last_name || !date_of_birth) {
      return fail(res, 'first_name, last_name, and date_of_birth are required', 400);
    }

    const matches = await findDuplicatePatients(getPool(), {
      first_name,
      last_name,
      date_of_birth,
      phone
    });
    return ok(res, {
      hasMatches: matches.length > 0,
      matches: matches.map((p) => ({ ...p, age: calcAge(p.date_of_birth) }))
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to check duplicates', 500, err);
  }
});

router.post('/', authenticate(true), requirePermission('patients.create'), async (req, res) => {
  try {
    const body = req.body || {};
    const first_name = String(body.first_name || '').trim();
    const middle_name = body.middle_name != null ? String(body.middle_name).trim() || null : null;
    const last_name = String(body.last_name || '').trim();
    const date_of_birth = body.date_of_birth;
    const sex = String(body.sex || '').trim();
    const phone = body.phone != null ? String(body.phone).trim() || null : null;

    if (!first_name || !last_name || !date_of_birth || !sex) {
      return fail(res, 'first_name, last_name, date_of_birth, and sex are required', 400);
    }

    const pool = getPool();
    const matches = await findDuplicatePatients(pool, {
      first_name,
      last_name,
      date_of_birth,
      phone
    });

    if (matches.length) {
      const canForce =
        body.forceCreate === true &&
        (req.user.is_central_admin || req.user.permissions.includes('patients.create'));
      if (!canForce) {
        return res.status(409).json({
          success: false,
          message: 'Possible duplicate patient(s) found',
          data: {
            matches: matches.map((p) => ({ ...p, age: calcAge(p.date_of_birth) })),
            forceCreateRequired: true
          }
        });
      }
    }

    const full_name = buildFullName(first_name, middle_name, last_name);
    const blood_group = body.blood_group != null ? String(body.blood_group).trim() || null : null;
    const genotype = body.genotype != null ? String(body.genotype).trim() || null : null;
    const rhesus = body.rhesus != null ? String(body.rhesus).trim() || null : null;

    const result = await withTransaction(async (conn) => {
      const patientNumber = await generateId(conn, 'PATIENT');
      const hospitalNumber = body.hospital_number
        ? String(body.hospital_number).trim()
        : patientNumber;
      const qrToken = randomToken(24);

      const [ins] = await conn.execute(
        `INSERT INTO patients
         (patient_number, hospital_number, first_name, middle_name, last_name, full_name,
          date_of_birth, sex, phone, email, address, city, state, country, marital_status,
          occupation, religion, nationality, photo_path, blood_group, genotype,
          emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
          next_of_kin_name, next_of_kin_phone, next_of_kin_relationship,
          qr_token, patient_status, status, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OUTPATIENT', 'ACTIVE', ?, ?)`,
        [
          patientNumber,
          hospitalNumber,
          first_name,
          middle_name,
          last_name,
          full_name,
          date_of_birth,
          sex,
          phone,
          body.email || null,
          body.address || null,
          body.city || null,
          body.state || null,
          body.country || null,
          body.marital_status || null,
          body.occupation || null,
          body.religion || null,
          body.nationality || null,
          body.photo_path || null,
          blood_group,
          genotype,
          body.emergency_contact_name || null,
          body.emergency_contact_phone || null,
          body.emergency_contact_relationship || null,
          body.next_of_kin_name || null,
          body.next_of_kin_phone || null,
          body.next_of_kin_relationship || null,
          qrToken,
          req.user.id,
          req.user.id
        ]
      );
      const patientId = ins.insertId;

      if (blood_group || genotype || rhesus) {
        await conn.execute(
          `INSERT INTO blood_information
           (patient_id, blood_group, genotype, rhesus, notes, status, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
          [
            patientId,
            blood_group,
            genotype,
            rhesus,
            body.blood_notes || null,
            req.user.id,
            req.user.id
          ]
        );
      }

      const [templates] = await conn.execute(
        `SELECT id FROM id_card_templates
         WHERE card_type = 'PATIENT' AND is_default = 1 AND status = 'ACTIVE'
         ORDER BY id ASC LIMIT 1`
      );
      const templateId = templates[0]?.id || null;
      const cardNumber = await generateId(conn, 'CARD_PAT');
      const cardData = {
        patient_number: patientNumber,
        hospital_number: hospitalNumber,
        full_name,
        date_of_birth,
        sex,
        blood_group,
        qr_token: qrToken
      };
      const [cardIns] = await conn.execute(
        `INSERT INTO patient_cards
         (patient_id, template_id, card_number, issue_date, expiry_date, qr_payload, card_data_json, status, created_by)
         VALUES (?, ?, ?, CURDATE(), NULL, ?, ?, 'ACTIVE', ?)`,
        [patientId, templateId, cardNumber, qrToken, JSON.stringify(cardData), req.user.id]
      );

      const mrDeptId = await getDepartmentIdByCode('MR');
      await addTimeline(conn, {
        patientId,
        eventType: 'REGISTRATION',
        eventTitle: 'Patient registered',
        eventDetails: `Registered as ${patientNumber} / ${hospitalNumber}`,
        departmentId: mrDeptId || req.user.primary_department?.id || null,
        relatedEntity: 'patients',
        relatedId: patientId,
        createdBy: req.user.id
      });

      const [patientRows] = await conn.execute(`SELECT * FROM patients WHERE id = ?`, [patientId]);
      const [cardRows] = await conn.execute(`SELECT * FROM patient_cards WHERE id = ?`, [cardIns.insertId]);
      return { patient: patientRows[0], card: cardRows[0], mrDeptId };
    });

    await writeAudit(req, {
      action: 'PATIENT_CREATE',
      entity: 'patients',
      entityId: result.patient.id,
      patientId: result.patient.id,
      description: `Registered patient ${result.patient.patient_number}`,
      newValue: {
        id: result.patient.id,
        patient_number: result.patient.patient_number,
        hospital_number: result.patient.hospital_number,
        full_name: result.patient.full_name
      },
      severity: 'IMPORTANT'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'PATIENT_REGISTRATION',
      title: 'Patient registered',
      details: `${result.patient.full_name} (${result.patient.patient_number})`,
      patientId: result.patient.id,
      departmentId: result.mrDeptId || req.user.primary_department?.id || null
    });

    if (result.mrDeptId) {
      await notifyDepartmentUsers(
        result.mrDeptId,
        {
          patientId: result.patient.id,
          category: 'PATIENT',
          priority: 'NORMAL',
          title: 'New patient registered',
          message: `${result.patient.full_name} (${result.patient.patient_number}) was registered`,
          relatedEntity: 'patients',
          relatedId: result.patient.id
        },
        req.user.id
      );
    } else {
      await createNotification({
        userId: req.user.id,
        patientId: result.patient.id,
        category: 'PATIENT',
        priority: 'NORMAL',
        title: 'New patient registered',
        message: `${result.patient.full_name} (${result.patient.patient_number}) was registered`,
        relatedEntity: 'patients',
        relatedId: result.patient.id
      });
    }

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: 'patient:created',
      data: {
        id: result.patient.id,
        patient_number: result.patient.patient_number,
        hospital_number: result.patient.hospital_number,
        full_name: result.patient.full_name,
        sex: result.patient.sex,
        date_of_birth: result.patient.date_of_birth,
        patient_status: result.patient.patient_status
      },
      userIds: [req.user.id],
      departmentIds: result.mrDeptId ? [result.mrDeptId] : [],
      roles: ['MEDICAL_RECORDS', 'HOSPITAL_ADMIN', 'CMD'],
      globalAdmin: true
    });

    return ok(
      res,
      {
        patient: { ...result.patient, age: calcAge(result.patient.date_of_birth) },
        card: result.card
      },
      'Patient registered',
      201
    );
  } catch (err) {
    console.error(err);
    if (err && err.code === 'ER_DUP_ENTRY') {
      return fail(res, 'A patient with this number or identifier already exists', 409, err);
    }
    return fail(res, 'Unable to register patient', 500, err);
  }
});

router.put('/:id', authenticate(true), requirePermission('patients.edit'), async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    if (!patientId) return fail(res, 'Invalid patient id', 400);

    const pool = getPool();
    const [existingRows] = await pool.execute(`SELECT * FROM patients WHERE id = ? LIMIT 1`, [patientId]);
    if (!existingRows.length) return fail(res, 'Patient not found', 404);
    const existing = existingRows[0];

    const allowed = pick(req.body || {}, [
      'first_name',
      'middle_name',
      'last_name',
      'date_of_birth',
      'sex',
      'phone',
      'email',
      'address',
      'city',
      'state',
      'country',
      'marital_status',
      'occupation',
      'religion',
      'nationality',
      'photo_path',
      'blood_group',
      'genotype',
      'emergency_contact_name',
      'emergency_contact_phone',
      'emergency_contact_relationship',
      'next_of_kin_name',
      'next_of_kin_phone',
      'next_of_kin_relationship',
      'patient_status',
      'hospital_number',
      'status'
    ]);

    if (!Object.keys(allowed).length) return fail(res, 'No updatable fields provided', 400);

    if (allowed.first_name !== undefined) allowed.first_name = String(allowed.first_name).trim();
    if (allowed.middle_name !== undefined) {
      allowed.middle_name = allowed.middle_name == null || allowed.middle_name === ''
        ? null
        : String(allowed.middle_name).trim();
    }
    if (allowed.last_name !== undefined) allowed.last_name = String(allowed.last_name).trim();

    const first_name = allowed.first_name !== undefined ? allowed.first_name : existing.first_name;
    const middle_name = allowed.middle_name !== undefined ? allowed.middle_name : existing.middle_name;
    const last_name = allowed.last_name !== undefined ? allowed.last_name : existing.last_name;
    allowed.full_name = buildFullName(first_name, middle_name, last_name);
    allowed.updated_by = req.user.id;

    const fields = Object.keys(allowed);
    const sets = fields.map((f) => `${f} = ?`).join(', ');
    const values = fields.map((f) => allowed[f]);
    values.push(patientId);

    await pool.execute(`UPDATE patients SET ${sets} WHERE id = ?`, values);

    if (allowed.blood_group !== undefined || allowed.genotype !== undefined) {
      const blood_group = allowed.blood_group !== undefined ? allowed.blood_group : existing.blood_group;
      const genotype = allowed.genotype !== undefined ? allowed.genotype : existing.genotype;
      const [blood] = await pool.execute(
        `SELECT id FROM blood_information WHERE patient_id = ? LIMIT 1`,
        [patientId]
      );
      if (blood.length) {
        await pool.execute(
          `UPDATE blood_information
           SET blood_group = ?, genotype = ?, updated_by = ?
           WHERE patient_id = ?`,
          [blood_group, genotype, req.user.id, patientId]
        );
      } else if (blood_group || genotype) {
        await pool.execute(
          `INSERT INTO blood_information
           (patient_id, blood_group, genotype, status, created_by, updated_by)
           VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
          [patientId, blood_group, genotype, req.user.id, req.user.id]
        );
      }
    }

    const [updatedRows] = await pool.execute(`SELECT * FROM patients WHERE id = ?`, [patientId]);
    const updated = updatedRows[0];

    await writeAudit(req, {
      action: 'PATIENT_UPDATE',
      entity: 'patients',
      entityId: patientId,
      patientId,
      description: `Updated patient ${updated.patient_number}`,
      oldValue: pick(existing, fields.filter((f) => f !== 'updated_by').concat(['full_name'])),
      newValue: pick(updated, fields.filter((f) => f !== 'updated_by').concat(['full_name'])),
      severity: 'IMPORTANT'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'PATIENT_UPDATE',
      title: 'Patient updated',
      details: `${updated.full_name} (${updated.patient_number})`,
      patientId,
      departmentId: req.user.primary_department?.id || null
    });

    return ok(res, { patient: { ...updated, age: calcAge(updated.date_of_birth) } }, 'Patient updated');
  } catch (err) {
    console.error(err);
    if (err && err.code === 'ER_DUP_ENTRY') {
      return fail(res, 'Hospital number already in use', 409, err);
    }
    return fail(res, 'Unable to update patient', 500, err);
  }
});

router.post('/:id/allergies', authenticate(true), requirePermission('patients.edit'), async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    if (!patientId) return fail(res, 'Invalid patient id', 400);

    const allergen = String(req.body.allergen || '').trim();
    if (!allergen) return fail(res, 'allergen is required', 400);

    const reaction = req.body.reaction != null ? String(req.body.reaction).trim() || null : null;
    const severity = req.body.severity != null ? String(req.body.severity).trim() || null : null;

    const pool = getPool();
    const [patients] = await pool.execute(`SELECT id, full_name, patient_number FROM patients WHERE id = ?`, [patientId]);
    if (!patients.length) return fail(res, 'Patient not found', 404);

    const [ins] = await pool.execute(
      `INSERT INTO allergies
       (patient_id, allergen, reaction, severity, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      [patientId, allergen, reaction, severity, req.user.id, req.user.id]
    );

    let alertId = null;
    const sev = String(severity || '').toUpperCase();
    if (sev === 'HIGH' || sev === 'CRITICAL') {
      alertId = await createAlert({
        patientId,
        alertType: 'ALLERGY',
        severity: sev === 'CRITICAL' ? 'CRITICAL' : 'URGENT',
        title: `Allergy: ${allergen}`,
        message: reaction || `Documented ${sev.toLowerCase()} severity allergy`,
        relatedEntity: 'allergies',
        relatedId: ins.insertId,
        createdBy: req.user.id
      });
    }

    await addTimeline(null, {
      patientId,
      eventType: 'ALLERGY',
      eventTitle: `Allergy recorded: ${allergen}`,
      eventDetails: [severity, reaction].filter(Boolean).join(' — ') || null,
      relatedEntity: 'allergies',
      relatedId: ins.insertId,
      createdBy: req.user.id
    });

    await writeAudit(req, {
      action: 'ALLERGY_CREATE',
      entity: 'allergies',
      entityId: ins.insertId,
      patientId,
      description: `Added allergy ${allergen}`,
      newValue: { allergen, reaction, severity },
      severity: sev === 'CRITICAL' || sev === 'HIGH' ? 'IMPORTANT' : 'INFO'
    });

    const [rows] = await pool.execute(`SELECT * FROM allergies WHERE id = ?`, [ins.insertId]);
    return ok(res, { allergy: rows[0], alertId }, 'Allergy added', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to add allergy', 500, err);
  }
});

router.get('/:id/allergies', authenticate(true), requirePermission('patients.view'), async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    if (!patientId) return fail(res, 'Invalid patient id', 400);

    const pool = getPool();
    const [patients] = await pool.execute(`SELECT id FROM patients WHERE id = ?`, [patientId]);
    if (!patients.length) return fail(res, 'Patient not found', 404);

    const [allergies] = await pool.execute(
      `SELECT * FROM allergies
       WHERE patient_id = ?
         AND (? = 1 OR status = 'ACTIVE')
       ORDER BY created_at DESC`,
      [patientId, req.query.includeInactive === 'true' ? 1 : 0]
    );
    return ok(res, { allergies });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load allergies', 500, err);
  }
});

router.post('/:id/identifiers', authenticate(true), requirePermission('patients.edit'), async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    if (!patientId) return fail(res, 'Invalid patient id', 400);

    const id_type = String(req.body.id_type || '').trim();
    const id_value = String(req.body.id_value || '').trim();
    if (!id_type || !id_value) return fail(res, 'id_type and id_value are required', 400);

    const pool = getPool();
    const [patients] = await pool.execute(`SELECT id FROM patients WHERE id = ?`, [patientId]);
    if (!patients.length) return fail(res, 'Patient not found', 404);

    const [ins] = await pool.execute(
      `INSERT INTO patient_identifiers
       (patient_id, id_type, id_value, status, created_by)
       VALUES (?, ?, ?, 'ACTIVE', ?)`,
      [patientId, id_type, id_value, req.user.id]
    );

    await writeAudit(req, {
      action: 'PATIENT_IDENTIFIER_CREATE',
      entity: 'patient_identifiers',
      entityId: ins.insertId,
      patientId,
      description: `Added identifier ${id_type}`,
      newValue: { id_type, id_value }
    });

    const [rows] = await pool.execute(`SELECT * FROM patient_identifiers WHERE id = ?`, [ins.insertId]);
    return ok(res, { identifier: rows[0] }, 'Identifier added', 201);
  } catch (err) {
    console.error(err);
    if (err && err.code === 'ER_DUP_ENTRY') {
      return fail(res, 'This identifier already exists', 409, err);
    }
    return fail(res, 'Unable to add identifier', 500, err);
  }
});

router.get('/:id/identifiers', authenticate(true), requirePermission('patients.view'), async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    if (!patientId) return fail(res, 'Invalid patient id', 400);

    const pool = getPool();
    const [patients] = await pool.execute(`SELECT id FROM patients WHERE id = ?`, [patientId]);
    if (!patients.length) return fail(res, 'Patient not found', 404);

    const [identifiers] = await pool.execute(
      `SELECT * FROM patient_identifiers
       WHERE patient_id = ?
         AND (? = 1 OR status = 'ACTIVE')
       ORDER BY created_at DESC`,
      [patientId, req.query.includeInactive === 'true' ? 1 : 0]
    );
    return ok(res, { identifiers });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load identifiers', 500, err);
  }
});

router.post('/:id/history/medical', authenticate(true), requirePermission('patients.edit'), async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    if (!patientId) return fail(res, 'Invalid patient id', 400);

    const condition_name = String(req.body.condition_name || '').trim();
    if (!condition_name) return fail(res, 'condition_name is required', 400);

    const pool = getPool();
    const [patients] = await pool.execute(`SELECT id FROM patients WHERE id = ?`, [patientId]);
    if (!patients.length) return fail(res, 'Patient not found', 404);

    const [ins] = await pool.execute(
      `INSERT INTO medical_history
       (patient_id, condition_name, diagnosed_year, notes, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      [
        patientId,
        condition_name,
        req.body.diagnosed_year || null,
        req.body.notes || null,
        req.user.id,
        req.user.id
      ]
    );

    await addTimeline(null, {
      patientId,
      eventType: 'MEDICAL_HISTORY',
      eventTitle: `Medical history: ${condition_name}`,
      eventDetails: req.body.notes || null,
      relatedEntity: 'medical_history',
      relatedId: ins.insertId,
      createdBy: req.user.id
    });
    await writeAudit(req, {
      action: 'MEDICAL_HISTORY_CREATE',
      entity: 'medical_history',
      entityId: ins.insertId,
      patientId,
      description: `Added medical history ${condition_name}`,
      newValue: { condition_name, diagnosed_year: req.body.diagnosed_year || null }
    });

    const [rows] = await pool.execute(`SELECT * FROM medical_history WHERE id = ?`, [ins.insertId]);
    return ok(res, { medicalHistory: rows[0] }, 'Medical history added', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to add medical history', 500, err);
  }
});

router.post('/:id/history/surgical', authenticate(true), requirePermission('patients.edit'), async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    if (!patientId) return fail(res, 'Invalid patient id', 400);

    const procedure_name = String(req.body.procedure_name || '').trim();
    if (!procedure_name) return fail(res, 'procedure_name is required', 400);

    const pool = getPool();
    const [patients] = await pool.execute(`SELECT id FROM patients WHERE id = ?`, [patientId]);
    if (!patients.length) return fail(res, 'Patient not found', 404);

    const [ins] = await pool.execute(
      `INSERT INTO surgical_history
       (patient_id, procedure_name, procedure_year, notes, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      [
        patientId,
        procedure_name,
        req.body.procedure_year || null,
        req.body.notes || null,
        req.user.id,
        req.user.id
      ]
    );

    await addTimeline(null, {
      patientId,
      eventType: 'SURGICAL_HISTORY',
      eventTitle: `Surgical history: ${procedure_name}`,
      eventDetails: req.body.notes || null,
      relatedEntity: 'surgical_history',
      relatedId: ins.insertId,
      createdBy: req.user.id
    });
    await writeAudit(req, {
      action: 'SURGICAL_HISTORY_CREATE',
      entity: 'surgical_history',
      entityId: ins.insertId,
      patientId,
      description: `Added surgical history ${procedure_name}`,
      newValue: { procedure_name, procedure_year: req.body.procedure_year || null }
    });

    const [rows] = await pool.execute(`SELECT * FROM surgical_history WHERE id = ?`, [ins.insertId]);
    return ok(res, { surgicalHistory: rows[0] }, 'Surgical history added', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to add surgical history', 500, err);
  }
});

router.post('/:id/immunizations', authenticate(true), requirePermission('patients.edit'), async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    if (!patientId) return fail(res, 'Invalid patient id', 400);

    const vaccine_name = String(req.body.vaccine_name || '').trim();
    if (!vaccine_name) return fail(res, 'vaccine_name is required', 400);

    const pool = getPool();
    const [patients] = await pool.execute(`SELECT id FROM patients WHERE id = ?`, [patientId]);
    if (!patients.length) return fail(res, 'Patient not found', 404);

    const [ins] = await pool.execute(
      `INSERT INTO immunization_records
       (patient_id, vaccine_name, dose_label, administered_on, notes, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      [
        patientId,
        vaccine_name,
        req.body.dose_label || null,
        req.body.administered_on || null,
        req.body.notes || null,
        req.user.id
      ]
    );

    await addTimeline(null, {
      patientId,
      eventType: 'IMMUNIZATION',
      eventTitle: `Immunization: ${vaccine_name}`,
      eventDetails: req.body.dose_label || null,
      relatedEntity: 'immunization_records',
      relatedId: ins.insertId,
      createdBy: req.user.id
    });
    await writeAudit(req, {
      action: 'IMMUNIZATION_CREATE',
      entity: 'immunization_records',
      entityId: ins.insertId,
      patientId,
      description: `Recorded immunization ${vaccine_name}`,
      newValue: {
        vaccine_name,
        dose_label: req.body.dose_label || null,
        administered_on: req.body.administered_on || null
      }
    });

    const [rows] = await pool.execute(`SELECT * FROM immunization_records WHERE id = ?`, [ins.insertId]);
    return ok(res, { immunization: rows[0] }, 'Immunization recorded', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to record immunization', 500, err);
  }
});

router.post('/:id/break-glass', authenticate(true), requirePermission('break_glass.use'), async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    if (!patientId) return fail(res, 'Invalid patient id', 400);

    const reason = String(req.body.reason || '').trim();
    if (!reason) return fail(res, 'reason is required', 400);

    const pool = getPool();
    const [patients] = await pool.execute(
      `SELECT id, patient_number, full_name FROM patients WHERE id = ? LIMIT 1`,
      [patientId]
    );
    if (!patients.length) return fail(res, 'Patient not found', 404);

    const [ins] = await pool.execute(
      `INSERT INTO break_glass_access (user_id, patient_id, reason, expires_at)
       VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 2 HOUR))`,
      [req.user.id, patientId, reason]
    );

    const [rows] = await pool.execute(`SELECT * FROM break_glass_access WHERE id = ?`, [ins.insertId]);

    await writeAudit(req, {
      action: 'BREAK_GLASS',
      entity: 'break_glass_access',
      entityId: ins.insertId,
      patientId,
      description: `Break-glass access granted for ${patients[0].patient_number}: ${reason}`,
      newValue: { reason, expires_at: rows[0].expires_at },
      severity: 'CRITICAL'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'BREAK_GLASS',
      title: 'Break-glass access',
      details: `${patients[0].full_name} (${patients[0].patient_number}): ${reason}`,
      patientId,
      departmentId: req.user.primary_department?.id || null
    });
    await addTimeline(null, {
      patientId,
      eventType: 'BREAK_GLASS',
      eventTitle: 'Break-glass access granted',
      eventDetails: reason,
      relatedEntity: 'break_glass_access',
      relatedId: ins.insertId,
      createdBy: req.user.id
    });

    return ok(res, { access: rows[0] }, 'Break-glass access granted for 2 hours', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to grant break-glass access', 500, err);
  }
});

module.exports = router;
