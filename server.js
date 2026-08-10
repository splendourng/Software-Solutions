'use strict';

require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, param, validationResult } = require('express-validator');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const compression = require('compression');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));

const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dbHost: process.env.DB_HOST || '127.0.0.1',
  dbPort: Number(process.env.DB_PORT || 3306),
  dbUser: process.env.DB_USER || 'root',
  dbPassword: process.env.DB_PASSWORD || '',
  dbName: process.env.DB_NAME || 'splendour_ehr',
  jwtSecret: process.env.JWT_SECRET || '',
  accessMinutes: Number(process.env.ACCESS_TOKEN_MINUTES || 15),
  refreshDays: Number(process.env.REFRESH_TOKEN_DAYS || 14),
  uploadDir: path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'private_uploads')),
  maxUpload: Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024),
  secureCookies: process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production',
  origins: (process.env.CORS_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean)
};

let pool;
let server;
let io;
let initialized = false;

const safeDatabaseName = name => {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('DB_NAME may contain only letters, numbers, and underscores');
  return `\`${name}\``;
};
const id = () => crypto.randomUUID();
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => value == null ? null : JSON.stringify(value);
const parseJson = value => {
  if (value == null || typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};
const ok = (res, data, status = 200, meta) => res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
const fail = (res, status, code, message, details) =>
  res.status(status).json({ success: false, error: { code, message, ...(details ? { details } : {}) } });

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 422, 'VALIDATION_ERROR', 'Request validation failed', errors.array());
  next();
};

const schema = [
  `CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) PRIMARY KEY, email VARCHAR(254) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(160) NOT NULL, status ENUM('active','locked','disabled') NOT NULL DEFAULT 'active',
    is_central_owner BOOLEAN NOT NULL DEFAULT FALSE, failed_logins INT NOT NULL DEFAULT 0,
    locked_until DATETIME NULL, last_login_at DATETIME NULL, password_changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_users_status(status)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS departments (
    id CHAR(36) PRIMARY KEY, code VARCHAR(30) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS staff (
    id CHAR(36) PRIMARY KEY, user_id CHAR(36) NULL UNIQUE, staff_no VARCHAR(40) NOT NULL UNIQUE, first_name VARCHAR(80) NOT NULL,
    last_name VARCHAR(80) NOT NULL, phone VARCHAR(40), profession VARCHAR(80), license_no VARCHAR(80), department_id CHAR(36),
    active BOOLEAN NOT NULL DEFAULT TRUE, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_staff_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_staff_department FOREIGN KEY(department_id) REFERENCES departments(id) ON DELETE SET NULL,
    INDEX idx_staff_department(department_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS roles (
    id CHAR(36) PRIMARY KEY, code VARCHAR(60) NOT NULL UNIQUE, name VARCHAR(100) NOT NULL, system_role BOOLEAN NOT NULL DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS permissions (
    id CHAR(36) PRIMARY KEY, code VARCHAR(100) NOT NULL UNIQUE, description VARCHAR(255) NOT NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS role_permissions (
    role_id CHAR(36) NOT NULL, permission_id CHAR(36) NOT NULL, PRIMARY KEY(role_id,permission_id),
    FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE, FOREIGN KEY(permission_id) REFERENCES permissions(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS assignments (
    id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, role_id CHAR(36) NOT NULL,
    scope_type ENUM('global','department','ward','patient') NOT NULL DEFAULT 'global', scope_id CHAR(36) NULL,
    starts_at DATETIME NULL, ends_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE,
    UNIQUE KEY uq_assignment(user_id,role_id,scope_type,scope_id), INDEX idx_assignment_scope(scope_type,scope_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS wards (
    id CHAR(36) PRIMARY KEY, department_id CHAR(36), code VARCHAR(30) NOT NULL UNIQUE, name VARCHAR(100) NOT NULL, active BOOLEAN DEFAULT TRUE,
    FOREIGN KEY(department_id) REFERENCES departments(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS units (
    id CHAR(36) PRIMARY KEY, ward_id CHAR(36) NOT NULL, code VARCHAR(30) NOT NULL, name VARCHAR(100) NOT NULL,
    FOREIGN KEY(ward_id) REFERENCES wards(id) ON DELETE CASCADE, UNIQUE KEY uq_unit(ward_id,code)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS rooms (
    id CHAR(36) PRIMARY KEY, unit_id CHAR(36) NOT NULL, code VARCHAR(30) NOT NULL, room_type VARCHAR(40),
    FOREIGN KEY(unit_id) REFERENCES units(id) ON DELETE CASCADE, UNIQUE KEY uq_room(unit_id,code)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS beds (
    id CHAR(36) PRIMARY KEY, room_id CHAR(36) NOT NULL, code VARCHAR(30) NOT NULL,
    status ENUM('available','occupied','reserved','cleaning','maintenance') NOT NULL DEFAULT 'available',
    FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE, UNIQUE KEY uq_bed(room_id,code), INDEX idx_bed_status(status)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS services (
    id CHAR(36) PRIMARY KEY, department_id CHAR(36), code VARCHAR(40) NOT NULL UNIQUE, name VARCHAR(140) NOT NULL,
    price DECIMAL(12,2) NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE,
    FOREIGN KEY(department_id) REFERENCES departments(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS number_sequences (
    name VARCHAR(60) PRIMARY KEY, prefix VARCHAR(20) NOT NULL, next_value BIGINT UNSIGNED NOT NULL DEFAULT 1,
    padding TINYINT UNSIGNED NOT NULL DEFAULT 6, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS patients (
    id CHAR(36) PRIMARY KEY, medical_record_no VARCHAR(40) NOT NULL UNIQUE, first_name VARCHAR(80) NOT NULL,
    middle_name VARCHAR(80), last_name VARCHAR(80) NOT NULL, date_of_birth DATE, sex_at_birth ENUM('female','male','intersex','unknown') NOT NULL DEFAULT 'unknown',
    gender_identity VARCHAR(80), blood_group VARCHAR(10), phone VARCHAR(40), email VARCHAR(254), address TEXT,
    emergency_contact JSON, deceased_at DATETIME NULL, status ENUM('active','inactive','deceased') NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_patient_name(last_name,first_name), INDEX idx_patient_phone(phone)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS patient_identifiers (
    id CHAR(36) PRIMARY KEY, patient_id CHAR(36) NOT NULL, type VARCHAR(40) NOT NULL, value VARCHAR(120) NOT NULL, issuer VARCHAR(120),
    FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE, UNIQUE KEY uq_identifier(type,value), INDEX idx_identifier_patient(patient_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS patient_cards (
    id CHAR(36) PRIMARY KEY, patient_id CHAR(36) NOT NULL, card_no VARCHAR(50) NOT NULL UNIQUE, issued_at DATETIME NOT NULL,
    expires_at DATETIME NULL, status ENUM('active','lost','expired','revoked') DEFAULT 'active',
    FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS appointments (
    id CHAR(36) PRIMARY KEY, appointment_no VARCHAR(40) NOT NULL UNIQUE, patient_id CHAR(36) NOT NULL, department_id CHAR(36),
    staff_id CHAR(36), service_id CHAR(36), starts_at DATETIME NOT NULL, ends_at DATETIME, reason TEXT,
    status ENUM('scheduled','confirmed','arrived','completed','cancelled','no_show') DEFAULT 'scheduled',
    created_by CHAR(36) NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id), FOREIGN KEY(department_id) REFERENCES departments(id) ON DELETE SET NULL,
    FOREIGN KEY(staff_id) REFERENCES staff(id) ON DELETE SET NULL, FOREIGN KEY(service_id) REFERENCES services(id) ON DELETE SET NULL,
    FOREIGN KEY(created_by) REFERENCES users(id), INDEX idx_appointment_time(starts_at), INDEX idx_appointment_patient(patient_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS encounters (
    id CHAR(36) PRIMARY KEY, encounter_no VARCHAR(40) NOT NULL UNIQUE, patient_id CHAR(36) NOT NULL, appointment_id CHAR(36),
    department_id CHAR(36), attending_staff_id CHAR(36), type ENUM('outpatient','emergency','inpatient','telehealth') NOT NULL,
    status ENUM('planned','active','finished','cancelled') DEFAULT 'active', chief_complaint TEXT, started_at DATETIME NOT NULL,
    ended_at DATETIME, created_by CHAR(36) NOT NULL,
    FOREIGN KEY(patient_id) REFERENCES patients(id), FOREIGN KEY(appointment_id) REFERENCES appointments(id) ON DELETE SET NULL,
    FOREIGN KEY(department_id) REFERENCES departments(id) ON DELETE SET NULL, FOREIGN KEY(attending_staff_id) REFERENCES staff(id) ON DELETE SET NULL,
    FOREIGN KEY(created_by) REFERENCES users(id), INDEX idx_encounter_patient(patient_id,started_at), INDEX idx_encounter_status(status)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS admissions (
    id CHAR(36) PRIMARY KEY, admission_no VARCHAR(40) NOT NULL UNIQUE, encounter_id CHAR(36) NOT NULL UNIQUE, patient_id CHAR(36) NOT NULL,
    ward_id CHAR(36) NOT NULL, bed_id CHAR(36), admitted_at DATETIME NOT NULL, admitted_by CHAR(36) NOT NULL,
    status ENUM('admitted','discharged','cancelled') DEFAULT 'admitted',
    FOREIGN KEY(encounter_id) REFERENCES encounters(id), FOREIGN KEY(patient_id) REFERENCES patients(id),
    FOREIGN KEY(ward_id) REFERENCES wards(id), FOREIGN KEY(bed_id) REFERENCES beds(id) ON DELETE SET NULL, FOREIGN KEY(admitted_by) REFERENCES users(id),
    INDEX idx_admission_status(status,ward_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS transfers (
    id CHAR(36) PRIMARY KEY, admission_id CHAR(36) NOT NULL, from_ward_id CHAR(36), to_ward_id CHAR(36) NOT NULL,
    from_bed_id CHAR(36), to_bed_id CHAR(36), reason TEXT, transferred_at DATETIME NOT NULL, transferred_by CHAR(36) NOT NULL,
    FOREIGN KEY(admission_id) REFERENCES admissions(id), FOREIGN KEY(from_ward_id) REFERENCES wards(id),
    FOREIGN KEY(to_ward_id) REFERENCES wards(id), FOREIGN KEY(from_bed_id) REFERENCES beds(id), FOREIGN KEY(to_bed_id) REFERENCES beds(id),
    FOREIGN KEY(transferred_by) REFERENCES users(id), INDEX idx_transfer_admission(admission_id,transferred_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS discharges (
    id CHAR(36) PRIMARY KEY, admission_id CHAR(36) NOT NULL UNIQUE, disposition VARCHAR(80) NOT NULL, summary TEXT NOT NULL,
    follow_up TEXT, discharged_at DATETIME NOT NULL, discharged_by CHAR(36) NOT NULL,
    FOREIGN KEY(admission_id) REFERENCES admissions(id), FOREIGN KEY(discharged_by) REFERENCES users(id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS vitals (
    id CHAR(36) PRIMARY KEY, patient_id CHAR(36) NOT NULL, encounter_id CHAR(36), recorded_by CHAR(36) NOT NULL,
    recorded_at DATETIME NOT NULL, temperature_c DECIMAL(4,1), pulse_bpm SMALLINT, respiratory_rate SMALLINT,
    systolic SMALLINT, diastolic SMALLINT, spo2 DECIMAL(5,2), weight_kg DECIMAL(7,2), height_cm DECIMAL(7,2),
    pain_score TINYINT, notes VARCHAR(500), FOREIGN KEY(patient_id) REFERENCES patients(id),
    FOREIGN KEY(encounter_id) REFERENCES encounters(id) ON DELETE SET NULL, FOREIGN KEY(recorded_by) REFERENCES users(id),
    INDEX idx_vitals_patient(patient_id,recorded_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS clinical_records (
    id CHAR(36) PRIMARY KEY, patient_id CHAR(36) NOT NULL, encounter_id CHAR(36), type ENUM('clinical_note','diagnosis','allergy','radiology','nursing_note','care_plan') NOT NULL,
    code VARCHAR(80), title VARCHAR(200) NOT NULL, content JSON NOT NULL, clinical_status VARCHAR(40), verification_status VARCHAR(40),
    version INT NOT NULL DEFAULT 1, parent_id CHAR(36), authored_by CHAR(36) NOT NULL, authored_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    amended_at DATETIME, FOREIGN KEY(patient_id) REFERENCES patients(id), FOREIGN KEY(encounter_id) REFERENCES encounters(id) ON DELETE SET NULL,
    FOREIGN KEY(parent_id) REFERENCES clinical_records(id) ON DELETE SET NULL, FOREIGN KEY(authored_by) REFERENCES users(id),
    INDEX idx_clinical_patient(patient_id,type,authored_at), INDEX idx_clinical_parent(parent_id,version)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS lab_catalog (
    id CHAR(36) PRIMARY KEY, code VARCHAR(40) NOT NULL UNIQUE, name VARCHAR(160) NOT NULL, specimen_type VARCHAR(80),
    department_id CHAR(36), reference_ranges JSON, price DECIMAL(12,2) DEFAULT 0, active BOOLEAN DEFAULT TRUE,
    FOREIGN KEY(department_id) REFERENCES departments(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS lab_requests (
    id CHAR(36) PRIMARY KEY, request_no VARCHAR(40) NOT NULL UNIQUE, patient_id CHAR(36) NOT NULL, encounter_id CHAR(36),
    ordered_by CHAR(36) NOT NULL, priority ENUM('routine','urgent','stat') DEFAULT 'routine',
    status ENUM('ordered','collected','received','in_progress','completed','cancelled') DEFAULT 'ordered',
    clinical_info TEXT, ordered_at DATETIME DEFAULT CURRENT_TIMESTAMP, collected_at DATETIME, completed_at DATETIME,
    FOREIGN KEY(patient_id) REFERENCES patients(id), FOREIGN KEY(encounter_id) REFERENCES encounters(id) ON DELETE SET NULL,
    FOREIGN KEY(ordered_by) REFERENCES users(id), INDEX idx_lab_request_patient(patient_id,ordered_at), INDEX idx_lab_status(status)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS lab_request_items (
    id CHAR(36) PRIMARY KEY, request_id CHAR(36) NOT NULL, catalog_id CHAR(36) NOT NULL, status VARCHAR(30) DEFAULT 'ordered',
    FOREIGN KEY(request_id) REFERENCES lab_requests(id) ON DELETE CASCADE, FOREIGN KEY(catalog_id) REFERENCES lab_catalog(id),
    UNIQUE KEY uq_lab_item(request_id,catalog_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS lab_results (
    id CHAR(36) PRIMARY KEY, request_item_id CHAR(36) NOT NULL, analyte VARCHAR(120) NOT NULL, value VARCHAR(255),
    unit VARCHAR(40), reference_range VARCHAR(100), flag VARCHAR(30), result_json JSON, resulted_by CHAR(36) NOT NULL,
    resulted_at DATETIME DEFAULT CURRENT_TIMESTAMP, verified_by CHAR(36), verified_at DATETIME,
    FOREIGN KEY(request_item_id) REFERENCES lab_request_items(id) ON DELETE CASCADE,
    FOREIGN KEY(resulted_by) REFERENCES users(id), FOREIGN KEY(verified_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_result_item(request_item_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS medications (
    id CHAR(36) PRIMARY KEY, code VARCHAR(40) NOT NULL UNIQUE, generic_name VARCHAR(160) NOT NULL, brand_name VARCHAR(160),
    form VARCHAR(60), strength VARCHAR(60), stock_quantity DECIMAL(12,3) DEFAULT 0, reorder_level DECIMAL(12,3) DEFAULT 0,
    unit_price DECIMAL(12,2) DEFAULT 0, active BOOLEAN DEFAULT TRUE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS prescriptions (
    id CHAR(36) PRIMARY KEY, prescription_no VARCHAR(40) NOT NULL UNIQUE, patient_id CHAR(36) NOT NULL, encounter_id CHAR(36),
    prescribed_by CHAR(36) NOT NULL, status ENUM('active','completed','cancelled') DEFAULT 'active', notes TEXT,
    prescribed_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(patient_id) REFERENCES patients(id),
    FOREIGN KEY(encounter_id) REFERENCES encounters(id) ON DELETE SET NULL, FOREIGN KEY(prescribed_by) REFERENCES users(id),
    INDEX idx_prescription_patient(patient_id,prescribed_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS prescription_items (
    id CHAR(36) PRIMARY KEY, prescription_id CHAR(36) NOT NULL, medication_id CHAR(36) NOT NULL, dose VARCHAR(80) NOT NULL,
    route VARCHAR(60) NOT NULL, frequency VARCHAR(80) NOT NULL, duration VARCHAR(80), quantity DECIMAL(12,3) NOT NULL,
    instructions TEXT, FOREIGN KEY(prescription_id) REFERENCES prescriptions(id) ON DELETE CASCADE,
    FOREIGN KEY(medication_id) REFERENCES medications(id), INDEX idx_rx_item_prescription(prescription_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS dispensings (
    id CHAR(36) PRIMARY KEY, prescription_item_id CHAR(36) NOT NULL, quantity DECIMAL(12,3) NOT NULL,
    dispensed_by CHAR(36) NOT NULL, dispensed_at DATETIME DEFAULT CURRENT_TIMESTAMP, batch_no VARCHAR(80),
    FOREIGN KEY(prescription_item_id) REFERENCES prescription_items(id), FOREIGN KEY(dispensed_by) REFERENCES users(id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS medication_administrations (
    id CHAR(36) PRIMARY KEY, prescription_item_id CHAR(36) NOT NULL, patient_id CHAR(36) NOT NULL,
    scheduled_at DATETIME, administered_at DATETIME, status ENUM('given','held','refused','missed') NOT NULL,
    dose_given VARCHAR(80), notes TEXT, administered_by CHAR(36) NOT NULL,
    FOREIGN KEY(prescription_item_id) REFERENCES prescription_items(id), FOREIGN KEY(patient_id) REFERENCES patients(id),
    FOREIGN KEY(administered_by) REFERENCES users(id), INDEX idx_mar_patient(patient_id,administered_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id CHAR(36) PRIMARY KEY, task_no VARCHAR(40) NOT NULL UNIQUE, type VARCHAR(50) NOT NULL DEFAULT 'general',
    title VARCHAR(200) NOT NULL, description TEXT, patient_id CHAR(36), encounter_id CHAR(36), department_id CHAR(36), ward_id CHAR(36),
    assigned_user_id CHAR(36), created_by CHAR(36) NOT NULL, priority ENUM('low','normal','high','urgent') DEFAULT 'normal',
    status ENUM('open','in_progress','blocked','completed','cancelled') DEFAULT 'open', due_at DATETIME, completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
    FOREIGN KEY(encounter_id) REFERENCES encounters(id) ON DELETE CASCADE, FOREIGN KEY(department_id) REFERENCES departments(id) ON DELETE SET NULL,
    FOREIGN KEY(ward_id) REFERENCES wards(id) ON DELETE SET NULL, FOREIGN KEY(assigned_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY(created_by) REFERENCES users(id), INDEX idx_task_assignee(assigned_user_id,status), INDEX idx_task_scope(department_id,ward_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS task_comments (
    id CHAR(36) PRIMARY KEY, task_id CHAR(36) NOT NULL, author_id CHAR(36) NOT NULL, body TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY(author_id) REFERENCES users(id), INDEX idx_comment_task(task_id,created_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS documents (
    id CHAR(36) PRIMARY KEY, patient_id CHAR(36), encounter_id CHAR(36), category VARCHAR(60) NOT NULL, title VARCHAR(200) NOT NULL,
    storage_name VARCHAR(255) NOT NULL UNIQUE, original_name VARCHAR(255) NOT NULL, mime_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT UNSIGNED NOT NULL, checksum_sha256 CHAR(64) NOT NULL, uploaded_by CHAR(36) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
    FOREIGN KEY(encounter_id) REFERENCES encounters(id) ON DELETE SET NULL, FOREIGN KEY(uploaded_by) REFERENCES users(id),
    INDEX idx_document_patient(patient_id,created_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS invoices (
    id CHAR(36) PRIMARY KEY, invoice_no VARCHAR(40) NOT NULL UNIQUE, patient_id CHAR(36) NOT NULL, encounter_id CHAR(36),
    status ENUM('draft','issued','part_paid','paid','void') DEFAULT 'draft', currency CHAR(3) NOT NULL DEFAULT 'NGN',
    subtotal DECIMAL(12,2) NOT NULL DEFAULT 0, discount DECIMAL(12,2) NOT NULL DEFAULT 0, total DECIMAL(12,2) NOT NULL DEFAULT 0,
    created_by CHAR(36) NOT NULL, issued_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id), FOREIGN KEY(encounter_id) REFERENCES encounters(id) ON DELETE SET NULL,
    FOREIGN KEY(created_by) REFERENCES users(id), INDEX idx_invoice_patient(patient_id,status)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS invoice_items (
    id CHAR(36) PRIMARY KEY, invoice_id CHAR(36) NOT NULL, service_id CHAR(36), description VARCHAR(255) NOT NULL,
    quantity DECIMAL(10,2) NOT NULL DEFAULT 1, unit_price DECIMAL(12,2) NOT NULL, amount DECIMAL(12,2) NOT NULL,
    FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE, FOREIGN KEY(service_id) REFERENCES services(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS payments (
    id CHAR(36) PRIMARY KEY, payment_no VARCHAR(40) NOT NULL UNIQUE, invoice_id CHAR(36) NOT NULL, amount DECIMAL(12,2) NOT NULL,
    method ENUM('cash','card','transfer','insurance','other') NOT NULL, reference VARCHAR(120), received_by CHAR(36) NOT NULL,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(invoice_id) REFERENCES invoices(id),
    FOREIGN KEY(received_by) REFERENCES users(id), INDEX idx_payment_invoice(invoice_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, type VARCHAR(60) NOT NULL, title VARCHAR(200) NOT NULL,
    body TEXT, data JSON, read_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, INDEX idx_notification_user(user_id,read_at,created_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id CHAR(36) PRIMARY KEY, department_id CHAR(36), subject VARCHAR(200), created_by CHAR(36) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(department_id) REFERENCES departments(id) ON DELETE CASCADE,
    FOREIGN KEY(created_by) REFERENCES users(id), INDEX idx_conversation_department(department_id,created_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(conversation_id,user_id), FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS messages (
    id CHAR(36) PRIMARY KEY, conversation_id CHAR(36) NOT NULL, sender_id CHAR(36) NOT NULL, body TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY(sender_id) REFERENCES users(id), INDEX idx_message_conversation(conversation_id,created_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS timeline_events (
    id CHAR(36) PRIMARY KEY, patient_id CHAR(36) NOT NULL, encounter_id CHAR(36), event_type VARCHAR(60) NOT NULL,
    source_type VARCHAR(60), source_id CHAR(36), summary VARCHAR(255) NOT NULL, data JSON, occurred_at DATETIME NOT NULL,
    created_by CHAR(36), FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
    FOREIGN KEY(encounter_id) REFERENCES encounters(id) ON DELETE SET NULL, FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_timeline_patient(patient_id,occurred_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, actor_id CHAR(36), action VARCHAR(80) NOT NULL, entity_type VARCHAR(80),
    entity_id VARCHAR(80), patient_id CHAR(36), request_id CHAR(36), ip VARCHAR(64), user_agent VARCHAR(500),
    before_data JSON, after_data JSON, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE SET NULL, INDEX idx_audit_entity(entity_type,entity_id),
    INDEX idx_audit_patient(patient_id,created_at), INDEX idx_audit_actor(actor_id,created_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS login_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id CHAR(36), email VARCHAR(254), success BOOLEAN NOT NULL,
    reason VARCHAR(100), ip VARCHAR(64), user_agent VARCHAR(500), created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL, INDEX idx_login_email(email,created_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS activity_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id CHAR(36), activity VARCHAR(100) NOT NULL, metadata JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_activity_user(user_id,created_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS system_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, level VARCHAR(20) NOT NULL, component VARCHAR(80) NOT NULL,
    message TEXT NOT NULL, metadata JSON, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, INDEX idx_system_level(level,created_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS settings (
    setting_key VARCHAR(120) PRIMARY KEY, value JSON NOT NULL, description VARCHAR(255), updated_by CHAR(36),
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS templates (
    id CHAR(36) PRIMARY KEY, code VARCHAR(80) NOT NULL UNIQUE, type VARCHAR(60) NOT NULL, name VARCHAR(160) NOT NULL,
    body JSON NOT NULL, active BOOLEAN DEFAULT TRUE, created_by CHAR(36) NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY(created_by) REFERENCES users(id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS backup_metadata (
    id CHAR(36) PRIMARY KEY, storage_location VARCHAR(500) NOT NULL, checksum_sha256 CHAR(64), size_bytes BIGINT,
    status ENUM('started','completed','failed','verified') NOT NULL, started_at DATETIME NOT NULL, completed_at DATETIME,
    initiated_by CHAR(36), metadata JSON, FOREIGN KEY(initiated_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, refresh_hash CHAR(64) NOT NULL UNIQUE, expires_at DATETIME NOT NULL,
    revoked_at DATETIME, replaced_by CHAR(36), ip VARCHAR(64), user_agent VARCHAR(500), created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_session_user(user_id,expires_at), INDEX idx_session_expiry(expires_at)
  ) ENGINE=InnoDB`
];

const permissionSeeds = [
  ['patients.read','View patient records'], ['patients.write','Create and update patients'],
  ['clinical.read','View clinical records'], ['clinical.write','Create clinical records'],
  ['appointments.manage','Manage appointments'], ['admissions.manage','Manage admissions and beds'],
  ['labs.manage','Manage laboratory workflow'], ['pharmacy.manage','Manage pharmacy workflow'],
  ['billing.manage','Manage invoices and payments'], ['tasks.manage','Manage tasks'],
  ['documents.manage','Upload and download documents'], ['messages.use','Use department messaging'],
  ['reports.view','View and export reports'], ['admin.users','Manage non-owner users and assignments'],
  ['admin.catalogs','Manage organization catalogs'], ['audit.read','View audit logs']
];

async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function nextNumber(conn, name, defaultPrefix) {
  await conn.execute(
    `INSERT INTO number_sequences(name,prefix,next_value,padding) VALUES(?,?,LAST_INSERT_ID(2),6)
     ON DUPLICATE KEY UPDATE next_value=LAST_INSERT_ID(next_value+1)`,
    [name, defaultPrefix]
  );
  const [[seq], [counter]] = await Promise.all([
    conn.execute('SELECT prefix,padding FROM number_sequences WHERE name=?', [name]).then(([rows]) => rows),
    conn.query('SELECT LAST_INSERT_ID() AS value').then(([rows]) => rows)
  ]);
  return `${seq.prefix}${String(counter.value === 2 ? 1 : counter.value - 1).padStart(seq.padding, '0')}`;
}

function strongPassword(password) {
  return typeof password === 'string' && password.length >= 12 && /[a-z]/.test(password) &&
    /[A-Z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password);
}

async function bootstrapOwner() {
  const [rows] = await pool.query('SELECT id FROM users WHERE is_central_owner=TRUE LIMIT 1');
  if (rows.length) return;
  const email = String(process.env.CENTRAL_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.CENTRAL_ADMIN_PASSWORD;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('CENTRAL_ADMIN_EMAIL is required and must be valid on first run');
  if (!strongPassword(password)) throw new Error('CENTRAL_ADMIN_PASSWORD must be 12+ characters with upper, lower, number, and symbol on first run');
  await transaction(async conn => {
    const ownerId = id();
    const roleId = id();
    await conn.execute(
      'INSERT INTO users(id,email,password_hash,display_name,is_central_owner) VALUES(?,?,?,?,TRUE)',
      [ownerId, email, await bcrypt.hash(password, 12), 'Central Administrator']
    );
    await conn.execute(
      `INSERT INTO roles(id,code,name,system_role) VALUES(?,?,?,TRUE)
       ON DUPLICATE KEY UPDATE name=VALUES(name),system_role=TRUE`,
      [roleId, 'central_administrator', 'Central Administrator']
    );
    const [[role]] = await conn.query('SELECT id FROM roles WHERE code=?', ['central_administrator']);
    await conn.execute(
      `INSERT IGNORE INTO assignments(id,user_id,role_id,scope_type) VALUES(?,?,?,'global')`,
      [id(), ownerId, role.id]
    );
  });
}

async function initializeDatabase() {
  if (initialized) return pool;
  if (!config.jwtSecret || config.jwtSecret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
  const root = await mysql.createConnection({
    host: config.dbHost, port: config.dbPort, user: config.dbUser, password: config.dbPassword,
    charset: 'utf8mb4', multipleStatements: false
  });
  try {
    await root.query(`CREATE DATABASE IF NOT EXISTS ${safeDatabaseName(config.dbName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await root.end();
  }
  pool = mysql.createPool({
    host: config.dbHost, port: config.dbPort, user: config.dbUser, password: config.dbPassword,
    database: config.dbName, charset: 'utf8mb4', connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
    waitForConnections: true, queueLimit: 0, decimalNumbers: true, timezone: 'Z'
  });
  for (const statement of schema) await pool.query(statement);
  for (const [code, description] of permissionSeeds) {
    await pool.execute('INSERT IGNORE INTO permissions(id,code,description) VALUES(?,?,?)', [id(), code, description]);
  }
  await fsp.mkdir(config.uploadDir, { recursive: true, mode: 0o700 });
  await bootstrapOwner();
  initialized = true;
  return pool;
}

function tokenPayload(user) {
  return { sub: user.id, email: user.email, owner: Boolean(user.is_central_owner), type: 'access' };
}
function signAccess(user) {
  return jwt.sign(tokenPayload(user), config.jwtSecret, {
    expiresIn: `${config.accessMinutes}m`, issuer: 'splendour-ehr', audience: 'splendour-ehr-api'
  });
}
function signRefresh(user, sessionId) {
  return jwt.sign({ sub: user.id, sid: sessionId, type: 'refresh' }, config.jwtSecret, {
    expiresIn: `${config.refreshDays}d`, issuer: 'splendour-ehr', audience: 'splendour-ehr-refresh'
  });
}
const cookieOptions = maxAge => ({
  httpOnly: true, secure: config.secureCookies, sameSite: 'strict', path: '/', maxAge
});

async function loadPrincipal(userId) {
  const [users] = await pool.execute(
    'SELECT id,email,display_name,status,is_central_owner FROM users WHERE id=?', [userId]
  );
  if (!users.length || users[0].status !== 'active') return null;
  const [grants] = await pool.execute(
    `SELECT a.scope_type,a.scope_id,r.code AS role_code,p.code AS permission
     FROM assignments a JOIN roles r ON r.id=a.role_id
     LEFT JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN permissions p ON p.id=rp.permission_id
     WHERE a.user_id=? AND (a.starts_at IS NULL OR a.starts_at<=NOW()) AND (a.ends_at IS NULL OR a.ends_at>NOW())`,
    [userId]
  );
  return {
    ...users[0], is_central_owner: Boolean(users[0].is_central_owner),
    permissions: new Set(grants.map(g => g.permission).filter(Boolean)), assignments: grants
  };
}

async function authenticate(req, res, next) {
  try {
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    const token = req.cookies.access_token || bearer;
    if (!token) return fail(res, 401, 'AUTH_REQUIRED', 'Authentication is required');
    const payload = jwt.verify(token, config.jwtSecret, { issuer: 'splendour-ehr', audience: 'splendour-ehr-api' });
    if (payload.type !== 'access') throw new Error('Wrong token type');
    req.user = await loadPrincipal(payload.sub);
    if (!req.user) return fail(res, 401, 'INVALID_SESSION', 'User is unavailable');
    next();
  } catch {
    return fail(res, 401, 'INVALID_TOKEN', 'Authentication token is invalid or expired');
  }
}

const requirePermission = permission => (req, res, next) => {
  if (req.user.is_central_owner || req.user.permissions.has(permission)) return next();
  return fail(res, 403, 'FORBIDDEN', 'Permission denied');
};
const centralOnly = (req, res, next) =>
  req.user.is_central_owner ? next() : fail(res, 403, 'CENTRAL_ONLY', 'Central Administrator access required');

async function hasScope(user, type, scopeId) {
  if (user.is_central_owner || user.assignments.some(a => a.scope_type === 'global')) return true;
  if (user.assignments.some(a => a.scope_type === type && a.scope_id === scopeId)) return true;
  if (type === 'patient') {
    const [rows] = await pool.execute(
      `SELECT 1 FROM encounters e LEFT JOIN admissions a ON a.encounter_id=e.id
       LEFT JOIN wards w ON w.id=a.ward_id WHERE e.patient_id=? AND (
       (e.department_id IS NOT NULL AND EXISTS(SELECT 1 FROM assignments x WHERE x.user_id=? AND x.scope_type='department' AND x.scope_id=e.department_id))
       OR (w.id IS NOT NULL AND EXISTS(SELECT 1 FROM assignments x WHERE x.user_id=? AND x.scope_type='ward' AND x.scope_id=w.id))) LIMIT 1`,
      [scopeId, user.id, user.id]
    );
    return rows.length > 0;
  }
  return false;
}
const enforceScope = (type, source = 'params', key = 'id') => asyncRoute(async (req, res, next) => {
  const scopeId = req[source]?.[key];
  if (scopeId && await hasScope(req.user, type, scopeId)) return next();
  return fail(res, 403, 'SCOPE_DENIED', `${type} scope denied`);
});

async function audit(req, action, entityType, entityId, patientId, beforeData, afterData, conn = pool) {
  await conn.execute(
    `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,patient_id,request_id,ip,user_agent,before_data,after_data)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [req.user?.id || null, action, entityType || null, entityId || null, patientId || null, req.requestId,
      req.ip, String(req.get('user-agent') || '').slice(0, 500), json(beforeData), json(afterData)]
  );
}
async function timeline(conn, req, patientId, encounterId, eventType, sourceType, sourceId, summary, data) {
  await conn.execute(
    `INSERT INTO timeline_events(id,patient_id,encounter_id,event_type,source_type,source_id,summary,data,occurred_at,created_by)
     VALUES(?,?,?,?,?,?,?,?,NOW(),?)`,
    [id(), patientId, encounterId || null, eventType, sourceType, sourceId, summary, json(data), req.user.id]
  );
}
function emitRoom(room, event, data) {
  if (io) io.to(room).emit(event, data);
}

app.use((req, res, next) => {
  req.requestId = String(req.get('x-request-id') || id()).slice(0, 64);
  res.setHeader('x-request-id', req.requestId);
  next();
});
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || config.origins.includes(origin)) return callback(null, true);
    callback(new HttpError(403, 'CORS_DENIED', 'Origin is not allowed'));
  },
  credentials: true, methods: ['GET','POST','PATCH','DELETE']
}));
app.use(compression());
app.use(express.json({ limit: process.env.JSON_LIMIT || '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(cookieParser());
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, limit: Number(process.env.RATE_LIMIT || 500), standardHeaders: 'draft-8',
  legacyHeaders: false, message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } }
}));

app.get('/health', asyncRoute(async (_req, res) => {
  if (!pool) return fail(res, 503, 'NOT_INITIALIZED', 'Database is not initialized');
  await pool.query('SELECT 1');
  ok(res, { status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, standardHeaders: 'draft-8',
  legacyHeaders: false, message: { success: false, error: { code: 'AUTH_RATE_LIMITED', message: 'Too many login attempts' } }
});
app.post('/api/auth/login', authLimiter, [
  body('email').isEmail().normalizeEmail(), body('password').isString().isLength({ min: 1, max: 200 }), validate
], asyncRoute(async (req, res) => {
  const email = req.body.email.toLowerCase();
  const [rows] = await pool.execute('SELECT * FROM users WHERE email=?', [email]);
  const user = rows[0];
  const valid = user && user.status === 'active' && (!user.locked_until || new Date(user.locked_until) <= new Date()) &&
    await bcrypt.compare(req.body.password, user.password_hash);
  await pool.execute(
    'INSERT INTO login_logs(user_id,email,success,reason,ip,user_agent) VALUES(?,?,?,?,?,?)',
    [user?.id || null, email, Boolean(valid), valid ? null : 'invalid_credentials', req.ip, String(req.get('user-agent') || '').slice(0, 500)]
  );
  if (!valid) {
    if (user) await pool.execute(
      `UPDATE users SET failed_logins=failed_logins+1,
       locked_until=IF(failed_logins+1>=5,DATE_ADD(NOW(),INTERVAL 15 MINUTE),locked_until) WHERE id=?`, [user.id]
    );
    return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
  const sessionId = id();
  const refresh = signRefresh(user, sessionId);
  await pool.execute(
    `INSERT INTO sessions(id,user_id,refresh_hash,expires_at,ip,user_agent)
     VALUES(?,?,?,DATE_ADD(NOW(),INTERVAL ? DAY),?,?)`,
    [sessionId, user.id, sha256(refresh), config.refreshDays, req.ip, String(req.get('user-agent') || '').slice(0, 500)]
  );
  await pool.execute('UPDATE users SET failed_logins=0,locked_until=NULL,last_login_at=NOW() WHERE id=?', [user.id]);
  const access = signAccess(user);
  res.cookie('access_token', access, cookieOptions(config.accessMinutes * 60 * 1000));
  res.cookie('refresh_token', refresh, cookieOptions(config.refreshDays * 86400000));
  ok(res, { user: { id: user.id, email: user.email, displayName: user.display_name, isCentralOwner: Boolean(user.is_central_owner) }, accessToken: access });
}));

app.post('/api/auth/refresh', asyncRoute(async (req, res) => {
  const oldToken = req.cookies.refresh_token || req.body.refreshToken;
  if (!oldToken) return fail(res, 401, 'REFRESH_REQUIRED', 'Refresh token is required');
  let payload;
  try {
    payload = jwt.verify(oldToken, config.jwtSecret, { issuer: 'splendour-ehr', audience: 'splendour-ehr-refresh' });
  } catch {
    return fail(res, 401, 'INVALID_REFRESH', 'Refresh token is invalid or expired');
  }
  if (payload.type !== 'refresh') return fail(res, 401, 'INVALID_REFRESH', 'Refresh token is invalid');
  const principal = await loadPrincipal(payload.sub);
  const [sessions] = await pool.execute(
    'SELECT * FROM sessions WHERE id=? AND user_id=? AND refresh_hash=? AND revoked_at IS NULL AND expires_at>NOW()',
    [payload.sid, payload.sub, sha256(oldToken)]
  );
  if (!principal || !sessions.length) {
    await pool.execute('UPDATE sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=?', [payload.sub]);
    return fail(res, 401, 'REFRESH_REUSE', 'Refresh session is unavailable');
  }
  const newSessionId = id();
  const newRefresh = signRefresh(principal, newSessionId);
  await transaction(async conn => {
    await conn.execute('UPDATE sessions SET revoked_at=NOW(),replaced_by=? WHERE id=?', [newSessionId, payload.sid]);
    await conn.execute(
      `INSERT INTO sessions(id,user_id,refresh_hash,expires_at,ip,user_agent)
       VALUES(?,?,?,DATE_ADD(NOW(),INTERVAL ? DAY),?,?)`,
      [newSessionId, principal.id, sha256(newRefresh), config.refreshDays, req.ip, String(req.get('user-agent') || '').slice(0, 500)]
    );
  });
  const access = signAccess(principal);
  res.cookie('access_token', access, cookieOptions(config.accessMinutes * 60000));
  res.cookie('refresh_token', newRefresh, cookieOptions(config.refreshDays * 86400000));
  ok(res, { accessToken: access });
}));

app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  const token = req.cookies.refresh_token;
  if (token) await pool.execute('UPDATE sessions SET revoked_at=NOW() WHERE refresh_hash=? AND revoked_at IS NULL', [sha256(token)]);
  res.clearCookie('access_token', cookieOptions(0));
  res.clearCookie('refresh_token', cookieOptions(0));
  ok(res, { loggedOut: true });
}));

app.use('/api', authenticate);
app.get('/api/auth/me', (req, res) => ok(res, {
  id: req.user.id, email: req.user.email, displayName: req.user.display_name,
  isCentralOwner: req.user.is_central_owner, permissions: [...req.user.permissions],
  assignments: req.user.assignments.map(({ permission, ...a }) => a)
}));

const pageArgs = req => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  return { limit, offset };
};

app.get('/api/patients', requirePermission('patients.read'), asyncRoute(async (req, res) => {
  const { limit, offset } = pageArgs(req);
  const search = String(req.query.search || '').trim();
  const like = `%${search}%`;
  let scopeSql = '';
  const args = [];
  if (!req.user.is_central_owner && !req.user.assignments.some(a => a.scope_type === 'global')) {
    scopeSql = ` AND (EXISTS(SELECT 1 FROM assignments a WHERE a.user_id=? AND a.scope_type='patient' AND a.scope_id=p.id)
      OR EXISTS(SELECT 1 FROM encounters e JOIN assignments a ON a.user_id=? AND
      ((a.scope_type='department' AND a.scope_id=e.department_id) OR (a.scope_type='ward' AND a.scope_id IN
      (SELECT ad.ward_id FROM admissions ad WHERE ad.encounter_id=e.id))) WHERE e.patient_id=p.id))`;
    args.push(req.user.id, req.user.id);
  }
  const [rows] = await pool.query(
    `SELECT p.* FROM patients p WHERE (?='' OR p.medical_record_no LIKE ? OR p.first_name LIKE ? OR p.last_name LIKE ? OR p.phone LIKE ?)
     ${scopeSql} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    [search, like, like, like, like, ...args, limit, offset]
  );
  ok(res, rows, 200, { limit, offset });
}));

app.post('/api/patients', requirePermission('patients.write'), [
  body('firstName').trim().isLength({ min: 1, max: 80 }), body('lastName').trim().isLength({ min: 1, max: 80 }),
  body('dateOfBirth').optional({ nullable: true }).isISO8601(), body('email').optional({ nullable: true }).isEmail(), validate
], asyncRoute(async (req, res) => {
  const patient = await transaction(async conn => {
    const patientId = id();
    const mrn = await nextNumber(conn, 'medical_record', process.env.MRN_PREFIX || 'MRN-');
    await conn.execute(
      `INSERT INTO patients(id,medical_record_no,first_name,middle_name,last_name,date_of_birth,sex_at_birth,gender_identity,blood_group,phone,email,address,emergency_contact)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [patientId, mrn, req.body.firstName, req.body.middleName || null, req.body.lastName, req.body.dateOfBirth || null,
        req.body.sexAtBirth || 'unknown', req.body.genderIdentity || null, req.body.bloodGroup || null, req.body.phone || null,
        req.body.email || null, req.body.address || null, json(req.body.emergencyContact)]
    );
    for (const identifier of req.body.identifiers || []) {
      await conn.execute('INSERT INTO patient_identifiers(id,patient_id,type,value,issuer) VALUES(?,?,?,?,?)',
        [id(), patientId, identifier.type, identifier.value, identifier.issuer || null]);
    }
    await audit(req, 'patient.create', 'patient', patientId, patientId, null, { medicalRecordNo: mrn }, conn);
    await timeline(conn, req, patientId, null, 'registration', 'patient', patientId, 'Patient registered', null);
    return { id: patientId, medicalRecordNo: mrn };
  });
  emitRoom(`patient:${patient.id}`, 'patient:updated', { patientId: patient.id, action: 'created' });
  ok(res, patient, 201);
}));

app.get('/api/patients/:id', requirePermission('patients.read'), param('id').isUUID(), validate,
  enforceScope('patient'), asyncRoute(async (req, res) => {
    const [rows] = await pool.execute(
      `SELECT p.*, (SELECT JSON_ARRAYAGG(JSON_OBJECT('id',i.id,'type',i.type,'value',i.value,'issuer',i.issuer))
       FROM patient_identifiers i WHERE i.patient_id=p.id) identifiers FROM patients p WHERE p.id=?`, [req.params.id]
    );
    if (!rows.length) return fail(res, 404, 'NOT_FOUND', 'Patient not found');
    rows[0].identifiers = parseJson(rows[0].identifiers) || [];
    ok(res, rows[0]);
  }));

app.patch('/api/patients/:id', requirePermission('patients.write'), param('id').isUUID(), validate,
  enforceScope('patient'), asyncRoute(async (req, res) => {
    const allowed = {
      firstName: 'first_name', middleName: 'middle_name', lastName: 'last_name', dateOfBirth: 'date_of_birth',
      sexAtBirth: 'sex_at_birth', genderIdentity: 'gender_identity', bloodGroup: 'blood_group', phone: 'phone',
      email: 'email', address: 'address', emergencyContact: 'emergency_contact', status: 'status'
    };
    const updates = Object.entries(allowed).filter(([key]) => Object.hasOwn(req.body, key));
    if (!updates.length) return fail(res, 422, 'NO_CHANGES', 'No editable fields supplied');
    const [before] = await pool.execute('SELECT * FROM patients WHERE id=?', [req.params.id]);
    if (!before.length) return fail(res, 404, 'NOT_FOUND', 'Patient not found');
    const values = updates.map(([key]) => key === 'emergencyContact' ? json(req.body[key]) : req.body[key]);
    await pool.execute(`UPDATE patients SET ${updates.map(([, col]) => `${col}=?`).join(',')} WHERE id=?`, [...values, req.params.id]);
    await audit(req, 'patient.update', 'patient', req.params.id, req.params.id, before[0], req.body);
    emitRoom(`patient:${req.params.id}`, 'patient:updated', { patientId: req.params.id, action: 'updated' });
    ok(res, { id: req.params.id, updated: true });
  }));

app.get('/api/patients/:id/timeline', requirePermission('clinical.read'), param('id').isUUID(), validate,
  enforceScope('patient'), asyncRoute(async (req, res) => {
    const { limit, offset } = pageArgs(req);
    const [rows] = await pool.execute(
      'SELECT * FROM timeline_events WHERE patient_id=? ORDER BY occurred_at DESC LIMIT ? OFFSET ?',
      [req.params.id, limit, offset]
    );
    ok(res, rows, 200, { limit, offset });
  }));

app.post('/api/appointments', requirePermission('appointments.manage'), [
  body('patientId').isUUID(), body('startsAt').isISO8601(), body('departmentId').optional({ nullable: true }).isUUID(), validate
], enforceScope('patient', 'body', 'patientId'), asyncRoute(async (req, res) => {
  const result = await transaction(async conn => {
    const appointmentId = id();
    const number = await nextNumber(conn, 'appointment', 'APT-');
    await conn.execute(
      `INSERT INTO appointments(id,appointment_no,patient_id,department_id,staff_id,service_id,starts_at,ends_at,reason,status,created_by)
       VALUES(?,?,?,?,?,?,?,?,?,COALESCE(?,'scheduled'),?)`,
      [appointmentId, number, req.body.patientId, req.body.departmentId || null, req.body.staffId || null,
        req.body.serviceId || null, new Date(req.body.startsAt), req.body.endsAt ? new Date(req.body.endsAt) : null,
        req.body.reason || null, req.body.status || null, req.user.id]
    );
    await timeline(conn, req, req.body.patientId, null, 'appointment', 'appointment', appointmentId, `Appointment ${number} scheduled`, null);
    await audit(req, 'appointment.create', 'appointment', appointmentId, req.body.patientId, null, req.body, conn);
    return { id: appointmentId, appointmentNo: number };
  });
  emitRoom(`patient:${req.body.patientId}`, 'appointment:updated', result);
  ok(res, result, 201);
}));

app.patch('/api/appointments/:id/status', requirePermission('appointments.manage'), [
  param('id').isUUID(), body('status').isIn(['scheduled','confirmed','arrived','completed','cancelled','no_show']), validate
], asyncRoute(async (req, res) => {
  const [rows] = await pool.execute('SELECT patient_id FROM appointments WHERE id=?', [req.params.id]);
  if (!rows.length) return fail(res, 404, 'NOT_FOUND', 'Appointment not found');
  if (!await hasScope(req.user, 'patient', rows[0].patient_id)) return fail(res, 403, 'SCOPE_DENIED', 'Patient scope denied');
  await pool.execute('UPDATE appointments SET status=? WHERE id=?', [req.body.status, req.params.id]);
  await audit(req, 'appointment.status', 'appointment', req.params.id, rows[0].patient_id, null, { status: req.body.status });
  emitRoom(`patient:${rows[0].patient_id}`, 'appointment:updated', { id: req.params.id, status: req.body.status });
  ok(res, { id: req.params.id, status: req.body.status });
}));

app.post('/api/encounters', requirePermission('clinical.write'), [
  body('patientId').isUUID(), body('type').isIn(['outpatient','emergency','inpatient','telehealth']), validate
], enforceScope('patient', 'body', 'patientId'), asyncRoute(async (req, res) => {
  const result = await transaction(async conn => {
    const encounterId = id();
    const number = await nextNumber(conn, 'encounter', 'ENC-');
    await conn.execute(
      `INSERT INTO encounters(id,encounter_no,patient_id,appointment_id,department_id,attending_staff_id,type,chief_complaint,started_at,created_by)
       VALUES(?,?,?,?,?,?,?,?,COALESCE(?,NOW()),?)`,
      [encounterId, number, req.body.patientId, req.body.appointmentId || null, req.body.departmentId || null,
        req.body.attendingStaffId || null, req.body.type, req.body.chiefComplaint || null, req.body.startedAt || null, req.user.id]
    );
    await timeline(conn, req, req.body.patientId, encounterId, 'encounter', 'encounter', encounterId, `Encounter ${number} started`, null);
    await audit(req, 'encounter.create', 'encounter', encounterId, req.body.patientId, null, req.body, conn);
    return { id: encounterId, encounterNo: number };
  });
  emitRoom(`patient:${req.body.patientId}`, 'encounter:updated', result);
  ok(res, result, 201);
}));

app.patch('/api/encounters/:id/finish', requirePermission('clinical.write'), param('id').isUUID(), validate,
  asyncRoute(async (req, res) => {
    const [rows] = await pool.execute('SELECT patient_id FROM encounters WHERE id=?', [req.params.id]);
    if (!rows.length) return fail(res, 404, 'NOT_FOUND', 'Encounter not found');
    if (!await hasScope(req.user, 'patient', rows[0].patient_id)) return fail(res, 403, 'SCOPE_DENIED', 'Patient scope denied');
    await pool.execute(`UPDATE encounters SET status='finished',ended_at=COALESCE(?,NOW()) WHERE id=? AND status='active'`,
      [req.body.endedAt || null, req.params.id]);
    await audit(req, 'encounter.finish', 'encounter', req.params.id, rows[0].patient_id, null, req.body);
    ok(res, { id: req.params.id, status: 'finished' });
  }));

app.post('/api/admissions', requirePermission('admissions.manage'), [
  body('encounterId').isUUID(), body('patientId').isUUID(), body('wardId').isUUID(), body('bedId').optional({ nullable: true }).isUUID(), validate
], enforceScope('patient', 'body', 'patientId'), asyncRoute(async (req, res) => {
  const result = await transaction(async conn => {
    if (req.body.bedId) {
      const [locked] = await conn.execute('SELECT status FROM beds WHERE id=? FOR UPDATE', [req.body.bedId]);
      if (!locked.length || locked[0].status !== 'available') throw new HttpError(409, 'BED_UNAVAILABLE', 'Bed is unavailable');
      await conn.execute(`UPDATE beds SET status='occupied' WHERE id=?`, [req.body.bedId]);
    }
    const admissionId = id();
    const number = await nextNumber(conn, 'admission', 'ADM-');
    await conn.execute(
      `INSERT INTO admissions(id,admission_no,encounter_id,patient_id,ward_id,bed_id,admitted_at,admitted_by)
       VALUES(?,?,?,?,?,?,COALESCE(?,NOW()),?)`,
      [admissionId, number, req.body.encounterId, req.body.patientId, req.body.wardId, req.body.bedId || null,
        req.body.admittedAt || null, req.user.id]
    );
    await timeline(conn, req, req.body.patientId, req.body.encounterId, 'admission', 'admission', admissionId, `Admitted as ${number}`, null);
    await audit(req, 'admission.create', 'admission', admissionId, req.body.patientId, null, req.body, conn);
    return { id: admissionId, admissionNo: number };
  });
  emitRoom(`patient:${req.body.patientId}`, 'admission:updated', result);
  emitRoom(`ward:${req.body.wardId}`, 'ward:occupancy', { admissionId: result.id, action: 'admitted' });
  ok(res, result, 201);
}));

app.post('/api/admissions/:id/transfer', requirePermission('admissions.manage'), [
  param('id').isUUID(), body('toWardId').isUUID(), body('toBedId').optional({ nullable: true }).isUUID(), validate
], asyncRoute(async (req, res) => {
  const result = await transaction(async conn => {
    const [admissions] = await conn.execute('SELECT * FROM admissions WHERE id=? AND status=? FOR UPDATE', [req.params.id, 'admitted']);
    if (!admissions.length) throw new HttpError(404, 'NOT_FOUND', 'Active admission not found');
    const admission = admissions[0];
    if (!await hasScope(req.user, 'ward', admission.ward_id) || !await hasScope(req.user, 'ward', req.body.toWardId)) {
      throw new HttpError(403, 'SCOPE_DENIED', 'Ward scope denied');
    }
    if (req.body.toBedId) {
      const [beds] = await conn.execute('SELECT status FROM beds WHERE id=? FOR UPDATE', [req.body.toBedId]);
      if (!beds.length || beds[0].status !== 'available') throw new HttpError(409, 'BED_UNAVAILABLE', 'Destination bed unavailable');
      await conn.execute(`UPDATE beds SET status='occupied' WHERE id=?`, [req.body.toBedId]);
    }
    if (admission.bed_id) await conn.execute(`UPDATE beds SET status='cleaning' WHERE id=?`, [admission.bed_id]);
    const transferId = id();
    await conn.execute(
      `INSERT INTO transfers(id,admission_id,from_ward_id,to_ward_id,from_bed_id,to_bed_id,reason,transferred_at,transferred_by)
       VALUES(?,?,?,?,?,?,?,COALESCE(?,NOW()),?)`,
      [transferId, admission.id, admission.ward_id, req.body.toWardId, admission.bed_id, req.body.toBedId || null,
        req.body.reason || null, req.body.transferredAt || null, req.user.id]
    );
    await conn.execute('UPDATE admissions SET ward_id=?,bed_id=? WHERE id=?', [req.body.toWardId, req.body.toBedId || null, admission.id]);
    await timeline(conn, req, admission.patient_id, admission.encounter_id, 'transfer', 'transfer', transferId, 'Patient transferred', req.body);
    await audit(req, 'admission.transfer', 'admission', admission.id, admission.patient_id, admission, req.body, conn);
    return { id: transferId, patientId: admission.patient_id, fromWardId: admission.ward_id };
  });
  emitRoom(`ward:${result.fromWardId}`, 'ward:occupancy', { admissionId: req.params.id, action: 'transferred-out' });
  emitRoom(`ward:${req.body.toWardId}`, 'ward:occupancy', { admissionId: req.params.id, action: 'transferred-in' });
  emitRoom(`patient:${result.patientId}`, 'admission:updated', { admissionId: req.params.id, action: 'transferred' });
  ok(res, { id: result.id }, 201);
}));

app.post('/api/admissions/:id/discharge', requirePermission('admissions.manage'), [
  param('id').isUUID(), body('disposition').trim().isLength({ min: 1, max: 80 }),
  body('summary').trim().isLength({ min: 1, max: 20000 }), validate
], asyncRoute(async (req, res) => {
  const result = await transaction(async conn => {
    const [rows] = await conn.execute('SELECT * FROM admissions WHERE id=? AND status=? FOR UPDATE', [req.params.id, 'admitted']);
    if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'Active admission not found');
    const admission = rows[0];
    if (!await hasScope(req.user, 'ward', admission.ward_id)) throw new HttpError(403, 'SCOPE_DENIED', 'Ward scope denied');
    const dischargeId = id();
    await conn.execute(
      `INSERT INTO discharges(id,admission_id,disposition,summary,follow_up,discharged_at,discharged_by)
       VALUES(?,?,?,?,?,COALESCE(?,NOW()),?)`,
      [dischargeId, admission.id, req.body.disposition, req.body.summary, req.body.followUp || null, req.body.dischargedAt || null, req.user.id]
    );
    await conn.execute(`UPDATE admissions SET status='discharged' WHERE id=?`, [admission.id]);
    await conn.execute(`UPDATE encounters SET status='finished',ended_at=NOW() WHERE id=? AND status='active'`, [admission.encounter_id]);
    if (admission.bed_id) await conn.execute(`UPDATE beds SET status='cleaning' WHERE id=?`, [admission.bed_id]);
    await timeline(conn, req, admission.patient_id, admission.encounter_id, 'discharge', 'discharge', dischargeId, 'Patient discharged', req.body);
    await audit(req, 'admission.discharge', 'admission', admission.id, admission.patient_id, admission, req.body, conn);
    return { id: dischargeId, patientId: admission.patient_id, wardId: admission.ward_id };
  });
  emitRoom(`patient:${result.patientId}`, 'admission:updated', { admissionId: req.params.id, action: 'discharged' });
  emitRoom(`ward:${result.wardId}`, 'ward:occupancy', { admissionId: req.params.id, action: 'discharged' });
  ok(res, { id: result.id }, 201);
}));

app.post('/api/vitals', requirePermission('clinical.write'), [
  body('patientId').isUUID(), body('painScore').optional().isInt({ min: 0, max: 10 }), validate
], enforceScope('patient', 'body', 'patientId'), asyncRoute(async (req, res) => {
  const vitalId = id();
  const keys = ['temperatureC','pulseBpm','respiratoryRate','systolic','diastolic','spo2','weightKg','heightCm','painScore'];
  if (!keys.some(k => req.body[k] != null)) return fail(res, 422, 'VITALS_EMPTY', 'At least one measurement is required');
  await transaction(async conn => {
    await conn.execute(
      `INSERT INTO vitals(id,patient_id,encounter_id,recorded_by,recorded_at,temperature_c,pulse_bpm,respiratory_rate,systolic,diastolic,spo2,weight_kg,height_cm,pain_score,notes)
       VALUES(?,?,?,?,COALESCE(?,NOW()),?,?,?,?,?,?,?,?,?,?)`,
      [vitalId, req.body.patientId, req.body.encounterId || null, req.user.id, req.body.recordedAt || null,
        req.body.temperatureC ?? null, req.body.pulseBpm ?? null, req.body.respiratoryRate ?? null,
        req.body.systolic ?? null, req.body.diastolic ?? null, req.body.spo2 ?? null, req.body.weightKg ?? null,
        req.body.heightCm ?? null, req.body.painScore ?? null, req.body.notes || null]
    );
    await timeline(conn, req, req.body.patientId, req.body.encounterId, 'vitals', 'vital', vitalId, 'Vitals recorded', null);
    await audit(req, 'vitals.create', 'vital', vitalId, req.body.patientId, null, req.body, conn);
  });
  emitRoom(`patient:${req.body.patientId}`, 'clinical:updated', { type: 'vitals', id: vitalId });
  ok(res, { id: vitalId }, 201);
}));

const clinicalTypes = ['clinical_note','diagnosis','allergy','radiology','nursing_note','care_plan'];
app.get('/api/patients/:id/clinical-records', requirePermission('clinical.read'), param('id').isUUID(), validate,
  enforceScope('patient'), asyncRoute(async (req, res) => {
    const type = req.query.type;
    if (type && !clinicalTypes.includes(type)) return fail(res, 422, 'INVALID_TYPE', 'Invalid clinical record type');
    const [rows] = await pool.execute(
      `SELECT * FROM clinical_records WHERE patient_id=? AND (? IS NULL OR type=?)
       ORDER BY authored_at DESC,version DESC LIMIT 200`, [req.params.id, type || null, type || null]
    );
    rows.forEach(r => { r.content = parseJson(r.content); });
    ok(res, rows);
  }));

app.post('/api/clinical-records', requirePermission('clinical.write'), [
  body('patientId').isUUID(), body('type').isIn(clinicalTypes), body('title').trim().isLength({ min: 1, max: 200 }),
  body('content').isObject(), validate
], enforceScope('patient', 'body', 'patientId'), asyncRoute(async (req, res) => {
  const recordId = id();
  await transaction(async conn => {
    await conn.execute(
      `INSERT INTO clinical_records(id,patient_id,encounter_id,type,code,title,content,clinical_status,verification_status,authored_by)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [recordId, req.body.patientId, req.body.encounterId || null, req.body.type, req.body.code || null,
        req.body.title, json(req.body.content), req.body.clinicalStatus || null, req.body.verificationStatus || null, req.user.id]
    );
    await timeline(conn, req, req.body.patientId, req.body.encounterId, req.body.type, 'clinical_record', recordId, req.body.title, { type: req.body.type });
    await audit(req, 'clinical.create', 'clinical_record', recordId, req.body.patientId, null, req.body, conn);
  });
  emitRoom(`patient:${req.body.patientId}`, 'clinical:updated', { type: req.body.type, id: recordId });
  ok(res, { id: recordId, version: 1 }, 201);
}));

app.post('/api/clinical-records/:id/amend', requirePermission('clinical.write'), [
  param('id').isUUID(), body('content').isObject(), body('title').optional().trim().isLength({ min: 1, max: 200 }), validate
], asyncRoute(async (req, res) => {
  const result = await transaction(async conn => {
    const [rows] = await conn.execute('SELECT * FROM clinical_records WHERE id=? FOR UPDATE', [req.params.id]);
    if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'Clinical record not found');
    const original = rows[0];
    if (!await hasScope(req.user, 'patient', original.patient_id)) throw new HttpError(403, 'SCOPE_DENIED', 'Patient scope denied');
    const rootId = original.parent_id || original.id;
    const [[versionRow]] = await conn.execute(
      'SELECT COALESCE(MAX(version),0)+1 AS next_version FROM clinical_records WHERE id=? OR parent_id=? FOR UPDATE', [rootId, rootId]
    );
    const amendedId = id();
    await conn.execute(
      `INSERT INTO clinical_records(id,patient_id,encounter_id,type,code,title,content,clinical_status,verification_status,version,parent_id,authored_by,amended_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [amendedId, original.patient_id, original.encounter_id, original.type, req.body.code ?? original.code,
        req.body.title || original.title, json(req.body.content), req.body.clinicalStatus ?? original.clinical_status,
        req.body.verificationStatus ?? original.verification_status, versionRow.next_version, rootId, req.user.id]
    );
    await audit(req, 'clinical.amend', 'clinical_record', amendedId, original.patient_id, original, req.body, conn);
    return { id: amendedId, version: versionRow.next_version, patientId: original.patient_id, type: original.type };
  });
  emitRoom(`patient:${result.patientId}`, 'clinical:updated', { type: result.type, id: result.id, version: result.version });
  ok(res, { id: result.id, version: result.version }, 201);
}));

app.post('/api/lab/requests', requirePermission('labs.manage'), [
  body('patientId').isUUID(), body('catalogIds').isArray({ min: 1, max: 100 }), body('catalogIds.*').isUUID(), validate
], enforceScope('patient', 'body', 'patientId'), asyncRoute(async (req, res) => {
  const result = await transaction(async conn => {
    const requestId = id();
    const number = await nextNumber(conn, 'lab_request', 'LAB-');
    await conn.execute(
      `INSERT INTO lab_requests(id,request_no,patient_id,encounter_id,ordered_by,priority,clinical_info)
       VALUES(?,?,?,?,?,?,?)`,
      [requestId, number, req.body.patientId, req.body.encounterId || null, req.user.id,
        req.body.priority || 'routine', req.body.clinicalInfo || null]
    );
    for (const catalogId of [...new Set(req.body.catalogIds)]) {
      await conn.execute('INSERT INTO lab_request_items(id,request_id,catalog_id) VALUES(?,?,?)', [id(), requestId, catalogId]);
    }
    await timeline(conn, req, req.body.patientId, req.body.encounterId, 'lab_request', 'lab_request', requestId, `Lab request ${number}`, null);
    await audit(req, 'lab.order', 'lab_request', requestId, req.body.patientId, null, req.body, conn);
    return { id: requestId, requestNo: number };
  });
  emitRoom(`patient:${req.body.patientId}`, 'lab:updated', result);
  ok(res, result, 201);
}));

app.patch('/api/lab/requests/:id/status', requirePermission('labs.manage'), [
  param('id').isUUID(), body('status').isIn(['collected','received','in_progress','completed','cancelled']), validate
], asyncRoute(async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM lab_requests WHERE id=?', [req.params.id]);
  if (!rows.length) return fail(res, 404, 'NOT_FOUND', 'Lab request not found');
  if (!await hasScope(req.user, 'patient', rows[0].patient_id)) return fail(res, 403, 'SCOPE_DENIED', 'Patient scope denied');
  const extras = req.body.status === 'collected' ? ',collected_at=NOW()' : req.body.status === 'completed' ? ',completed_at=NOW()' : '';
  await pool.execute(`UPDATE lab_requests SET status=?${extras} WHERE id=?`, [req.body.status, req.params.id]);
  await audit(req, 'lab.status', 'lab_request', req.params.id, rows[0].patient_id, rows[0], { status: req.body.status });
  emitRoom(`patient:${rows[0].patient_id}`, 'lab:updated', { id: req.params.id, status: req.body.status });
  ok(res, { id: req.params.id, status: req.body.status });
}));

app.post('/api/lab/items/:id/results', requirePermission('labs.manage'), [
  param('id').isUUID(), body('results').isArray({ min: 1, max: 200 }), body('results.*.analyte').trim().isLength({ min: 1, max: 120 }), validate
], asyncRoute(async (req, res) => {
  const result = await transaction(async conn => {
    const [items] = await conn.execute(
      `SELECT i.id,r.id request_id,r.patient_id FROM lab_request_items i JOIN lab_requests r ON r.id=i.request_id WHERE i.id=? FOR UPDATE`,
      [req.params.id]
    );
    if (!items.length) throw new HttpError(404, 'NOT_FOUND', 'Lab request item not found');
    if (!await hasScope(req.user, 'patient', items[0].patient_id)) throw new HttpError(403, 'SCOPE_DENIED', 'Patient scope denied');
    const ids = [];
    for (const item of req.body.results) {
      const resultId = id();
      ids.push(resultId);
      await conn.execute(
        `INSERT INTO lab_results(id,request_item_id,analyte,value,unit,reference_range,flag,result_json,resulted_by)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [resultId, req.params.id, item.analyte, item.value ?? null, item.unit || null, item.referenceRange || null,
          item.flag || null, json(item.data), req.user.id]
      );
    }
    await conn.execute(`UPDATE lab_request_items SET status='resulted' WHERE id=?`, [req.params.id]);
    await audit(req, 'lab.result', 'lab_request_item', req.params.id, items[0].patient_id, null, req.body, conn);
    return { ids, patientId: items[0].patient_id, requestId: items[0].request_id };
  });
  emitRoom(`patient:${result.patientId}`, 'lab:updated', { id: result.requestId, action: 'resulted' });
  ok(res, { ids: result.ids }, 201);
}));

app.post('/api/lab/results/:id/verify', requirePermission('labs.manage'), param('id').isUUID(), validate,
  asyncRoute(async (req, res) => {
    const [result] = await pool.execute(
      `SELECT lr.id,req.patient_id FROM lab_results lr JOIN lab_request_items i ON i.id=lr.request_item_id
       JOIN lab_requests req ON req.id=i.request_id WHERE lr.id=?`, [req.params.id]
    );
    if (!result.length) return fail(res, 404, 'NOT_FOUND', 'Result not found');
    if (!await hasScope(req.user, 'patient', result[0].patient_id)) return fail(res, 403, 'SCOPE_DENIED', 'Patient scope denied');
    await pool.execute('UPDATE lab_results SET verified_by=?,verified_at=NOW() WHERE id=? AND verified_at IS NULL', [req.user.id, req.params.id]);
    await audit(req, 'lab.verify', 'lab_result', req.params.id, result[0].patient_id);
    ok(res, { id: req.params.id, verified: true });
  }));

app.post('/api/prescriptions', requirePermission('pharmacy.manage'), [
  body('patientId').isUUID(), body('items').isArray({ min: 1, max: 100 }),
  body('items.*.medicationId').isUUID(), body('items.*.quantity').isFloat({ gt: 0 }), validate
], enforceScope('patient', 'body', 'patientId'), asyncRoute(async (req, res) => {
  const result = await transaction(async conn => {
    const prescriptionId = id();
    const number = await nextNumber(conn, 'prescription', 'RX-');
    await conn.execute(
      `INSERT INTO prescriptions(id,prescription_no,patient_id,encounter_id,prescribed_by,notes) VALUES(?,?,?,?,?,?)`,
      [prescriptionId, number, req.body.patientId, req.body.encounterId || null, req.user.id, req.body.notes || null]
    );
    for (const item of req.body.items) {
      await conn.execute(
        `INSERT INTO prescription_items(id,prescription_id,medication_id,dose,route,frequency,duration,quantity,instructions)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [id(), prescriptionId, item.medicationId, item.dose, item.route, item.frequency, item.duration || null,
          item.quantity, item.instructions || null]
      );
    }
    await timeline(conn, req, req.body.patientId, req.body.encounterId, 'prescription', 'prescription', prescriptionId, `Prescription ${number}`, null);
    await audit(req, 'prescription.create', 'prescription', prescriptionId, req.body.patientId, null, req.body, conn);
    return { id: prescriptionId, prescriptionNo: number };
  });
  emitRoom(`patient:${req.body.patientId}`, 'medication:updated', result);
  ok(res, result, 201);
}));

app.post('/api/prescription-items/:id/dispense', requirePermission('pharmacy.manage'), [
  param('id').isUUID(), body('quantity').isFloat({ gt: 0 }), validate
], asyncRoute(async (req, res) => {
  const result = await transaction(async conn => {
    const [items] = await conn.execute(
      `SELECT pi.*,p.patient_id,m.stock_quantity FROM prescription_items pi JOIN prescriptions p ON p.id=pi.prescription_id
       JOIN medications m ON m.id=pi.medication_id WHERE pi.id=? FOR UPDATE`, [req.params.id]
    );
    if (!items.length) throw new HttpError(404, 'NOT_FOUND', 'Prescription item not found');
    const item = items[0];
    if (!await hasScope(req.user, 'patient', item.patient_id)) throw new HttpError(403, 'SCOPE_DENIED', 'Patient scope denied');
    if (Number(item.stock_quantity) < Number(req.body.quantity)) throw new HttpError(409, 'INSUFFICIENT_STOCK', 'Insufficient medication stock');
    const dispensingId = id();
    await conn.execute(
      'INSERT INTO dispensings(id,prescription_item_id,quantity,dispensed_by,batch_no) VALUES(?,?,?,?,?)',
      [dispensingId, item.id, req.body.quantity, req.user.id, req.body.batchNo || null]
    );
    await conn.execute('UPDATE medications SET stock_quantity=stock_quantity-? WHERE id=?', [req.body.quantity, item.medication_id]);
    await audit(req, 'medication.dispense', 'dispensing', dispensingId, item.patient_id, null, req.body, conn);
    return { id: dispensingId, patientId: item.patient_id };
  });
  emitRoom(`patient:${result.patientId}`, 'medication:updated', { id: result.id, action: 'dispensed' });
  ok(res, { id: result.id }, 201);
}));

app.post('/api/mar', requirePermission('clinical.write'), [
  body('prescriptionItemId').isUUID(), body('patientId').isUUID(),
  body('status').isIn(['given','held','refused','missed']), validate
], enforceScope('patient', 'body', 'patientId'), asyncRoute(async (req, res) => {
  const administrationId = id();
  await transaction(async conn => {
    const [items] = await conn.execute(
      `SELECT p.patient_id FROM prescription_items pi JOIN prescriptions p ON p.id=pi.prescription_id
       WHERE pi.id=?`, [req.body.prescriptionItemId]
    );
    if (!items.length || items[0].patient_id !== req.body.patientId) throw new HttpError(422, 'PRESCRIPTION_MISMATCH', 'Prescription does not belong to patient');
    await conn.execute(
      `INSERT INTO medication_administrations(id,prescription_item_id,patient_id,scheduled_at,administered_at,status,dose_given,notes,administered_by)
       VALUES(?,?,?,?,COALESCE(?,NOW()),?,?,?,?)`,
      [administrationId, req.body.prescriptionItemId, req.body.patientId, req.body.scheduledAt || null,
        req.body.administeredAt || null, req.body.status, req.body.doseGiven || null, req.body.notes || null, req.user.id]
    );
    await timeline(conn, req, req.body.patientId, null, 'medication_administration', 'mar', administrationId, `Medication ${req.body.status}`, null);
    await audit(req, 'mar.create', 'medication_administration', administrationId, req.body.patientId, null, req.body, conn);
  });
  emitRoom(`patient:${req.body.patientId}`, 'medication:updated', { id: administrationId, action: req.body.status });
  ok(res, { id: administrationId }, 201);
}));

app.post('/api/tasks', requirePermission('tasks.manage'), [
  body('title').trim().isLength({ min: 1, max: 200 }), body('patientId').optional({ nullable: true }).isUUID(), validate
], asyncRoute(async (req, res) => {
  if (req.body.patientId && !await hasScope(req.user, 'patient', req.body.patientId)) return fail(res, 403, 'SCOPE_DENIED', 'Patient scope denied');
  if (req.body.wardId && !await hasScope(req.user, 'ward', req.body.wardId)) return fail(res, 403, 'SCOPE_DENIED', 'Ward scope denied');
  if (req.body.departmentId && !await hasScope(req.user, 'department', req.body.departmentId)) return fail(res, 403, 'SCOPE_DENIED', 'Department scope denied');
  const result = await transaction(async conn => {
    const taskId = id();
    const number = await nextNumber(conn, 'task', 'TSK-');
    await conn.execute(
      `INSERT INTO tasks(id,task_no,type,title,description,patient_id,encounter_id,department_id,ward_id,assigned_user_id,created_by,priority,due_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [taskId, number, req.body.type || 'general', req.body.title, req.body.description || null,
        req.body.patientId || null, req.body.encounterId || null, req.body.departmentId || null, req.body.wardId || null,
        req.body.assignedUserId || null, req.user.id, req.body.priority || 'normal', req.body.dueAt || null]
    );
    await audit(req, 'task.create', 'task', taskId, req.body.patientId, null, req.body, conn);
    return { id: taskId, taskNo: number };
  });
  if (req.body.assignedUserId) emitRoom(`user:${req.body.assignedUserId}`, 'task:updated', result);
  ok(res, result, 201);
}));

app.patch('/api/tasks/:id/status', requirePermission('tasks.manage'), [
  param('id').isUUID(), body('status').isIn(['open','in_progress','blocked','completed','cancelled']), validate
], asyncRoute(async (req, res) => {
  const [tasks] = await pool.execute('SELECT * FROM tasks WHERE id=?', [req.params.id]);
  if (!tasks.length) return fail(res, 404, 'NOT_FOUND', 'Task not found');
  const task = tasks[0];
  const scoped = task.assigned_user_id === req.user.id ||
    (task.patient_id && await hasScope(req.user, 'patient', task.patient_id)) ||
    (task.ward_id && await hasScope(req.user, 'ward', task.ward_id)) ||
    (task.department_id && await hasScope(req.user, 'department', task.department_id));
  if (!scoped && !req.user.is_central_owner) return fail(res, 403, 'SCOPE_DENIED', 'Task scope denied');
  await pool.execute(
    "UPDATE tasks SET status=?,completed_at=IF(?='completed',NOW(),NULL) WHERE id=?",
    [req.body.status, req.body.status, req.params.id]
  );
  await audit(req, 'task.status', 'task', req.params.id, task.patient_id, task, { status: req.body.status });
  if (task.assigned_user_id) emitRoom(`user:${task.assigned_user_id}`, 'task:updated', { id: task.id, status: req.body.status });
  ok(res, { id: task.id, status: req.body.status });
}));

app.post('/api/tasks/:id/comments', requirePermission('tasks.manage'), [
  param('id').isUUID(), body('body').trim().isLength({ min: 1, max: 10000 }), validate
], asyncRoute(async (req, res) => {
  const [tasks] = await pool.execute('SELECT patient_id,assigned_user_id FROM tasks WHERE id=?', [req.params.id]);
  if (!tasks.length) return fail(res, 404, 'NOT_FOUND', 'Task not found');
  if (tasks[0].patient_id && !await hasScope(req.user, 'patient', tasks[0].patient_id) && tasks[0].assigned_user_id !== req.user.id) {
    return fail(res, 403, 'SCOPE_DENIED', 'Task scope denied');
  }
  const commentId = id();
  await pool.execute('INSERT INTO task_comments(id,task_id,author_id,body) VALUES(?,?,?,?)',
    [commentId, req.params.id, req.user.id, req.body.body]);
  await audit(req, 'task.comment', 'task', req.params.id, tasks[0].patient_id);
  if (tasks[0].assigned_user_id) emitRoom(`user:${tasks[0].assigned_user_id}`, 'task:comment', { taskId: req.params.id, id: commentId });
  ok(res, { id: commentId }, 201);
}));

const allowedMimes = new Set(['application/pdf','image/jpeg','image/png','text/plain']);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.uploadDir),
    filename: (_req, _file, cb) => cb(null, `${id()}.bin`)
  }),
  limits: { fileSize: config.maxUpload, files: 1 },
  fileFilter: (_req, file, cb) => allowedMimes.has(file.mimetype) ? cb(null, true) : cb(new HttpError(415, 'UNSUPPORTED_FILE', 'Unsupported file type'))
});

app.post('/api/documents', requirePermission('documents.manage'), upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return fail(res, 422, 'FILE_REQUIRED', 'A file is required');
  try {
    if (req.body.patientId && !await hasScope(req.user, 'patient', req.body.patientId)) throw new HttpError(403, 'SCOPE_DENIED', 'Patient scope denied');
    const content = await fsp.readFile(req.file.path);
    const documentId = id();
    await pool.execute(
      `INSERT INTO documents(id,patient_id,encounter_id,category,title,storage_name,original_name,mime_type,size_bytes,checksum_sha256,uploaded_by)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [documentId, req.body.patientId || null, req.body.encounterId || null, String(req.body.category || 'general').slice(0, 60),
        String(req.body.title || req.file.originalname).slice(0, 200), req.file.filename,
        path.basename(req.file.originalname).slice(0, 255), req.file.mimetype, req.file.size, sha256(content), req.user.id]
    );
    await audit(req, 'document.upload', 'document', documentId, req.body.patientId || null);
    if (req.body.patientId) emitRoom(`patient:${req.body.patientId}`, 'document:updated', { id: documentId });
    ok(res, { id: documentId }, 201);
  } catch (error) {
    await fsp.unlink(req.file.path).catch(() => {});
    throw error;
  }
}));

app.get('/api/documents/:id/download', requirePermission('documents.manage'), param('id').isUUID(), validate,
  asyncRoute(async (req, res, next) => {
    const [rows] = await pool.execute('SELECT * FROM documents WHERE id=?', [req.params.id]);
    if (!rows.length) return fail(res, 404, 'NOT_FOUND', 'Document not found');
    const doc = rows[0];
    if (doc.patient_id && !await hasScope(req.user, 'patient', doc.patient_id)) return fail(res, 403, 'SCOPE_DENIED', 'Patient scope denied');
    const filePath = path.resolve(config.uploadDir, doc.storage_name);
    if (path.dirname(filePath) !== config.uploadDir || !fs.existsSync(filePath)) return fail(res, 404, 'FILE_MISSING', 'Stored file is unavailable');
    await audit(req, 'document.download', 'document', doc.id, doc.patient_id);
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`);
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(filePath).on('error', next).pipe(res);
  }));

app.post('/api/invoices', requirePermission('billing.manage'), [
  body('patientId').isUUID(), body('items').isArray({ min: 1, max: 200 }),
  body('items.*.description').trim().isLength({ min: 1, max: 255 }),
  body('items.*.quantity').isFloat({ gt: 0 }), body('items.*.unitPrice').isFloat({ min: 0 }), validate
], enforceScope('patient', 'body', 'patientId'), asyncRoute(async (req, res) => {
  const result = await transaction(async conn => {
    const invoiceId = id();
    const number = await nextNumber(conn, 'invoice', 'INV-');
    const subtotal = req.body.items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unitPrice), 0);
    const discount = Math.min(Math.max(Number(req.body.discount) || 0, 0), subtotal);
    await conn.execute(
      `INSERT INTO invoices(id,invoice_no,patient_id,encounter_id,status,currency,subtotal,discount,total,created_by,issued_at)
       VALUES(?,?,?,?,'issued',?,?,?,?,?,NOW())`,
      [invoiceId, number, req.body.patientId, req.body.encounterId || null, req.body.currency || 'NGN',
        subtotal, discount, subtotal - discount, req.user.id]
    );
    for (const item of req.body.items) {
      await conn.execute(
        `INSERT INTO invoice_items(id,invoice_id,service_id,description,quantity,unit_price,amount) VALUES(?,?,?,?,?,?,?)`,
        [id(), invoiceId, item.serviceId || null, item.description, item.quantity, item.unitPrice,
          Number(item.quantity) * Number(item.unitPrice)]
      );
    }
    await audit(req, 'invoice.create', 'invoice', invoiceId, req.body.patientId, null, req.body, conn);
    return { id: invoiceId, invoiceNo: number, total: subtotal - discount };
  });
  emitRoom(`patient:${req.body.patientId}`, 'billing:updated', result);
  ok(res, result, 201);
}));

app.post('/api/invoices/:id/payments', requirePermission('billing.manage'), [
  param('id').isUUID(), body('amount').isFloat({ gt: 0 }), body('method').isIn(['cash','card','transfer','insurance','other']), validate
], asyncRoute(async (req, res) => {
  const result = await transaction(async conn => {
    const [invoices] = await conn.execute(
      `SELECT i.*,COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id=i.id),0) paid FROM invoices i WHERE i.id=? FOR UPDATE`,
      [req.params.id]
    );
    if (!invoices.length) throw new HttpError(404, 'NOT_FOUND', 'Invoice not found');
    const invoice = invoices[0];
    if (!await hasScope(req.user, 'patient', invoice.patient_id)) throw new HttpError(403, 'SCOPE_DENIED', 'Patient scope denied');
    if (invoice.status === 'void' || Number(req.body.amount) > Number(invoice.total) - Number(invoice.paid)) {
      throw new HttpError(409, 'INVALID_PAYMENT', 'Payment exceeds outstanding balance or invoice is void');
    }
    const paymentId = id();
    const number = await nextNumber(conn, 'payment', 'PAY-');
    await conn.execute(
      `INSERT INTO payments(id,payment_no,invoice_id,amount,method,reference,received_by) VALUES(?,?,?,?,?,?,?)`,
      [paymentId, number, invoice.id, req.body.amount, req.body.method, req.body.reference || null, req.user.id]
    );
    const fullyPaid = Number(invoice.paid) + Number(req.body.amount) >= Number(invoice.total);
    await conn.execute(`UPDATE invoices SET status=? WHERE id=?`, [fullyPaid ? 'paid' : 'part_paid', invoice.id]);
    await audit(req, 'payment.create', 'payment', paymentId, invoice.patient_id, null, req.body, conn);
    return { id: paymentId, paymentNo: number, invoiceId: invoice.id, patientId: invoice.patient_id, status: fullyPaid ? 'paid' : 'part_paid' };
  });
  emitRoom(`patient:${result.patientId}`, 'billing:updated', { invoiceId: result.invoiceId, status: result.status });
  ok(res, { id: result.id, paymentNo: result.paymentNo }, 201);
}));

app.get('/api/notifications', asyncRoute(async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100', [req.user.id]);
  rows.forEach(row => { row.data = parseJson(row.data); });
  ok(res, rows);
}));
app.patch('/api/notifications/:id/read', param('id').isUUID(), validate, asyncRoute(async (req, res) => {
  await pool.execute('UPDATE notifications SET read_at=COALESCE(read_at,NOW()) WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  ok(res, { id: req.params.id, read: true });
}));

app.post('/api/conversations', requirePermission('messages.use'), [
  body('subject').optional().trim().isLength({ max: 200 }), body('departmentId').optional({ nullable: true }).isUUID(),
  body('memberIds').optional().isArray({ max: 100 }), validate
], asyncRoute(async (req, res) => {
  if (req.body.departmentId && !await hasScope(req.user, 'department', req.body.departmentId)) return fail(res, 403, 'SCOPE_DENIED', 'Department scope denied');
  const conversationId = await transaction(async conn => {
    const conversationId = id();
    await conn.execute('INSERT INTO conversations(id,department_id,subject,created_by) VALUES(?,?,?,?)',
      [conversationId, req.body.departmentId || null, req.body.subject || null, req.user.id]);
    for (const memberId of new Set([req.user.id, ...(req.body.memberIds || [])])) {
      await conn.execute('INSERT INTO conversation_members(conversation_id,user_id) VALUES(?,?)', [conversationId, memberId]);
    }
    await audit(req, 'conversation.create', 'conversation', conversationId, null, null, req.body, conn);
    return conversationId;
  });
  ok(res, { id: conversationId }, 201);
}));

app.get('/api/conversations/:id/messages', requirePermission('messages.use'), param('id').isUUID(), validate,
  asyncRoute(async (req, res) => {
    const [member] = await pool.execute('SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!member.length) return fail(res, 403, 'FORBIDDEN', 'Conversation membership required');
    const [rows] = await pool.execute(
      `SELECT m.*,u.display_name sender_name FROM messages m JOIN users u ON u.id=m.sender_id
       WHERE m.conversation_id=? ORDER BY m.created_at ASC LIMIT 500`, [req.params.id]
    );
    ok(res, rows);
  }));

app.post('/api/conversations/:id/messages', requirePermission('messages.use'), [
  param('id').isUUID(), body('body').trim().isLength({ min: 1, max: 10000 }), validate
], asyncRoute(async (req, res) => {
  const [member] = await pool.execute('SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?', [req.params.id, req.user.id]);
  if (!member.length) return fail(res, 403, 'FORBIDDEN', 'Conversation membership required');
  const messageId = id();
  await pool.execute('INSERT INTO messages(id,conversation_id,sender_id,body) VALUES(?,?,?,?)',
    [messageId, req.params.id, req.user.id, req.body.body]);
  await audit(req, 'message.create', 'message', messageId);
  emitRoom(`conversation:${req.params.id}`, 'message:new', {
    id: messageId, conversationId: req.params.id, senderId: req.user.id, body: req.body.body, createdAt: new Date().toISOString()
  });
  ok(res, { id: messageId }, 201);
}));

app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const global = req.user.is_central_owner || req.user.assignments.some(a => a.scope_type === 'global');
  const departmentIds = req.user.assignments.filter(a => a.scope_type === 'department').map(a => a.scope_id);
  const wardIds = req.user.assignments.filter(a => a.scope_type === 'ward').map(a => a.scope_id);
  const [tasks] = await pool.execute(
    `SELECT COUNT(*) count FROM tasks WHERE status IN ('open','in_progress','blocked') AND
     (assigned_user_id=? ${global ? 'OR 1=1' : ''})`, [req.user.id]
  );
  let appointments = [{ count: 0 }];
  if (global) {
    [appointments] = await pool.query(`SELECT COUNT(*) count FROM appointments WHERE starts_at>=CURDATE() AND starts_at<DATE_ADD(CURDATE(),INTERVAL 1 DAY)`);
  } else if (departmentIds.length) {
    [appointments] = await pool.query(
      `SELECT COUNT(*) count FROM appointments WHERE starts_at>=CURDATE() AND starts_at<DATE_ADD(CURDATE(),INTERVAL 1 DAY)
       AND department_id IN (?)`, [departmentIds]
    );
  }
  let occupancy = [];
  if (global) {
    [occupancy] = await pool.query(`SELECT w.id,w.name,COUNT(a.id) occupied FROM wards w LEFT JOIN admissions a ON a.ward_id=w.id AND a.status='admitted' GROUP BY w.id,w.name`);
  } else if (wardIds.length) {
    [occupancy] = await pool.query(
      `SELECT w.id,w.name,COUNT(a.id) occupied FROM wards w LEFT JOIN admissions a ON a.ward_id=w.id AND a.status='admitted'
       WHERE w.id IN (?) GROUP BY w.id,w.name`, [wardIds]
    );
  }
  ok(res, { openTasks: tasks[0].count, todaysAppointments: appointments[0].count, wardOccupancy: occupancy });
}));

const worklistDefinitions = {
  appointments: {
    permission: 'appointments.manage',
    sql: `SELECT a.*,p.medical_record_no,CONCAT(p.first_name,' ',p.last_name) patient_name
      FROM appointments a JOIN patients p ON p.id=a.patient_id`,
    patient: 'patient_id', department: 'department_id', order: 'starts_at DESC'
  },
  encounters: {
    permission: 'clinical.read',
    sql: `SELECT e.*,p.medical_record_no,CONCAT(p.first_name,' ',p.last_name) patient_name
      FROM encounters e JOIN patients p ON p.id=e.patient_id`,
    patient: 'patient_id', department: 'department_id', order: 'started_at DESC'
  },
  admissions: {
    permission: 'admissions.manage',
    sql: `SELECT a.*,p.medical_record_no,CONCAT(p.first_name,' ',p.last_name) patient_name,w.name ward_name,
      b.code bed_code FROM admissions a JOIN patients p ON p.id=a.patient_id JOIN wards w ON w.id=a.ward_id
      LEFT JOIN beds b ON b.id=a.bed_id`,
    patient: 'patient_id', ward: 'ward_id', order: 'admitted_at DESC'
  },
  labs: {
    permission: 'labs.manage',
    sql: `SELECT r.*,p.medical_record_no,CONCAT(p.first_name,' ',p.last_name) patient_name,
      (SELECT COUNT(*) FROM lab_request_items i WHERE i.request_id=r.id) item_count
      FROM lab_requests r JOIN patients p ON p.id=r.patient_id`,
    patient: 'patient_id', order: 'ordered_at DESC'
  },
  prescriptions: {
    permission: 'pharmacy.manage',
    sql: `SELECT r.*,p.medical_record_no,CONCAT(p.first_name,' ',p.last_name) patient_name,
      (SELECT COUNT(*) FROM prescription_items i WHERE i.prescription_id=r.id) item_count
      FROM prescriptions r JOIN patients p ON p.id=r.patient_id`,
    patient: 'patient_id', order: 'prescribed_at DESC'
  },
  invoices: {
    permission: 'billing.manage',
    sql: `SELECT i.*,p.medical_record_no,CONCAT(p.first_name,' ',p.last_name) patient_name,
      COALESCE((SELECT SUM(amount) FROM payments x WHERE x.invoice_id=i.id),0) paid
      FROM invoices i JOIN patients p ON p.id=i.patient_id`,
    patient: 'patient_id', order: 'created_at DESC'
  },
  tasks: {
    permission: 'tasks.manage',
    sql: `SELECT t.*,u.display_name assigned_user_name FROM tasks t
      LEFT JOIN users u ON u.id=t.assigned_user_id`,
    patient: 'patient_id', department: 'department_id', ward: 'ward_id', assigned: 'assigned_user_id', order: 'created_at DESC'
  },
  vitals: {
    permission: 'clinical.read',
    sql: `SELECT v.*,u.display_name recorded_by_name FROM vitals v JOIN users u ON u.id=v.recorded_by`,
    patient: 'patient_id', order: 'recorded_at DESC'
  }
};

app.get('/api/worklists/:resource', param('resource').custom(value => Boolean(worklistDefinitions[value])), validate,
  asyncRoute(async (req, res) => {
    const def = worklistDefinitions[req.params.resource];
    if (!req.user.is_central_owner && !req.user.permissions.has(def.permission)) {
      return fail(res, 403, 'FORBIDDEN', 'Permission denied');
    }
    const { limit, offset } = pageArgs(req);
    const status = req.query.status ? String(req.query.status).slice(0, 30) : null;
    const patientId = req.query.patientId ? String(req.query.patientId) : null;
    if (status && req.params.resource === 'vitals') return fail(res, 422, 'INVALID_FILTER', 'Vitals do not have a status');
    if (patientId && !/^[0-9a-f-]{36}$/i.test(patientId)) return fail(res, 422, 'INVALID_PATIENT', 'Invalid patient ID');
    if (patientId && !await hasScope(req.user, 'patient', patientId)) return fail(res, 403, 'SCOPE_DENIED', 'Patient scope denied');
    const filters = [];
    const args = [];
    if (status) {
      filters.push(`${req.params.resource === 'labs' ? 'r' : req.params.resource === 'prescriptions' ? 'r' :
        req.params.resource === 'tasks' ? 't' : req.params.resource === 'appointments' ? 'a' :
        req.params.resource === 'encounters' ? 'e' : req.params.resource === 'admissions' ? 'a' :
        req.params.resource === 'invoices' ? 'i' : 'v'}.status=?`);
      args.push(status);
    }
    if (patientId && def.patient) {
      const alias = req.params.resource === 'tasks' ? 't' : req.params.resource === 'appointments' ? 'a' :
        req.params.resource === 'encounters' ? 'e' : req.params.resource === 'admissions' ? 'a' :
        req.params.resource === 'invoices' ? 'i' : req.params.resource === 'vitals' ? 'v' : 'r';
      filters.push(`${alias}.${def.patient}=?`);
      args.push(patientId);
    }
    const [candidates] = await pool.query(
      `${def.sql}${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''}${def.group ? ` GROUP BY ${def.group}` : ''}
       ORDER BY ${def.order} LIMIT 500`, args
    );
    const visible = [];
    for (const row of candidates) {
      const permitted = req.user.is_central_owner ||
        (def.assigned && row[def.assigned] === req.user.id) ||
        (def.patient && row[def.patient] && await hasScope(req.user, 'patient', row[def.patient])) ||
        (def.ward && row[def.ward] && await hasScope(req.user, 'ward', row[def.ward])) ||
        (def.department && row[def.department] && await hasScope(req.user, 'department', row[def.department]));
      if (permitted) visible.push(row);
    }
    ok(res, visible.slice(offset, offset + limit), 200, { limit, offset, available: visible.length });
  }));

const catalogDefinitions = {
  staff: { table: 'staff', fields: ['user_id','staff_no','first_name','last_name','phone','profession','license_no','department_id','active'], permission: 'admin.users' },
  departments: { table: 'departments', fields: ['code','name','active'], permission: 'admin.catalogs' },
  wards: { table: 'wards', fields: ['department_id','code','name','active'], permission: 'admin.catalogs' },
  units: { table: 'units', fields: ['ward_id','code','name'], permission: 'admin.catalogs' },
  rooms: { table: 'rooms', fields: ['unit_id','code','room_type'], permission: 'admin.catalogs' },
  beds: { table: 'beds', fields: ['room_id','code','status'], permission: 'admin.catalogs' },
  services: { table: 'services', fields: ['department_id','code','name','price','active'], permission: 'admin.catalogs' },
  'lab-catalog': { table: 'lab_catalog', fields: ['code','name','specimen_type','department_id','reference_ranges','price','active'], permission: 'labs.manage' },
  medications: { table: 'medications', fields: ['code','generic_name','brand_name','form','strength','stock_quantity','reorder_level','unit_price','active'], permission: 'pharmacy.manage' }
};
app.get('/api/catalogs/:resource', param('resource').custom(v => Boolean(catalogDefinitions[v])), validate,
  asyncRoute(async (req, res) => {
    const def = catalogDefinitions[req.params.resource];
    if (!req.user.is_central_owner && !req.user.permissions.has(def.permission)) return fail(res, 403, 'FORBIDDEN', 'Permission denied');
    const [rows] = await pool.query(`SELECT * FROM ${def.table} ORDER BY ${def.fields.includes('name') ? 'name' : def.fields[0]} LIMIT 1000`);
    ok(res, rows);
  }));
app.post('/api/catalogs/:resource', param('resource').custom(v => Boolean(catalogDefinitions[v])), validate,
  asyncRoute(async (req, res) => {
    const def = catalogDefinitions[req.params.resource];
    if (!req.user.is_central_owner && !req.user.permissions.has(def.permission)) return fail(res, 403, 'FORBIDDEN', 'Permission denied');
    const supplied = def.fields.filter(field => Object.hasOwn(req.body, field));
    if (!supplied.length) return fail(res, 422, 'NO_FIELDS', 'No valid catalog fields supplied');
    const recordId = id();
    const values = supplied.map(field => field === 'reference_ranges' ? json(req.body[field]) : req.body[field]);
    await pool.execute(
      `INSERT INTO ${def.table}(id,${supplied.join(',')}) VALUES(?,${supplied.map(() => '?').join(',')})`,
      [recordId, ...values]
    );
    await audit(req, 'catalog.create', def.table, recordId, null, null, req.body);
    ok(res, { id: recordId }, 201);
  }));

app.get('/api/admin/users', requirePermission('admin.users'), asyncRoute(async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT u.id,u.email,u.display_name,u.status,u.last_login_at,u.created_at,
     JSON_ARRAYAGG(JSON_OBJECT('id',a.id,'role',r.code,'scopeType',a.scope_type,'scopeId',a.scope_id)) assignments
     FROM users u LEFT JOIN assignments a ON a.user_id=u.id LEFT JOIN roles r ON r.id=a.role_id
     WHERE u.is_central_owner=FALSE GROUP BY u.id ORDER BY u.created_at DESC`
  );
  rows.forEach(row => { row.assignments = parseJson(row.assignments) || []; });
  ok(res, rows);
}));

app.post('/api/admin/users', requirePermission('admin.users'), [
  body('email').isEmail().normalizeEmail(), body('displayName').trim().isLength({ min: 1, max: 160 }),
  body('password').custom(strongPassword).withMessage('Password must be 12+ characters with upper, lower, number, and symbol'), validate
], asyncRoute(async (req, res) => {
  const userId = id();
  await pool.execute(
    `INSERT INTO users(id,email,password_hash,display_name,is_central_owner) VALUES(?,?,?,?,FALSE)`,
    [userId, req.body.email.toLowerCase(), await bcrypt.hash(req.body.password, 12), req.body.displayName]
  );
  await audit(req, 'user.create', 'user', userId, null, null, { email: req.body.email, displayName: req.body.displayName });
  ok(res, { id: userId }, 201);
}));

app.patch('/api/admin/users/:id/status', requirePermission('admin.users'), [
  param('id').isUUID(), body('status').isIn(['active','locked','disabled']), validate
], asyncRoute(async (req, res) => {
  const [result] = await pool.execute(
    'UPDATE users SET status=?,locked_until=NULL WHERE id=? AND is_central_owner=FALSE',
    [req.body.status, req.params.id]
  );
  if (!result.affectedRows) return fail(res, 404, 'NOT_FOUND', 'Non-owner user not found');
  if (req.body.status !== 'active') await pool.execute('UPDATE sessions SET revoked_at=NOW() WHERE user_id=? AND revoked_at IS NULL', [req.params.id]);
  await audit(req, 'user.status', 'user', req.params.id, null, null, { status: req.body.status });
  ok(res, { id: req.params.id, status: req.body.status });
}));

app.post('/api/admin/assignments', requirePermission('admin.users'), [
  body('userId').isUUID(), body('roleId').isUUID(), body('scopeType').isIn(['global','department','ward','patient']),
  body('scopeId').optional({ nullable: true }).isUUID(), validate
], asyncRoute(async (req, res) => {
  const [users] = await pool.execute('SELECT is_central_owner FROM users WHERE id=?', [req.body.userId]);
  const [roles] = await pool.execute('SELECT code FROM roles WHERE id=?', [req.body.roleId]);
  if (!users.length || users[0].is_central_owner || !roles.length || roles[0].code === 'central_administrator') {
    return fail(res, 403, 'OWNER_PROTECTED', 'Owner role and account assignments are immutable through the API');
  }
  if (req.body.scopeType !== 'global' && !req.body.scopeId) return fail(res, 422, 'SCOPE_REQUIRED', 'scopeId is required');
  const assignmentId = id();
  await pool.execute(
    `INSERT INTO assignments(id,user_id,role_id,scope_type,scope_id,starts_at,ends_at) VALUES(?,?,?,?,?,?,?)`,
    [assignmentId, req.body.userId, req.body.roleId, req.body.scopeType, req.body.scopeId || null,
      req.body.startsAt || null, req.body.endsAt || null]
  );
  await audit(req, 'assignment.create', 'assignment', assignmentId, req.body.scopeType === 'patient' ? req.body.scopeId : null, null, req.body);
  ok(res, { id: assignmentId }, 201);
}));

app.get('/api/admin/roles', requirePermission('admin.users'), asyncRoute(async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT r.id,r.code,r.name,r.system_role,JSON_ARRAYAGG(p.code) permissions FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN permissions p ON p.id=rp.permission_id
     WHERE r.code<>'central_administrator' GROUP BY r.id ORDER BY r.name`
  );
  rows.forEach(row => { row.permissions = (parseJson(row.permissions) || []).filter(Boolean); });
  ok(res, rows);
}));
app.post('/api/admin/roles', requirePermission('admin.users'), [
  body('code').matches(/^[a-z][a-z0-9_.-]{2,59}$/), body('name').trim().isLength({ min: 1, max: 100 }),
  body('permissions').isArray({ min: 1 }), validate
], asyncRoute(async (req, res) => {
  if (req.body.code === 'central_administrator') return fail(res, 403, 'OWNER_PROTECTED', 'Reserved role');
  const roleId = await transaction(async conn => {
    const roleId = id();
    await conn.execute('INSERT INTO roles(id,code,name,system_role) VALUES(?,?,?,FALSE)', [roleId, req.body.code, req.body.name]);
    const [permissions] = await conn.query('SELECT id,code FROM permissions WHERE code IN (?)', [req.body.permissions]);
    if (permissions.length !== new Set(req.body.permissions).size) throw new HttpError(422, 'INVALID_PERMISSION', 'Unknown permission supplied');
    for (const permission of permissions) await conn.execute('INSERT INTO role_permissions(role_id,permission_id) VALUES(?,?)', [roleId, permission.id]);
    await audit(req, 'role.create', 'role', roleId, null, null, req.body, conn);
    return roleId;
  });
  ok(res, { id: roleId }, 201);
}));

app.get('/api/templates', requirePermission('admin.catalogs'), asyncRoute(async (_req, res) => {
  const [rows] = await pool.query('SELECT id,code,type,name,body,active,updated_at FROM templates ORDER BY type,name');
  rows.forEach(row => { row.body = parseJson(row.body); });
  ok(res, rows);
}));
app.post('/api/templates', requirePermission('admin.catalogs'), [
  body('code').matches(/^[A-Za-z0-9_.-]{2,80}$/), body('type').trim().isLength({ min: 1, max: 60 }),
  body('name').trim().isLength({ min: 1, max: 160 }), body('body').isObject(), validate
], asyncRoute(async (req, res) => {
  const templateId = id();
  await pool.execute(
    'INSERT INTO templates(id,code,type,name,body,active,created_by) VALUES(?,?,?,?,?,?,?)',
    [templateId, req.body.code, req.body.type, req.body.name, json(req.body.body), req.body.active !== false, req.user.id]
  );
  await audit(req, 'template.create', 'template', templateId, null, null, req.body);
  ok(res, { id: templateId }, 201);
}));

app.get('/api/backups', centralOnly, asyncRoute(async (_req, res) => {
  const [rows] = await pool.query(
    'SELECT id,storage_location,checksum_sha256,size_bytes,status,started_at,completed_at,metadata FROM backup_metadata ORDER BY started_at DESC LIMIT 200'
  );
  rows.forEach(row => { row.metadata = parseJson(row.metadata); });
  ok(res, rows);
}));
app.post('/api/backups/metadata', centralOnly, [
  body('storageLocation').trim().isLength({ min: 1, max: 500 }),
  body('status').isIn(['started','completed','failed','verified']), validate
], asyncRoute(async (req, res) => {
  const backupId = id();
  await pool.execute(
    `INSERT INTO backup_metadata(id,storage_location,checksum_sha256,size_bytes,status,started_at,completed_at,initiated_by,metadata)
     VALUES(?,?,?,?,?,COALESCE(?,NOW()),?,?,?)`,
    [backupId, req.body.storageLocation, req.body.checksumSha256 || null, req.body.sizeBytes || null,
      req.body.status, req.body.startedAt || null, req.body.completedAt || null, req.user.id, json(req.body.metadata)]
  );
  await audit(req, 'backup.metadata', 'backup', backupId, null, null, { status: req.body.status });
  ok(res, { id: backupId }, 201);
}));

app.get('/api/settings', centralOnly, asyncRoute(async (_req, res) => {
  const [rows] = await pool.query('SELECT setting_key,value,description,updated_at FROM settings ORDER BY setting_key');
  rows.forEach(row => { row.value = parseJson(row.value); });
  ok(res, rows);
}));
app.put('/api/settings/:key', centralOnly, [
  param('key').matches(/^[A-Za-z0-9_.-]{1,120}$/), body('value').exists(), validate
], asyncRoute(async (req, res) => {
  await pool.execute(
    `INSERT INTO settings(setting_key,value,description,updated_by) VALUES(?,?,?,?)
     ON DUPLICATE KEY UPDATE value=VALUES(value),description=VALUES(description),updated_by=VALUES(updated_by)`,
    [req.params.key, json(req.body.value), req.body.description || null, req.user.id]
  );
  await audit(req, 'setting.update', 'setting', req.params.key, null, null, req.body);
  ok(res, { key: req.params.key, updated: true });
}));

app.get('/api/audit', requirePermission('audit.read'), asyncRoute(async (req, res) => {
  const { limit, offset } = pageArgs(req);
  const patientId = req.query.patientId || null;
  if (patientId && !await hasScope(req.user, 'patient', patientId)) return fail(res, 403, 'SCOPE_DENIED', 'Patient scope denied');
  const [rows] = await pool.execute(
    `SELECT id,actor_id,action,entity_type,entity_id,patient_id,request_id,ip,created_at
     FROM audit_logs WHERE (? IS NULL OR patient_id=?) ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [patientId, patientId, limit, offset]
  );
  ok(res, rows, 200, { limit, offset });
}));

app.get('/api/reports/appointments.csv', requirePermission('reports.view'), asyncRoute(async (req, res) => {
  const from = String(req.query.from || new Date().toISOString().slice(0, 10));
  const to = String(req.query.to || from);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return fail(res, 422, 'INVALID_DATE', 'Use YYYY-MM-DD dates');
  const [rows] = await pool.execute(
    `SELECT a.appointment_no,p.medical_record_no,CONCAT(p.first_name,' ',p.last_name) patient,
     a.starts_at,a.status,d.name department FROM appointments a JOIN patients p ON p.id=a.patient_id
     LEFT JOIN departments d ON d.id=a.department_id WHERE a.starts_at>=? AND a.starts_at<DATE_ADD(?,INTERVAL 1 DAY)
     ORDER BY a.starts_at`, [from, to]
  );
  const csv = value => `"${String(value ?? '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
  const lines = [['Appointment No','MRN','Patient','Starts At','Status','Department'], ...rows.map(r =>
    [r.appointment_no,r.medical_record_no,r.patient,new Date(r.starts_at).toISOString(),r.status,r.department]
  )].map(row => row.map(csv).join(',')).join('\r\n');
  await audit(req, 'report.export', 'report', 'appointments');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="appointments-${from}-${to}.csv"`);
  res.send(`\uFEFF${lines}`);
}));

app.get('/api/reports/patients/:id/summary.pdf', requirePermission('reports.view'), param('id').isUUID(), validate,
  enforceScope('patient'), asyncRoute(async (req, res) => {
    const [[patients], [encounters], [records]] = await Promise.all([
      pool.execute('SELECT * FROM patients WHERE id=?', [req.params.id]).then(([r]) => r),
      pool.execute('SELECT encounter_no,type,status,started_at,ended_at FROM encounters WHERE patient_id=? ORDER BY started_at DESC LIMIT 20', [req.params.id]).then(([r]) => r),
      pool.execute(`SELECT type,title,authored_at FROM clinical_records WHERE patient_id=? ORDER BY authored_at DESC LIMIT 30`, [req.params.id]).then(([r]) => r)
    ]);
    if (!patients.length) return fail(res, 404, 'NOT_FOUND', 'Patient not found');
    const patient = patients[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="patient-summary-${patient.medical_record_no}.pdf"`);
    const pdf = new PDFDocument({ margin: 50, info: { Title: 'Patient Summary', Author: 'Splendour Advanced EHR' } });
    pdf.pipe(res);
    pdf.fontSize(20).text('Splendour Advanced EHR', { align: 'center' }).moveDown();
    pdf.fontSize(16).text('Patient Summary').moveDown();
    pdf.fontSize(11).text(`MRN: ${patient.medical_record_no}`);
    pdf.text(`Name: ${patient.first_name} ${patient.middle_name || ''} ${patient.last_name}`);
    pdf.text(`Date of birth: ${patient.date_of_birth || 'Not recorded'}`).moveDown();
    pdf.fontSize(14).text('Recent Encounters');
    encounters.forEach(e => pdf.fontSize(10).text(`${e.encounter_no} | ${e.type} | ${e.status} | ${new Date(e.started_at).toISOString()}`));
    pdf.moveDown().fontSize(14).text('Recent Clinical Entries');
    records.forEach(r => pdf.fontSize(10).text(`${r.type}: ${r.title} | ${new Date(r.authored_at).toISOString()}`));
    pdf.moveDown().fontSize(8).text(`Generated ${new Date().toISOString()} by ${req.user.display_name}`);
    pdf.end();
    await audit(req, 'report.export', 'patient_summary', req.params.id, req.params.id);
  }));

app.post('/api/patients/:id/cards', requirePermission('patients.write'), param('id').isUUID(), validate,
  enforceScope('patient'), asyncRoute(async (req, res) => {
    const [patients] = await pool.execute('SELECT * FROM patients WHERE id=?', [req.params.id]);
    if (!patients.length) return fail(res, 404, 'NOT_FOUND', 'Patient not found');
    const result = await transaction(async conn => {
      const cardId = id();
      const cardNo = await nextNumber(conn, 'patient_card', 'CARD-');
      await conn.execute(
        `INSERT INTO patient_cards(id,patient_id,card_no,issued_at,expires_at) VALUES(?,?,?,NOW(),?)`,
        [cardId, req.params.id, cardNo, req.body.expiresAt || null]
      );
      await audit(req, 'card.issue', 'patient_card', cardId, req.params.id, null, { cardNo }, conn);
      return { id: cardId, cardNo };
    });
    ok(res, result, 201);
  }));

app.get('/api/patient-cards/:id.pdf', requirePermission('patients.read'), param('id').isUUID(), validate,
  asyncRoute(async (req, res) => {
    const [rows] = await pool.execute(
      `SELECT c.*,p.medical_record_no,p.first_name,p.last_name,p.date_of_birth FROM patient_cards c
       JOIN patients p ON p.id=c.patient_id WHERE c.id=?`, [req.params.id]
    );
    if (!rows.length) return fail(res, 404, 'NOT_FOUND', 'Card not found');
    const card = rows[0];
    if (!await hasScope(req.user, 'patient', card.patient_id)) return fail(res, 403, 'SCOPE_DENIED', 'Patient scope denied');
    const qr = await QRCode.toDataURL(JSON.stringify({ cardNo: card.card_no, mrn: card.medical_record_no }), { errorCorrectionLevel: 'H' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${card.card_no}.pdf"`);
    const pdf = new PDFDocument({ size: [243, 153], margin: 12 });
    pdf.pipe(res);
    pdf.fontSize(11).text('SPLENDOUR ADVANCED EHR', 12, 12);
    pdf.fontSize(9).text(`${card.first_name} ${card.last_name}`, 12, 40);
    pdf.text(`MRN: ${card.medical_record_no}`, 12, 55);
    pdf.text(`Card: ${card.card_no}`, 12, 70);
    pdf.text(`DOB: ${card.date_of_birth || 'N/A'}`, 12, 85);
    pdf.image(Buffer.from(qr.split(',')[1], 'base64'), 166, 40, { width: 65 });
    pdf.end();
    await audit(req, 'card.print', 'patient_card', card.id, card.patient_id);
  }));

app.use((req, res) => fail(res, 404, 'ROUTE_NOT_FOUND', 'Route not found'));
app.use((error, req, res, _next) => {
  if (res.headersSent) return req.socket.destroy();
  const status = error.status || (error instanceof multer.MulterError ? 413 :
    error.code === 'ER_DUP_ENTRY' ? 409 : error.code === 'ER_NO_REFERENCED_ROW_2' ? 422 : 500);
  const code = error instanceof multer.MulterError ? 'UPLOAD_REJECTED' : error.code === 'ER_DUP_ENTRY' ? 'CONFLICT' :
    error.code === 'ER_NO_REFERENCED_ROW_2' ? 'INVALID_REFERENCE' : error.code || 'INTERNAL_ERROR';
  if (status >= 500) {
    console.error(`[${req.requestId}]`, error);
    if (pool) pool.execute(
      'INSERT INTO system_logs(level,component,message,metadata) VALUES(?,?,?,?)',
      ['error', 'http', String(error.message).slice(0, 5000), json({ requestId: req.requestId, path: req.path })]
    ).catch(() => {});
  }
  fail(res, status, code, status >= 500 ? 'An internal error occurred' : error.message);
});

function configureSockets(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: config.origins, credentials: true },
    maxHttpBufferSize: 100000, transports: ['websocket','polling']
  });
  io.use(async (socket, next) => {
    try {
      const cookieToken = String(socket.handshake.headers.cookie || '').split(';')
        .map(v => v.trim().split('=')).find(([key]) => key === 'access_token')?.[1];
      const token = socket.handshake.auth?.token || (cookieToken ? decodeURIComponent(cookieToken) : null);
      const payload = jwt.verify(token, config.jwtSecret, { issuer: 'splendour-ehr', audience: 'splendour-ehr-api' });
      socket.user = await loadPrincipal(payload.sub);
      if (!socket.user) throw new Error('User unavailable');
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });
  io.on('connection', socket => {
    socket.join(`user:${socket.user.id}`);
    for (const assignment of socket.user.assignments) {
      if (assignment.scope_type === 'department') socket.join(`department:${assignment.scope_id}`);
      if (assignment.scope_type === 'ward') socket.join(`ward:${assignment.scope_id}`);
      if (assignment.scope_type === 'patient') socket.join(`patient:${assignment.scope_id}`);
    }
    socket.on('join:patient', async (patientId, acknowledge = () => {}) => {
      if (typeof patientId !== 'string' || !await hasScope(socket.user, 'patient', patientId)) return acknowledge({ success: false });
      socket.join(`patient:${patientId}`);
      acknowledge({ success: true });
    });
    socket.on('join:conversation', async (conversationId, acknowledge = () => {}) => {
      const [rows] = await pool.execute(
        'SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?', [conversationId, socket.user.id]
      );
      if (!rows.length) return acknowledge({ success: false });
      socket.join(`conversation:${conversationId}`);
      acknowledge({ success: true });
    });
  });
  return io;
}

async function init() {
  await initializeDatabase();
  return { app, pool };
}

async function start() {
  await init();
  if (server) return server;
  server = http.createServer(app);
  configureSockets(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  console.log(`Splendour Advanced EHR API listening on ${config.host}:${config.port}`);
  return server;
}

async function stop() {
  if (io) await new Promise(resolve => io.close(resolve));
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (pool) await pool.end();
  io = null;
  server = null;
  pool = null;
  initialized = false;
}

if (require.main === module) {
  start().catch(error => {
    console.error('Unable to start Splendour Advanced EHR API:', error);
    process.exitCode = 1;
  });
}

module.exports = { app, init, start, stop, transaction, nextNumber, configureSockets, getPool: () => pool };
