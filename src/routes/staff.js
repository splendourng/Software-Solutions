'use strict';

const express = require('express');
const { getPool, withTransaction } = require('../db/pool');
const { ok, fail } = require('../utils/response');
const { authenticate, requirePermission } = require('../middleware/auth');
const { writeAudit, writeActivity } = require('../middleware/audit');
const { pageParams, sanitizeLike, calcAge, pick, isCentralAdmin } = require('../utils/helpers');
const { randomToken, hashPassword } = require('../utils/crypto');
const { generateId, broadcastAuthorized } = require('../utils/services');

const router = express.Router();

const STAFF_SORT = new Set([
  'created_at',
  'updated_at',
  'full_name',
  'staff_number',
  'last_name',
  'first_name',
  'job_title',
  'employment_status',
  'joining_date',
  'status'
]);

function buildFullName(firstName, middleName, lastName) {
  return [firstName, middleName, lastName]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' ');
}

async function loadStaffDetail(pool, staffId) {
  const [rows] = await pool.execute(
    `SELECT s.*,
            d.code AS department_code, d.name AS department_name,
            r.code AS primary_role_code, r.name AS primary_role_name,
            w.code AS ward_code, w.name AS ward_name,
            un.code AS unit_code, un.name AS unit_name
     FROM staff s
     LEFT JOIN departments d ON d.id = s.department_id
     LEFT JOIN roles r ON r.id = s.primary_role_id
     LEFT JOIN wards w ON w.id = s.ward_id
     LEFT JOIN units un ON un.id = s.unit_id
     WHERE s.id = ?
     LIMIT 1`,
    [staffId]
  );
  if (!rows.length) return null;

  const staff = rows[0];
  let user = null;
  let roles = [];
  let departments = [];
  let wards = [];
  let units = [];

  if (staff.user_id) {
    const [users] = await pool.execute(
      `SELECT id, username, email, display_name, staff_id, is_central_admin, system_identity,
              status, must_change_password, last_login_at, created_at, deactivated_at
       FROM users WHERE id = ? LIMIT 1`,
      [staff.user_id]
    );
    user = users[0] || null;
    if (user) {
      const [roleRows] = await pool.execute(
        `SELECT r.id, r.code, r.name, ur.is_primary
         FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = ?`,
        [user.id]
      );
      const [deptRows] = await pool.execute(
        `SELECT d.id, d.code, d.name, ud.is_primary
         FROM user_departments ud JOIN departments d ON d.id = ud.department_id
         WHERE ud.user_id = ?`,
        [user.id]
      );
      const [wardRows] = await pool.execute(
        `SELECT w.id, w.code, w.name, uw.is_primary
         FROM user_wards uw JOIN wards w ON w.id = uw.ward_id
         WHERE uw.user_id = ?`,
        [user.id]
      );
      const [unitRows] = await pool.execute(
        `SELECT un.id, un.code, un.name, uu.is_primary
         FROM user_units uu JOIN units un ON un.id = uu.unit_id
         WHERE uu.user_id = ?`,
        [user.id]
      );
      roles = roleRows;
      departments = deptRows;
      wards = wardRows;
      units = unitRows;
    }
  }

  return {
    staff: {
      ...staff,
      age: calcAge(staff.date_of_birth)
    },
    user,
    roles,
    departments,
    wards,
    units
  };
}

router.get('/', authenticate(true), requirePermission('staff.view'), async (req, res) => {
  try {
    const pool = getPool();
    const { page, limit, offset, search, sort, order } = pageParams(req.query);
    const sortCol = STAFF_SORT.has(sort) ? sort : 'created_at';

    const where = [];
    const params = [];

    if (req.query.status) {
      where.push('s.status = ?');
      params.push(String(req.query.status));
    } else if (req.query.includeInactive !== 'true') {
      where.push('s.status = \'ACTIVE\'');
    }

    if (search) {
      const like = `%${sanitizeLike(search)}%`;
      where.push(`(
        s.full_name LIKE ? OR s.first_name LIKE ? OR s.last_name LIKE ?
        OR s.staff_number LIKE ? OR s.phone LIKE ? OR s.email LIKE ?
        OR s.job_title LIKE ? OR s.license_number LIKE ?
      )`);
      params.push(like, like, like, like, like, like, like, like);
    }
    if (req.query.department_id) {
      where.push('s.department_id = ?');
      params.push(parseInt(req.query.department_id, 10));
    }
    if (req.query.ward_id) {
      where.push('s.ward_id = ?');
      params.push(parseInt(req.query.ward_id, 10));
    }
    if (req.query.unit_id) {
      where.push('s.unit_id = ?');
      params.push(parseInt(req.query.unit_id, 10));
    }
    if (req.query.employment_status) {
      where.push('s.employment_status = ?');
      params.push(String(req.query.employment_status));
    }
    if (req.query.role_id) {
      where.push('s.primary_role_id = ?');
      params.push(parseInt(req.query.role_id, 10));
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM staff s ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await pool.execute(
      `SELECT s.id, s.staff_number, s.user_id, s.first_name, s.middle_name, s.last_name, s.full_name,
              s.sex, s.date_of_birth, s.phone, s.email, s.job_title, s.designation, s.qualification,
              s.license_number, s.employment_status, s.joining_date, s.department_id, s.primary_role_id,
              s.ward_id, s.unit_id, s.status, s.created_at, s.updated_at,
              d.name AS department_name, r.name AS primary_role_name, w.name AS ward_name
       FROM staff s
       LEFT JOIN departments d ON d.id = s.department_id
       LEFT JOIN roles r ON r.id = s.primary_role_id
       LEFT JOIN wards w ON w.id = s.ward_id
       ${whereSql}
       ORDER BY s.${sortCol} ${order}
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    return ok(res, {
      staff: rows.map((s) => ({ ...s, age: calcAge(s.date_of_birth) })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit))
      }
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to list staff', 500, err);
  }
});

router.get('/:id/card', authenticate(true), requirePermission('staff.view', 'staff.card'), async (req, res) => {
  try {
    const staffId = parseInt(req.params.id, 10);
    if (!staffId) return fail(res, 'Invalid staff id', 400);

    const pool = getPool();
    const [staffRows] = await pool.execute(`SELECT id, staff_number, full_name FROM staff WHERE id = ?`, [staffId]);
    if (!staffRows.length) return fail(res, 'Staff not found', 404);

    const [cards] = await pool.execute(
      `SELECT * FROM staff_cards
       WHERE staff_id = ? AND status = 'ACTIVE'
       ORDER BY created_at DESC
       LIMIT 1`,
      [staffId]
    );
    if (!cards.length) return fail(res, 'Staff card not found', 404);
    return ok(res, { card: cards[0], staff: staffRows[0] });
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load staff card', 500, err);
  }
});

router.get('/:id', authenticate(true), requirePermission('staff.view'), async (req, res) => {
  try {
    const staffId = parseInt(req.params.id, 10);
    if (!staffId) return fail(res, 'Invalid staff id', 400);

    const detail = await loadStaffDetail(getPool(), staffId);
    if (!detail) return fail(res, 'Staff not found', 404);

    await writeAudit(req, {
      action: 'STAFF_VIEW',
      entity: 'staff',
      entityId: staffId,
      description: `Viewed staff ${detail.staff.staff_number}`
    });

    return ok(res, detail);
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to load staff', 500, err);
  }
});

router.post('/', authenticate(true), requirePermission('staff.create'), async (req, res) => {
  try {
    const body = req.body || {};
    const first_name = String(body.first_name || '').trim();
    const middle_name = body.middle_name != null ? String(body.middle_name).trim() || null : null;
    const last_name = String(body.last_name || '').trim();

    if (!first_name || !last_name) {
      return fail(res, 'first_name and last_name are required', 400);
    }

    const createUser = body.createUser === true || body.create_user === true;
    const roleId = body.role_id != null ? parseInt(body.role_id, 10) : (body.primary_role_id != null ? parseInt(body.primary_role_id, 10) : null);
    const departmentId = body.department_id != null ? parseInt(body.department_id, 10) : null;
    const wardId = body.ward_id != null ? parseInt(body.ward_id, 10) : null;
    const unitId = body.unit_id != null ? parseInt(body.unit_id, 10) : null;

    const pool = getPool();

    if (roleId) {
      const [roles] = await pool.execute(`SELECT id, code FROM roles WHERE id = ? LIMIT 1`, [roleId]);
      if (!roles.length) return fail(res, 'Role not found', 400);
      if (roles[0].code === 'CENTRAL_ADMIN') {
        return fail(res, 'CENTRAL_ADMIN role cannot be assigned through staff registration', 403);
      }
    }

    if (createUser) {
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) {
        return fail(res, 'username and password are required when createUser is true', 400);
      }
      if (password.length < 10) {
        return fail(res, 'Password must be at least 10 characters', 400);
      }
      const [existingUser] = await pool.execute(
        `SELECT id FROM users WHERE username = ? LIMIT 1`,
        [username]
      );
      if (existingUser.length) return fail(res, 'Username already exists', 409);
      if (!roleId) return fail(res, 'role_id is required when creating a user account', 400);
    }

    if (departmentId) {
      const [deps] = await pool.execute(`SELECT id FROM departments WHERE id = ? AND status = 'ACTIVE'`, [departmentId]);
      if (!deps.length) return fail(res, 'Department not found', 400);
    }
    if (wardId) {
      const [wards] = await pool.execute(`SELECT id FROM wards WHERE id = ? AND status = 'ACTIVE'`, [wardId]);
      if (!wards.length) return fail(res, 'Ward not found', 400);
    }
    if (unitId) {
      const [units] = await pool.execute(`SELECT id FROM units WHERE id = ? AND status = 'ACTIVE'`, [unitId]);
      if (!units.length) return fail(res, 'Unit not found', 400);
    }

    const full_name = buildFullName(first_name, middle_name, last_name);
    let passwordHash = null;
    if (createUser) {
      passwordHash = await hashPassword(String(body.password));
    }

    const result = await withTransaction(async (conn) => {
      const staffNumber = await generateId(conn, 'STAFF');
      const qrToken = randomToken(24);

      const [staffIns] = await conn.execute(
        `INSERT INTO staff
         (staff_number, first_name, middle_name, last_name, full_name, sex, date_of_birth,
          phone, email, address, photo_path, job_title, designation, qualification, license_number,
          employment_status, joining_date, department_id, primary_role_id, ward_id, unit_id,
          supervisor_staff_id, qr_token, status, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        [
          staffNumber,
          first_name,
          middle_name,
          last_name,
          full_name,
          body.sex || null,
          body.date_of_birth || null,
          body.phone || null,
          body.email || null,
          body.address || null,
          body.photo_path || null,
          body.job_title || null,
          body.designation || null,
          body.qualification || null,
          body.license_number || null,
          body.employment_status || 'ACTIVE',
          body.joining_date || null,
          departmentId,
          roleId,
          wardId,
          unitId,
          body.supervisor_staff_id || null,
          qrToken,
          req.user.id,
          req.user.id
        ]
      );
      const staffId = staffIns.insertId;
      let userId = null;
      let createdUser = null;

      if (createUser) {
        const username = String(body.username).trim();
        const displayName = String(body.display_name || full_name).trim();
        const email = body.email || body.user_email || null;

        const [userIns] = await conn.execute(
          `INSERT INTO users
           (username, email, password_hash, display_name, staff_id, is_central_admin, system_identity,
            status, must_change_password, password_changed_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, 0, NULL, 'ACTIVE', ?, NOW(), ?, ?)`,
          [
            username,
            email,
            passwordHash,
            displayName,
            staffId,
            body.must_change_password === false ? 0 : 1,
            req.user.id,
            req.user.id
          ]
        );
        userId = userIns.insertId;
        await conn.execute(`UPDATE staff SET user_id = ? WHERE id = ?`, [userId, staffId]);

        await conn.execute(
          `INSERT INTO user_roles (user_id, role_id, is_primary) VALUES (?, ?, 1)`,
          [userId, roleId]
        );

        if (departmentId) {
          await conn.execute(
            `INSERT INTO user_departments (user_id, department_id, is_primary) VALUES (?, ?, 1)`,
            [userId, departmentId]
          );
        }
        if (wardId) {
          await conn.execute(
            `INSERT INTO user_wards (user_id, ward_id, is_primary) VALUES (?, ?, 1)`,
            [userId, wardId]
          );
        }
        if (unitId) {
          await conn.execute(
            `INSERT INTO user_units (user_id, unit_id, is_primary) VALUES (?, ?, 1)`,
            [userId, unitId]
          );
        }

        const [userRows] = await conn.execute(
          `SELECT id, username, email, display_name, staff_id, is_central_admin, system_identity, status, must_change_password
           FROM users WHERE id = ?`,
          [userId]
        );
        createdUser = userRows[0];
      }

      const [templates] = await conn.execute(
        `SELECT id FROM id_card_templates
         WHERE card_type = 'STAFF' AND is_default = 1 AND status = 'ACTIVE'
         ORDER BY id ASC LIMIT 1`
      );
      const templateId = templates[0]?.id || null;
      const cardNumber = await generateId(conn, 'CARD_STF');
      const cardData = {
        staff_number: staffNumber,
        full_name,
        job_title: body.job_title || null,
        department_id: departmentId,
        qr_token: qrToken
      };
      const [cardIns] = await conn.execute(
        `INSERT INTO staff_cards
         (staff_id, template_id, card_number, issue_date, expiry_date, qr_payload, card_data_json, status, created_by)
         VALUES (?, ?, ?, CURDATE(), NULL, ?, ?, 'ACTIVE', ?)`,
        [staffId, templateId, cardNumber, qrToken, JSON.stringify(cardData), req.user.id]
      );

      const [staffRows] = await conn.execute(`SELECT * FROM staff WHERE id = ?`, [staffId]);
      const [cardRows] = await conn.execute(`SELECT * FROM staff_cards WHERE id = ?`, [cardIns.insertId]);

      return {
        staff: staffRows[0],
        card: cardRows[0],
        user: createdUser
      };
    });

    await writeAudit(req, {
      action: 'STAFF_CREATE',
      entity: 'staff',
      entityId: result.staff.id,
      description: `Registered staff ${result.staff.staff_number}`,
      newValue: {
        id: result.staff.id,
        staff_number: result.staff.staff_number,
        full_name: result.staff.full_name,
        user_id: result.user?.id || null
      },
      severity: 'IMPORTANT'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'STAFF_REGISTRATION',
      title: 'Staff registered',
      details: `${result.staff.full_name} (${result.staff.staff_number})`,
      departmentId: result.staff.department_id || req.user.primary_department?.id || null
    });

    const io = req.app.get('io');
    broadcastAuthorized(io, {
      event: 'staff:created',
      data: {
        id: result.staff.id,
        staff_number: result.staff.staff_number,
        full_name: result.staff.full_name,
        department_id: result.staff.department_id,
        job_title: result.staff.job_title,
        user_id: result.user?.id || null
      },
      userIds: [req.user.id],
      departmentIds: result.staff.department_id ? [result.staff.department_id] : [],
      roles: ['HR_OFFICER', 'HOSPITAL_ADMIN', 'CMD'],
      globalAdmin: true
    });

    return ok(
      res,
      {
        staff: { ...result.staff, age: calcAge(result.staff.date_of_birth) },
        card: result.card,
        user: result.user
      },
      'Staff registered',
      201
    );
  } catch (err) {
    console.error(err);
    if (err && err.code === 'ER_DUP_ENTRY') {
      return fail(res, 'Staff number, username, or unique field already exists', 409, err);
    }
    return fail(res, 'Unable to register staff', 500, err);
  }
});

router.put('/:id', authenticate(true), requirePermission('staff.edit'), async (req, res) => {
  try {
    const staffId = parseInt(req.params.id, 10);
    if (!staffId) return fail(res, 'Invalid staff id', 400);

    const pool = getPool();
    const [existingRows] = await pool.execute(`SELECT * FROM staff WHERE id = ? LIMIT 1`, [staffId]);
    if (!existingRows.length) return fail(res, 'Staff not found', 404);
    const existing = existingRows[0];

    let linkedUser = null;
    if (existing.user_id) {
      const [users] = await pool.execute(`SELECT * FROM users WHERE id = ? LIMIT 1`, [existing.user_id]);
      linkedUser = users[0] || null;
    }

    if (linkedUser && (isCentralAdmin(linkedUser) || linkedUser.system_identity === 'CENTRAL_ADMIN')) {
      return fail(res, 'Cannot modify Central Administrator staff through this route', 403);
    }

    const body = req.body || {};
    const allowed = pick(body, [
      'first_name',
      'middle_name',
      'last_name',
      'sex',
      'date_of_birth',
      'phone',
      'email',
      'address',
      'photo_path',
      'job_title',
      'designation',
      'qualification',
      'license_number',
      'employment_status',
      'joining_date',
      'department_id',
      'primary_role_id',
      'ward_id',
      'unit_id',
      'supervisor_staff_id',
      'status'
    ]);

    if (!Object.keys(allowed).length) return fail(res, 'No updatable fields provided', 400);

    if (allowed.primary_role_id != null) {
      const roleId = parseInt(allowed.primary_role_id, 10);
      const [roles] = await pool.execute(`SELECT id, code FROM roles WHERE id = ? LIMIT 1`, [roleId]);
      if (!roles.length) return fail(res, 'Role not found', 400);
      if (roles[0].code === 'CENTRAL_ADMIN') {
        return fail(res, 'CENTRAL_ADMIN role cannot be assigned through this route', 403);
      }
      allowed.primary_role_id = roleId;
    }

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
    values.push(staffId);

    await withTransaction(async (conn) => {
      await conn.execute(`UPDATE staff SET ${sets} WHERE id = ?`, values);

      if (existing.user_id && allowed.primary_role_id !== undefined) {
        const [ur] = await conn.execute(
          `SELECT id FROM user_roles WHERE user_id = ? AND role_id = ? LIMIT 1`,
          [existing.user_id, allowed.primary_role_id]
        );
        if (!ur.length) {
          await conn.execute(
            `UPDATE user_roles SET is_primary = 0 WHERE user_id = ?`,
            [existing.user_id]
          );
          await conn.execute(
            `INSERT INTO user_roles (user_id, role_id, is_primary) VALUES (?, ?, 1)
             ON DUPLICATE KEY UPDATE is_primary = 1`,
            [existing.user_id, allowed.primary_role_id]
          );
        } else {
          await conn.execute(
            `UPDATE user_roles SET is_primary = 0 WHERE user_id = ?`,
            [existing.user_id]
          );
          await conn.execute(
            `UPDATE user_roles SET is_primary = 1 WHERE user_id = ? AND role_id = ?`,
            [existing.user_id, allowed.primary_role_id]
          );
        }
      }

      if (existing.user_id && allowed.department_id !== undefined && allowed.department_id) {
        await conn.execute(
          `INSERT INTO user_departments (user_id, department_id, is_primary)
           VALUES (?, ?, 1)
           ON DUPLICATE KEY UPDATE is_primary = 1`,
          [existing.user_id, allowed.department_id]
        );
        await conn.execute(
          `UPDATE user_departments SET is_primary = 0
           WHERE user_id = ? AND department_id != ?`,
          [existing.user_id, allowed.department_id]
        );
      }

      if (existing.user_id && allowed.ward_id !== undefined && allowed.ward_id) {
        await conn.execute(
          `INSERT INTO user_wards (user_id, ward_id, is_primary)
           VALUES (?, ?, 1)
           ON DUPLICATE KEY UPDATE is_primary = 1`,
          [existing.user_id, allowed.ward_id]
        );
      }

      if (existing.user_id && allowed.unit_id !== undefined && allowed.unit_id) {
        await conn.execute(
          `INSERT INTO user_units (user_id, unit_id, is_primary)
           VALUES (?, ?, 1)
           ON DUPLICATE KEY UPDATE is_primary = 1`,
          [existing.user_id, allowed.unit_id]
        );
      }
    });

    const [updatedRows] = await pool.execute(`SELECT * FROM staff WHERE id = ?`, [staffId]);
    const updated = updatedRows[0];

    await writeAudit(req, {
      action: 'STAFF_UPDATE',
      entity: 'staff',
      entityId: staffId,
      description: `Updated staff ${updated.staff_number}`,
      oldValue: pick(existing, fields.filter((f) => f !== 'updated_by').concat(['full_name'])),
      newValue: pick(updated, fields.filter((f) => f !== 'updated_by').concat(['full_name'])),
      severity: 'IMPORTANT'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'STAFF_UPDATE',
      title: 'Staff updated',
      details: `${updated.full_name} (${updated.staff_number})`,
      departmentId: updated.department_id || req.user.primary_department?.id || null
    });

    return ok(res, { staff: { ...updated, age: calcAge(updated.date_of_birth) } }, 'Staff updated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to update staff', 500, err);
  }
});

router.post('/:id/deactivate', authenticate(true), requirePermission('staff.edit', 'users.deactivate'), async (req, res) => {
  try {
    const staffId = parseInt(req.params.id, 10);
    if (!staffId) return fail(res, 'Invalid staff id', 400);

    const pool = getPool();
    const [existingRows] = await pool.execute(`SELECT * FROM staff WHERE id = ? LIMIT 1`, [staffId]);
    if (!existingRows.length) return fail(res, 'Staff not found', 404);
    const existing = existingRows[0];

    let linkedUser = null;
    if (existing.user_id) {
      const [users] = await pool.execute(`SELECT * FROM users WHERE id = ? LIMIT 1`, [existing.user_id]);
      linkedUser = users[0] || null;
    }

    if (linkedUser && (isCentralAdmin(linkedUser) || linkedUser.system_identity === 'CENTRAL_ADMIN')) {
      return fail(res, 'Cannot deactivate Central Administrator through this route', 403);
    }

    if (existing.status === 'INACTIVE' && (!linkedUser || linkedUser.status === 'INACTIVE')) {
      return ok(res, {
        staff: existing,
        user: linkedUser
          ? pick(linkedUser, ['id', 'username', 'display_name', 'status', 'deactivated_at'])
          : null
      }, 'Staff already inactive');
    }

    await withTransaction(async (conn) => {
      await conn.execute(
        `UPDATE staff
         SET status = 'INACTIVE',
             employment_status = CASE
               WHEN employment_status = 'ACTIVE' THEN 'INACTIVE'
               ELSE employment_status
             END,
             updated_by = ?
         WHERE id = ?`,
        [req.user.id, staffId]
      );

      if (existing.user_id) {
        await conn.execute(
          `UPDATE users
           SET status = 'INACTIVE',
               deactivated_at = COALESCE(deactivated_at, NOW()),
               updated_by = ?
           WHERE id = ?`,
          [req.user.id, existing.user_id]
        );
        await conn.execute(
          `UPDATE sessions SET revoked_at = NOW()
           WHERE user_id = ? AND revoked_at IS NULL`,
          [existing.user_id]
        );
      }
    });

    const [updatedRows] = await pool.execute(`SELECT * FROM staff WHERE id = ?`, [staffId]);
    let userOut = null;
    if (existing.user_id) {
      const [users] = await pool.execute(
        `SELECT id, username, display_name, status, deactivated_at FROM users WHERE id = ?`,
        [existing.user_id]
      );
      userOut = users[0] || null;
    }

    await writeAudit(req, {
      action: 'STAFF_DEACTIVATE',
      entity: 'staff',
      entityId: staffId,
      description: `Deactivated staff ${existing.staff_number}`,
      oldValue: { status: existing.status, user_status: linkedUser?.status || null },
      newValue: { status: 'INACTIVE', user_status: userOut?.status || null },
      severity: 'IMPORTANT'
    });
    await writeActivity({
      userId: req.user.id,
      activityType: 'STAFF_DEACTIVATE',
      title: 'Staff deactivated',
      details: `${existing.full_name} (${existing.staff_number})`,
      departmentId: existing.department_id || req.user.primary_department?.id || null
    });

    return ok(res, { staff: updatedRows[0], user: userOut }, 'Staff deactivated');
  } catch (err) {
    console.error(err);
    return fail(res, 'Unable to deactivate staff', 500, err);
  }
});

module.exports = router;
